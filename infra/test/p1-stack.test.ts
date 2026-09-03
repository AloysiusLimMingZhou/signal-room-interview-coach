/** @jest-environment node */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { P1Stack } from "../lib/p1-stack";

const templateCache = new Map<string, Template>();

function template(stageName = "test"): Template {
  const cached = templateCache.get(stageName);
  if (cached) return cached;
  const app = new cdk.App();
  const stack = new P1Stack(app, `SignalRoom-${stageName}`, {
    env: { account: "111111111111", region: "ap-southeast-1" },
    stageName,
    allowedOrigin: stageName === "prod" ? "https://interviews.example.com" : "http://localhost:3000",
  });
  const synthesized = Template.fromStack(stack);
  templateCache.set(stageName, synthesized);
  return synthesized;
}

describe("P1 infrastructure security and operations", () => {
  it("creates the serverless data, auth, queue, and private object boundaries", () => {
    const synthesized = template();
    synthesized.resourceCountIs("AWS::Cognito::UserPool", 1);
    synthesized.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    synthesized.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayWith(["openid", "email", "profile"]),
      CallbackURLs: ["http://localhost:3000/api/auth/callback"],
      LogoutURLs: ["http://localhost:3000/"],
      GenerateSecret: false,
    });
    synthesized.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
    synthesized.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }),
        ]),
      }),
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([Match.objectLike({
          ExpirationInDays: 30,
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          Prefix: "recordings/",
        })]),
      }),
    });
    synthesized.resourceCountIs("AWS::SQS::Queue", 2);
    synthesized.hasResourceProperties("AWS::SQS::Queue", { SqsManagedSseEnabled: true });
    synthesized.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });

  it("protects both API routes with Cognito JWT auth and explicit CORS", () => {
    const synthesized = template();
    synthesized.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    synthesized.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /v1/realtime/sessions",
      AuthorizationType: "JWT",
    });
    synthesized.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /v1/interview-events",
      AuthorizationType: "JWT",
    });
    synthesized.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ["http://localhost:3000"],
      }),
    });
    const APIs = synthesized.findResources("AWS::ApiGatewayV2::Api");
    expect(JSON.stringify(APIs)).not.toContain('"*"');
  });

  it("keeps secrets and interview content out of Lambda configuration and API logs", () => {
    const synthesized = template();
    const functions = synthesized.findResources("AWS::Lambda::Function");
    expect(Object.keys(functions)).toHaveLength(3);
    let secretAwareFunctions = 0;
    for (const resource of Object.values(functions)) {
      const serialized = JSON.stringify(resource);
      expect(serialized).not.toContain("GEMINI_API_KEY");
      expect(serialized).not.toContain("transcript");
      if (serialized.includes("GEMINI_SECRET_ARN")) secretAwareFunctions += 1;
      expect(resource.Properties.TracingConfig).toEqual({ Mode: "Active" });
    }
    expect(secretAwareFunctions).toBe(2);

    const stages = synthesized.findResources("AWS::ApiGatewayV2::Stage");
    const stage = Object.values(stages)[0];
    const format = String(stage.Properties.AccessLogSettings.Format);
    expect(() => JSON.parse(format)).not.toThrow();
    expect(format).not.toMatch(/header|body|payload|token|transcript|audio|code|canvas/i);
    expect(stage.Properties.DefaultRouteSettings).toMatchObject({
      DetailedMetricsEnabled: true,
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    });
  });

  it("sets explicit retention, dashboards, alarms, and production recovery controls", () => {
    const development = template();
    const devLogs = development.findResources("AWS::Logs::LogGroup");
    for (const log of Object.values(devLogs)) expect(log.Properties.RetentionInDays).toBe(7);
    development.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    development.resourceCountIs("AWS::CloudWatch::Alarm", 13);

    const production = template("prod");
    production.hasResourceProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    const prodLogs = production.findResources("AWS::Logs::LogGroup");
    for (const log of Object.values(prodLogs)) expect(log.Properties.RetentionInDays).toBe(30);
    production.resourceCountIs("AWS::Lambda::Version", 3);
    production.resourceCountIs("AWS::Lambda::Alias", 3);
    production.resourceCountIs("AWS::CodeDeploy::DeploymentGroup", 3);
    production.resourceCountIs("AWS::CloudWatch::Alarm", 16);
    production.hasResourceProperties("AWS::CodeDeploy::DeploymentGroup", {
      AutoRollbackConfiguration: {
        Enabled: true,
        Events: Match.arrayWith(["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_REQUEST", "DEPLOYMENT_STOP_ON_ALARM"]),
      },
      DeploymentConfigName: "CodeDeployDefault.LambdaCanary10Percent5Minutes",
    });
  });

  it("uses scoped table and secret policies without wildcard data-plane actions", () => {
    const synthesized = template();
    const policies = synthesized.findResources("AWS::IAM::Policy");
    const serialized = JSON.stringify(policies);
    expect(serialized).not.toMatch(/dynamodb:\*/);
    expect(serialized).not.toMatch(/secretsmanager:\*/);
    expect(serialized).not.toContain('"Action":"*"');
    expect(serialized).toContain("dynamodb:TransactWriteItems");
    expect(serialized).toContain("secretsmanager:GetSecretValue");
  });
});
