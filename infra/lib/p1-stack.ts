import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  allowanceEnvironment,
  DEFAULT_ALLOWANCE_LIMITS,
  HARD_LIMITS,
  validateAllowanceLimits,
  type AllowanceLimits,
} from "./access-policy";
import { addProductionObservability } from "./observability";
import { isProductionStage } from "./p1-config";
import { TEXT_HARD_LIMITS, textLimitEnvironment, validateTextLimits, type TextLimits } from "./text-limits";

export interface P1StackProps extends StackProps {
  stageName: string;
  allowedOrigin: string;
  allowances?: AllowanceLimits;
  voiceSessionMinutes?: number;
  textLimits?: TextLimits;
  alertEmail?: string;
}

interface FunctionResources {
  readonly fn: lambdaNodejs.NodejsFunction;
  readonly role: iam.Role;
}

type TableAction =
  | "dynamodb:GetItem"
  | "dynamodb:PutItem"
  | "dynamodb:UpdateItem"
  | "dynamodb:DeleteItem"
  | "dynamodb:Query";

const METRIC_NAMESPACE = "SignalRoom/P1";
const COGNITO_GROUPS = [
  { name: "owner", precedence: 0, description: "Project owner: full voice and text allowance" },
  { name: "guest", precedence: 10, description: "Invited guest: small voice and text allowance" },
] as const;
export const GRADING_MAX_RECEIVE_COUNT = 3;

export class P1Stack extends Stack {
  constructor(scope: Construct, id: string, props: P1StackProps) {
    super(scope, id, props);

    const isProduction = isProductionStage(props.stageName);
    const retention = isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;
    const removalPolicy = isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const allowances = validateAllowanceLimits(props.allowances ?? DEFAULT_ALLOWANCE_LIMITS);
    const voiceSessionMinutes = props.voiceSessionMinutes ?? HARD_LIMITS.voiceSessionMinutes;
    const textLimits = validateTextLimits(props.textLimits ?? TEXT_HARD_LIMITS);

    if (props.allowedOrigin === "*") throw new Error("allowedOrigin must be explicit.");
    if (voiceSessionMinutes > HARD_LIMITS.voiceSessionMinutes) {
      throw new Error("Voice sessions cannot exceed the ten-minute hard cap.");
    }
    if (isProduction && !props.alertEmail) throw new Error("Production requires an alert email.");

    Tags.of(this).add("Application", "SignalRoom");
    Tags.of(this).add("Environment", props.stageName);
    Tags.of(this).add("ManagedBy", "AWS-CDK");

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `signal-room-${props.stageName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: Duration.days(3),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });
    for (const group of COGNITO_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `${group.name}Group`, {
        userPoolId: userPool.userPoolId,
        groupName: group.name,
        precedence: group.precedence,
        description: group.description,
      });
    }
    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `signal-room-web-${props.stageName}`,
      generateSecret: false,
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${props.allowedOrigin}/api/auth/callback`],
        logoutUrls: [`${props.allowedOrigin}/`],
      },
    });
    const userPoolDomain = userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix: `signal-room-${props.stageName}-${this.account}` },
    });

    const table = new dynamodb.Table(this, "InterviewTable", {
      tableName: `signal-room-${props.stageName}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProduction },
      deletionProtection: isProduction,
      removalPolicy,
    });

    const gradingDlq = new sqs.Queue(this, "GradingDlq", {
      queueName: `signal-room-grading-dlq-${props.stageName}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy,
    });
    const gradingQueue = new sqs.Queue(this, "GradingQueue", {
      queueName: `signal-room-grading-${props.stageName}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(2),
      deadLetterQueue: { queue: gradingDlq, maxReceiveCount: GRADING_MAX_RECEIVE_COUNT },
      removalPolicy,
    });

    // Created manually once per stage (CloudFormation cannot create SecureString values).
    const geminiKeyParameterName = `/signal-room/${props.stageName}/gemini-api-key`;
    const baseEnvironment = {
      TABLE_NAME: table.tableName,
      ENVIRONMENT: props.stageName,
      LOG_NAMESPACE: METRIC_NAMESPACE,
    };

    const sessionFunction = this.createFunction("Session", props.stageName, retention, {
      entry: this.lambdaEntry("session-handler.ts"),
      timeout: Duration.seconds(15),
      memorySize: 512,
      reservedConcurrency: 5,
      environment: {
        ...baseEnvironment,
        ...allowanceEnvironment(allowances),
        ...textLimitEnvironment(textLimits),
        GEMINI_KEY_PARAMETER_NAME: geminiKeyParameterName,
        GEMINI_LIVE_MODEL: "gemini-3.1-flash-live-preview",
        GEMINI_TEXT_MODEL: "gemini-2.5-flash-lite",
        VOICE_SESSION_MINUTES: String(voiceSessionMinutes),
      },
    });
    const eventFunction = this.createFunction("Event", props.stageName, retention, {
      entry: this.lambdaEntry("event-handler.ts"),
      timeout: Duration.seconds(15),
      memorySize: 512,
      reservedConcurrency: 10,
      environment: {
        ...baseEnvironment,
        GRADING_QUEUE_URL: gradingQueue.queueUrl,
        MAX_SESSION_EVENTS: "500",
        SESSION_APPEND_GRACE_SECONDS: "120",
      },
    });
    const graderFunction = this.createFunction("Grader", props.stageName, retention, {
      entry: this.lambdaEntry("grading-handler.ts"),
      timeout: Duration.seconds(60),
      memorySize: 1_024,
      reservedConcurrency: 2,
      environment: {
        ...baseEnvironment,
        GEMINI_KEY_PARAMETER_NAME: geminiKeyParameterName,
        GEMINI_GRADER_MODEL: "gemini-2.5-flash-lite",
        GRADING_MAX_RECEIVE_COUNT: String(GRADING_MAX_RECEIVE_COUNT),
      },
    });
    const accountFunction = this.createFunction("Account", props.stageName, retention, {
      entry: this.lambdaEntry("account-handler.ts"),
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrency: 5,
      environment: { ...baseEnvironment, ...allowanceEnvironment(allowances) },
    });
    const turnFunction = this.createFunction("Turn", props.stageName, retention, {
      entry: this.lambdaEntry("turn-handler.ts"),
      timeout: Duration.seconds(20), // Must remain shorter than the 30-second paid-call lease.
      memorySize: 512,
      reservedConcurrency: 2,
      environment: { ...baseEnvironment, ...textLimitEnvironment(textLimits), GEMINI_KEY_PARAMETER_NAME: geminiKeyParameterName },
    });

    // DynamoDB authorizes transactions by their underlying item actions.
    this.grantTableActions(sessionFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]);
    this.grantTableActions(eventFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]);
    this.grantTableActions(graderFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]);
    this.grantTableActions(accountFunction.role, table, ["dynamodb:GetItem", "dynamodb:Query"]);
    this.grantTableActions(turnFunction.role, table, ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    this.grantGeminiKeyRead(sessionFunction.role, geminiKeyParameterName);
    this.grantGeminiKeyRead(graderFunction.role, geminiKeyParameterName);
    this.grantGeminiKeyRead(turnFunction.role, geminiKeyParameterName);
    gradingQueue.grantSendMessages(eventFunction.role);
    gradingQueue.grantConsumeMessages(graderFunction.role);
    graderFunction.fn.addEventSource(new lambdaEventSources.SqsEventSource(gradingQueue, {
      batchSize: 5,
      maxBatchingWindow: Duration.seconds(5),
      reportBatchItemFailures: true,
    }));

    const api = this.createApi({
      stageName: props.stageName,
      allowedOrigin: props.allowedOrigin,
      retention,
      removalPolicy,
      userPool,
      userPoolClient,
      sessionFunction: sessionFunction.fn,
      eventFunction: eventFunction.fn,
      accountFunction: accountFunction.fn,
      turnFunction: turnFunction.fn,
    });

    if (isProduction && props.alertEmail) {
      const dashboard = addProductionObservability(this, {
        stageName: props.stageName,
        api,
        functions: [sessionFunction.fn, eventFunction.fn, graderFunction.fn, accountFunction.fn, turnFunction.fn],
        gradingDlq,
        metricNamespace: METRIC_NAMESPACE,
        alertEmail: props.alertEmail,
      });
      new CfnOutput(this, "DashboardName", { value: dashboard.dashboardName });
    }

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: userPoolDomain.baseUrl() });
    new CfnOutput(this, "GeminiKeyParameterName", { value: geminiKeyParameterName });
  }

  private createApi(input: {
    stageName: string;
    allowedOrigin: string;
    retention: logs.RetentionDays;
    removalPolicy: RemovalPolicy;
    userPool: cognito.UserPool;
    userPoolClient: cognito.UserPoolClient;
    sessionFunction: lambda.IFunction;
    eventFunction: lambda.IFunction;
    accountFunction: lambda.IFunction;
    turnFunction: lambda.IFunction;
  }): apigwv2.HttpApi {
    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
      logGroupName: `/aws/apigateway/signal-room-${input.stageName}`,
      retention: input.retention,
      removalPolicy: input.removalPolicy,
    });
    accessLogs.grantWrite(new iam.ServicePrincipal("apigateway.amazonaws.com"));

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `signal-room-${input.stageName}`,
      description: "Authenticated interview state, account, and Gemini session API",
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: [input.allowedOrigin],
        allowHeaders: ["authorization", "content-type", "idempotency-key"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        maxAge: Duration.hours(1),
      },
    });
    const authorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwt",
      `https://cognito-idp.${this.region}.amazonaws.com/${input.userPool.userPoolId}`,
      { jwtAudience: [input.userPoolClient.userPoolClientId] },
    );
    const accountIntegration = new integrations.HttpLambdaIntegration("AccountIntegration", input.accountFunction);
    const routes: Array<[string, apigwv2.HttpMethod, apigwv2.HttpRouteIntegration]> = [
      ["/v1/realtime/sessions", apigwv2.HttpMethod.POST, new integrations.HttpLambdaIntegration("SessionIntegration", input.sessionFunction)],
      ["/v1/interview-events", apigwv2.HttpMethod.POST, new integrations.HttpLambdaIntegration("EventIntegration", input.eventFunction)],
      ["/v1/sessions/{sessionId}/turn", apigwv2.HttpMethod.POST, new integrations.HttpLambdaIntegration("TurnIntegration", input.turnFunction)],
      ["/v1/me", apigwv2.HttpMethod.GET, accountIntegration],
      ["/v1/sessions", apigwv2.HttpMethod.GET, accountIntegration],
      ["/v1/sessions/{sessionId}/report", apigwv2.HttpMethod.GET, accountIntegration],
    ];
    for (const [routePath, method, integration] of routes) {
      api.addRoutes({ path: routePath, methods: [method], authorizer, integration });
    }

    const defaultStage = api.defaultStage;
    if (!defaultStage) throw new Error("The HTTP API default stage was not created.");
    const cfnStage = defaultStage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status",
        integrationStatus: "$context.integration.status",
        integrationLatencyMs: "$context.integrationLatency",
        responseBytes: "$context.responseLength",
        authStatus: "$context.authorizer.status",
      }),
    };
    cfnStage.defaultRouteSettings = {
      detailedMetricsEnabled: true,
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };
    cfnStage.node.addDependency(accessLogs);
    return api;
  }

  private lambdaEntry(fileName: string): string {
    const compiled = __dirname.split(path.sep).includes("dist");
    const infraRoot = path.resolve(__dirname, compiled ? "../.." : "..");
    return path.join(infraRoot, "lambda", fileName);
  }

  private createFunction(
    purpose: string,
    stageName: string,
    retention: logs.RetentionDays,
    options: {
      entry: string;
      timeout: Duration;
      memorySize: number;
      reservedConcurrency: number;
      environment: Record<string, string>;
    },
  ): FunctionResources {
    const functionName = `signal-room-${purpose.toLowerCase()}-${stageName}`;
    const logGroup = new logs.LogGroup(this, `${purpose}Logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention,
      removalPolicy: isProductionStage(stageName) ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, `${purpose}Role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Least-privilege execution role for the ${purpose.toLowerCase()} Lambda`,
    });
    logGroup.grantWrite(role);
    const fn = new lambdaNodejs.NodejsFunction(this, `${purpose}Function`, {
      functionName,
      entry: options.entry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: options.memorySize,
      timeout: options.timeout,
      reservedConcurrentExecutions: options.reservedConcurrency,
      tracing: lambda.Tracing.ACTIVE,
      role,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
      environment: options.environment,
      depsLockFilePath: path.resolve(this.lambdaEntry(".."), "..", "pnpm-lock.yaml"),
      projectRoot: path.resolve(this.lambdaEntry(".."), ".."),
      bundling: {
        target: "node22",
        minify: true,
        sourceMap: false,
        sourcesContent: false,
        externalModules: [],
      },
    });
    fn.node.addDependency(logGroup);
    return { fn, role };
  }

  private grantTableActions(role: iam.Role, table: dynamodb.Table, actions: TableAction[]): void {
    role.addToPolicy(new iam.PolicyStatement({
      sid: "InterviewTableAccess",
      actions,
      resources: [table.tableArn],
    }));
  }

  private grantGeminiKeyRead(role: iam.Role, parameterName: string): void {
    role.addToPolicy(new iam.PolicyStatement({
      sid: "GeminiKeyParameterRead",
      actions: ["ssm:GetParameter"],
      resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: parameterName.slice(1) })],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: "GeminiKeyDecryptViaSsm",
      actions: ["kms:Decrypt"],
      resources: [this.formatArn({ service: "kms", resource: "key", resourceName: "*" })],
      conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
    }));
  }
}
