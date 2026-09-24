/** @jest-environment node */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { GRADING_MAX_RECEIVE_COUNT, P1Stack } from "../lib/p1-stack";

const templateCache = new Map<string, Template>();

function template(stageName = "test"): Template {
  const cached = templateCache.get(stageName);
  if (cached) return cached;
  const app = new cdk.App();
  const isProd = stageName === "prod";
  const stack = new P1Stack(app, `SignalRoom-${stageName}`, {
    env: { account: "111111111111", region: "ap-southeast-1" },
    stageName,
    allowedOrigin: isProd ? "https://interviews.example.com" : "http://localhost:3000",
    ...(isProd ? { alertEmail: "alerts@example.com" } : {}),
  });
  const synthesized = Template.fromStack(stack);
  templateCache.set(stageName, synthesized);
  return synthesized;
}

function alarmMetricCount(synthesized: Template): number {
  return Object.values(synthesized.findResources("AWS::CloudWatch::Alarm")).reduce((total, alarm) => {
    const metrics = alarm.Properties.Metrics as Array<{ MetricStat?: unknown }> | undefined;
    return total + (metrics ? metrics.filter((metric) => metric.MetricStat).length : 1);
  }, 0);
}

describe("lean P1 infrastructure", () => {
  it("creates invite-only auth with owner and guest groups", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
    synthesized.resourceCountIs("AWS::Cognito::UserPoolGroup", 2);
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "owner", Precedence: 0 });
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "guest", Precedence: 10 });
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      CallbackURLs: ["http://localhost:3000/api/auth/callback"],
      GenerateSecret: false,
    });
  });

  it("removes resources that cost money or are unused", () => {
    const synthesized = template("prod");
    for (const type of [
      "AWS::SecretsManager::Secret",
      "AWS::S3::Bucket",
      "AWS::CodeDeploy::DeploymentGroup",
      "AWS::CodeDeploy::Application",
      "AWS::Lambda::Alias",
    ]) {
      synthesized.resourceCountIs(type, 0);
    }
  });

  it("protects every route with the Cognito JWT authorizer", () => {
    const synthesized = template();
    const routeKeys = [
      "POST /v1/realtime/sessions",
      "POST /v1/interview-events",
      "GET /v1/me",
      "GET /v1/sessions",
      "GET /v1/sessions/{sessionId}/report",
    ];
    synthesized.resourceCountIs("AWS::ApiGatewayV2::Route", routeKeys.length);
    for (const routeKey of routeKeys) {
      synthesized.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: routeKey, AuthorizationType: "JWT" });
    }
    synthesized.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: {
        AllowOrigins: ["http://localhost:3000"],
        AllowMethods: ["GET", "POST", "OPTIONS"],
        AllowHeaders: ["authorization", "content-type", "idempotency-key"],
        MaxAge: 3600,
      },
    });
  });

  it("keeps secrets and interview content out of Lambda configuration and API logs", () => {
    const synthesized = template();
    const functions = synthesized.findResources("AWS::Lambda::Function");
    expect(Object.keys(functions)).toHaveLength(4);
    let keyAwareFunctions = 0;
    for (const resource of Object.values(functions)) {
      const serialized = JSON.stringify(resource);
      expect(serialized).not.toContain("GEMINI_API_KEY");
      expect(serialized).not.toContain("transcript");
      if (serialized.includes("GEMINI_KEY_PARAMETER_NAME")) keyAwareFunctions += 1;
      expect(resource.Properties.TracingConfig).toEqual({ Mode: "Active" });
    }
    expect(keyAwareFunctions).toBe(2);

    const stage = Object.values(synthesized.findResources("AWS::ApiGatewayV2::Stage"))[0];
    const format = String(stage.Properties.AccessLogSettings.Format);
    expect(format).not.toMatch(/header|body|payload|token|transcript|audio|code|canvas/i);
  });

  it("grants the item actions DynamoDB transactions require, scoped to one table and one parameter", () => {
    const serialized = JSON.stringify(template().findResources("AWS::IAM::Policy"));
    expect(serialized).not.toMatch(/dynamodb:\*|ssm:\*|"Action":"\*"/);
    expect(serialized).not.toContain("dynamodb:TransactWriteItems");
    expect(serialized).not.toContain("secretsmanager:");
    for (const action of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]) {
      expect(serialized).toContain(action);
    }
    expect(serialized).toContain("parameter/signal-room/test/gemini-api-key");
    expect(serialized).toContain("ssm.ap-southeast-1.amazonaws.com");
  });

  it("scopes every data grant and keeps the account Lambda read-only", () => {
    const synthesized = template();
    const functions = synthesized.findResources("AWS::Lambda::Function");
    const account = Object.values(functions).find((fn) => fn.Properties.FunctionName === "signal-room-account-test")!;
    const accountRole = account.Properties.Role["Fn::GetAtt"][0];
    const policies = Object.values(synthesized.findResources("AWS::IAM::Policy"));
    const accountPolicy = policies.find((policy) => policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === accountRole))!;
    const grants = accountPolicy.Properties.PolicyDocument.Statement;
    const tableGrant = grants.find((grant: { Sid?: string }) => grant.Sid === "InterviewTableAccess");
    expect(tableGrant.Action).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(JSON.stringify(tableGrant.Resource)).toContain("InterviewTable");
    expect(JSON.stringify(grants)).not.toMatch(/ssm:|kms:/);

    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const parameterGrants = statements.filter((grant) => grant.Sid === "GeminiKeyParameterRead");
    expect(parameterGrants).toHaveLength(2);
    for (const grant of parameterGrants) {
      expect(grant.Action).toBe("ssm:GetParameter");
      expect(JSON.stringify(grant.Resource)).toContain("parameter/signal-room/test/gemini-api-key");
      expect(JSON.stringify(grant.Resource)).not.toContain("*");
    }
    const decryptGrants = statements.filter((grant) => grant.Sid === "GeminiKeyDecryptViaSsm");
    expect(decryptGrants).toHaveLength(2);
    for (const grant of decryptGrants) {
      expect(grant.Action).toBe("kms:Decrypt");
      expect(grant.Condition).toEqual({ StringEquals: { "kms:ViaService": "ssm.ap-southeast-1.amazonaws.com" } });
    }
  });

  it("wires the grader's redrive limit to its failure detection", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: GRADING_MAX_RECEIVE_COUNT }),
    });
    expect(JSON.stringify(synthesized.findResources("AWS::Lambda::Function"))).toContain(
      `"GRADING_MAX_RECEIVE_COUNT":"${GRADING_MAX_RECEIVE_COUNT}"`,
    );
  });

  it("creates no alarms, dashboards, or budgets outside production", () => {
    const development = template("dev");
    development.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    development.resourceCountIs("AWS::CloudWatch::Dashboard", 0);
    development.resourceCountIs("AWS::Budgets::Budget", 0);
    for (const log of Object.values(development.findResources("AWS::Logs::LogGroup"))) {
      expect(log.Properties.RetentionInDays).toBe(7);
    }
  });

  it("keeps production monitoring inside the CloudWatch free tier and notifies by email", () => {
    const production = template("prod");
    production.resourceCountIs("AWS::CloudWatch::Alarm", 8);
    expect(alarmMetricCount(production)).toBeLessThanOrEqual(10);
    production.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    production.resourceCountIs("AWS::Budgets::Budget", 1);
    production.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "alerts@example.com" });
    for (const alarm of Object.values(production.findResources("AWS::CloudWatch::Alarm"))) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(alarm.Properties.Metrics).toBeUndefined();
      expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperationsAlerts");
    }
    production.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 1, Unit: "USD" }, TimeUnit: "MONTHLY" }),
      NotificationsWithSubscribers: [
        { Notification: { NotificationType: "FORECASTED", ComparisonOperator: "GREATER_THAN", Threshold: 80, ThresholdType: "PERCENTAGE" }, Subscribers: [{ SubscriptionType: "EMAIL", Address: "alerts@example.com" }] },
        { Notification: { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 100, ThresholdType: "PERCENTAGE" }, Subscribers: [{ SubscriptionType: "EMAIL", Address: "alerts@example.com" }] },
      ],
    });
    production.hasResourceProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    for (const log of Object.values(production.findResources("AWS::Logs::LogGroup"))) {
      expect(log.Properties.RetentionInDays).toBe(30);
    }
  });

  it("refuses a production stack without an alert email", () => {
    expect(() => new P1Stack(new cdk.App(), "SignalRoom-prod-missing-email", {
      env: { account: "111111111111", region: "ap-southeast-1" },
      stageName: "prod",
      allowedOrigin: "https://interviews.example.com",
    })).toThrow(/alert email/);
  });
});
