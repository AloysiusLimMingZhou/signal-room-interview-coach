import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

export interface P1StackProps extends StackProps {
  stageName: string;
  allowedOrigin: string;
  globalMonthlyInterviewLimit?: number;
  userMonthlyInterviewLimit?: number;
  sessionDurationMinutes?: number;
  geminiSecretArn?: string;
}

interface FunctionResources {
  readonly fn: lambdaNodejs.NodejsFunction;
  readonly invokable: lambda.IFunction;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;
}

const METRIC_NAMESPACE = "SignalRoom/P1";

export class P1Stack extends Stack {
  constructor(scope: Construct, id: string, props: P1StackProps) {
    super(scope, id, props);

    const isProduction = props.stageName === "prod" || props.stageName === "production";
    const retention = isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;
    const environmentDimension = isProduction
      ? "production"
      : props.stageName === "stage" || props.stageName === "staging"
        ? "staging"
        : "development";
    const globalMonthlyInterviewLimit = props.globalMonthlyInterviewLimit ?? 10;
    const userMonthlyInterviewLimit = props.userMonthlyInterviewLimit ?? 10;
    const sessionDurationMinutes = props.sessionDurationMinutes ?? 10;

    if (props.allowedOrigin === "*") throw new Error("allowedOrigin must be explicit.");
    if (globalMonthlyInterviewLimit > 10) throw new Error("The global pilot cap cannot exceed ten sessions.");
    if (userMonthlyInterviewLimit > globalMonthlyInterviewLimit) {
      throw new Error("The per-user limit cannot exceed the global pilot cap.");
    }
    if (sessionDurationMinutes > 10) throw new Error("The P1 pilot supports at most ten-minute sessions.");

    Tags.of(this).add("Application", "SignalRoom");
    Tags.of(this).add("Environment", props.stageName);
    Tags.of(this).add("ManagedBy", "AWS-CDK");

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `signal-room-${props.stageName}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
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
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
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
      cognitoDomain: {
        domainPrefix: `signal-room-${props.stageName}-${this.account}`,
      },
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
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const artifacts = new s3.Bucket(this, "Artifacts", {
      bucketName: undefined,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: isProduction,
      lifecycleRules: [
        {
          id: "DeleteOptInRecordingsAfter30Days",
          enabled: true,
          prefix: "recordings/",
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const gradingDlq = new sqs.Queue(this, "GradingDlq", {
      queueName: `signal-room-grading-dlq-${props.stageName}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const gradingQueue = new sqs.Queue(this, "GradingQueue", {
      queueName: `signal-room-grading-${props.stageName}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(2),
      deadLetterQueue: { queue: gradingDlq, maxReceiveCount: 3 },
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const geminiSecret = props.geminiSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, "GeminiSecret", props.geminiSecretArn)
      : new secretsmanager.Secret(this, "GeminiSecret", {
          secretName: `/signal-room/${props.stageName}/gemini-api-key`,
          description: "Replace this generated placeholder with the Gemini API key after deployment.",
          generateSecretString: {
            passwordLength: 40,
            excludePunctuation: true,
          },
          removalPolicy: RemovalPolicy.RETAIN,
        });

    const sessionFunction = this.createFunction("Session", props.stageName, retention, {
      entry: this.lambdaEntry("session-handler.ts"),
      timeout: Duration.seconds(15),
      memorySize: 512,
      reservedConcurrency: 5,
      environment: {
        TABLE_NAME: table.tableName,
        GEMINI_SECRET_ARN: geminiSecret.secretArn,
        GEMINI_LIVE_MODEL: "gemini-3.1-flash-live-preview",
        GLOBAL_MONTHLY_INTERVIEW_LIMIT: String(globalMonthlyInterviewLimit),
        USER_MONTHLY_INTERVIEW_LIMIT: String(userMonthlyInterviewLimit),
        SESSION_DURATION_MINUTES: String(sessionDurationMinutes),
        ENVIRONMENT: props.stageName,
        LOG_NAMESPACE: METRIC_NAMESPACE,
      },
    });
    const eventFunction = this.createFunction("Event", props.stageName, retention, {
      entry: this.lambdaEntry("event-handler.ts"),
      timeout: Duration.seconds(15),
      memorySize: 512,
      reservedConcurrency: 10,
      environment: {
        TABLE_NAME: table.tableName,
        GRADING_QUEUE_URL: gradingQueue.queueUrl,
        MAX_SESSION_EVENTS: "500",
        SESSION_APPEND_GRACE_SECONDS: "120",
        ENVIRONMENT: props.stageName,
        LOG_NAMESPACE: METRIC_NAMESPACE,
      },
    });
    const graderFunction = this.createFunction("Grader", props.stageName, retention, {
      entry: this.lambdaEntry("grading-handler.ts"),
      timeout: Duration.seconds(60),
      memorySize: 1_024,
      reservedConcurrency: 2,
      environment: {
        TABLE_NAME: table.tableName,
        GEMINI_SECRET_ARN: geminiSecret.secretArn,
        GEMINI_GRADER_MODEL: "gemini-2.5-flash-lite",
        ENVIRONMENT: props.stageName,
        LOG_NAMESPACE: METRIC_NAMESPACE,
      },
    });

    this.grantTableActions(sessionFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:TransactWriteItems",
    ]);
    this.grantTableActions(eventFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]);
    this.grantTableActions(graderFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]);
    geminiSecret.grantRead(sessionFunction.role);
    geminiSecret.grantRead(graderFunction.role);
    gradingQueue.grantSendMessages(eventFunction.role);
    gradingQueue.grantConsumeMessages(graderFunction.role);
    graderFunction.invokable.addEventSource(new lambdaEventSources.SqsEventSource(gradingQueue, {
      batchSize: 5,
      maxBatchingWindow: Duration.seconds(5),
      reportBatchItemFailures: true,
    }));

    const apiAccessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
      logGroupName: `/aws/apigateway/signal-room-${props.stageName}`,
      retention,
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    apiAccessLogs.grantWrite(new iam.ServicePrincipal("apigateway.amazonaws.com"));

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `signal-room-${props.stageName}`,
      description: "Authenticated P1 interview state and Gemini session API",
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: [props.allowedOrigin],
        allowHeaders: ["authorization", "content-type", "idempotency-key"],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        maxAge: Duration.hours(1),
      },
    });
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwt",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    api.addRoutes({
      path: "/v1/realtime/sessions",
      methods: [apigwv2.HttpMethod.POST],
      authorizer: jwtAuthorizer,
      integration: new integrations.HttpLambdaIntegration("SessionIntegration", sessionFunction.invokable),
    });
    api.addRoutes({
      path: "/v1/interview-events",
      methods: [apigwv2.HttpMethod.POST],
      authorizer: jwtAuthorizer,
      integration: new integrations.HttpLambdaIntegration("EventIntegration", eventFunction.invokable),
    });

    const defaultStage = api.defaultStage;
    if (!defaultStage) throw new Error("The HTTP API default stage was not created.");
    const cfnStage = defaultStage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: apiAccessLogs.logGroupArn,
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
    cfnStage.node.addDependency(apiAccessLogs);

    const dashboard = new cloudwatch.Dashboard(this, "OperationsDashboard", {
      dashboardName: `signal-room-${props.stageName}`,
      defaultInterval: Duration.hours(3),
    });
    this.addObservability({
      api,
      stageName: "$default",
      table,
      gradingQueue,
      gradingDlq,
      functions: [sessionFunction.fn, eventFunction.fn, graderFunction.fn],
      dashboard,
      environmentDimension,
    });

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: userPoolDomain.baseUrl() });
    new CfnOutput(this, "ArtifactsBucketName", { value: artifacts.bucketName });
    new CfnOutput(this, "GeminiSecretArn", { value: geminiSecret.secretArn });
    new CfnOutput(this, "DashboardName", { value: dashboard.dashboardName });
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
    const id = `${purpose}Function`;
    const functionName = `signal-room-${purpose.toLowerCase()}-${stageName}`;
    const logGroup = new logs.LogGroup(this, `${purpose}Logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention,
      removalPolicy: stageName === "prod" || stageName === "production"
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, `${purpose}Role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Least-privilege execution role for the ${purpose.toLowerCase()} Lambda`,
    });
    logGroup.grantWrite(role);
    const fn = new lambdaNodejs.NodejsFunction(this, id, {
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

    const isProduction = stageName === "prod" || stageName === "production";
    if (!isProduction) return { fn, invokable: fn, role, logGroup };

    const liveAlias = new lambda.Alias(this, `${purpose}LiveAlias`, {
      aliasName: "live",
      version: fn.currentVersion,
    });
    const canaryErrors = new cloudwatch.Alarm(this, `${purpose}CanaryErrorsAlarm`, {
      metric: liveAlias.metricErrors({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new codedeploy.LambdaDeploymentGroup(this, `${purpose}CanaryDeployment`, {
      alias: liveAlias,
      deploymentGroupName: `signal-room-${purpose.toLowerCase()}-${stageName}`,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [canaryErrors],
      autoRollback: {
        deploymentInAlarm: true,
        failedDeployment: true,
        stoppedDeployment: true,
      },
    });
    return { fn, invokable: liveAlias, role, logGroup };
  }

  private grantTableActions(role: iam.Role, table: dynamodb.Table, actions: string[]): void {
    role.addToPolicy(new iam.PolicyStatement({
      sid: "InterviewTableAccess",
      actions,
      resources: [table.tableArn],
    }));
  }

  private addObservability(input: {
    api: apigwv2.HttpApi;
    stageName: string;
    table: dynamodb.Table;
    gradingQueue: sqs.Queue;
    gradingDlq: sqs.Queue;
    functions: lambda.Function[];
    dashboard: cloudwatch.Dashboard;
    environmentDimension: string;
  }): void {
    const period = Duration.minutes(1);
    const apiDimensions = { ApiId: input.api.apiId, Stage: input.stageName };
    const apiRequests = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      dimensionsMap: apiDimensions,
      statistic: "Sum",
      period,
    });
    const api5xx = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "5xx",
      dimensionsMap: apiDimensions,
      statistic: "Sum",
      period,
    });
    const apiLatency = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "IntegrationLatency",
      dimensionsMap: apiDimensions,
      statistic: "p95",
      period,
    });
    const apiErrorPercent = new cloudwatch.MathExpression({
      expression: "IF(requests > 0, 100 * errors / requests, 0)",
      usingMetrics: { requests: apiRequests, errors: api5xx },
      period,
      label: "API 5xx %",
    });
    new cloudwatch.Alarm(this, "ApiServerErrorAlarm", {
      metric: apiErrorPercent,
      threshold: 1,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "ApiLatencyAlarm", {
      metric: apiLatency,
      threshold: 1_000,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const sessionSetup = new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: "session_setup_ms",
      dimensionsMap: { Environment: input.environmentDimension, Provider: "application" },
      statistic: "p95",
      period,
    });
    new cloudwatch.Alarm(this, "SessionSetupAlarm", {
      metric: sessionSetup,
      threshold: 3_000,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    for (const fn of input.functions) {
      new cloudwatch.Alarm(this, `${fn.node.id}ErrorsAlarm`, {
        metric: fn.metricErrors({ period }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      new cloudwatch.Alarm(this, `${fn.node.id}ThrottlesAlarm`, {
        metric: fn.metricThrottles({ period }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    const tableDimensions = { TableName: input.table.tableName };
    const readThrottles = new cloudwatch.Metric({
      namespace: "AWS/DynamoDB",
      metricName: "ReadThrottleEvents",
      dimensionsMap: tableDimensions,
      statistic: "Sum",
      period,
    });
    const writeThrottles = new cloudwatch.Metric({
      namespace: "AWS/DynamoDB",
      metricName: "WriteThrottleEvents",
      dimensionsMap: tableDimensions,
      statistic: "Sum",
      period,
    });
    const tableThrottles = new cloudwatch.MathExpression({
      expression: "reads + writes",
      usingMetrics: { reads: readThrottles, writes: writeThrottles },
      period,
      label: "DynamoDB throttles",
    });
    new cloudwatch.Alarm(this, "DynamoThrottleAlarm", {
      metric: tableThrottles,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const tableSystemErrors = new cloudwatch.Metric({
      namespace: "AWS/DynamoDB",
      metricName: "SystemErrors",
      dimensionsMap: tableDimensions,
      statistic: "Sum",
      period,
    });
    new cloudwatch.Alarm(this, "DynamoSystemErrorAlarm", {
      metric: tableSystemErrors,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const queueAge = input.gradingQueue.metricApproximateAgeOfOldestMessage({ period });
    const dlqDepth = input.gradingDlq.metricApproximateNumberOfMessagesVisible({ period });
    new cloudwatch.Alarm(this, "GradingQueueAgeAlarm", {
      metric: queueAge,
      threshold: 300,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "GradingDlqAlarm", {
      metric: dlqDepth,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const tableLatency = new cloudwatch.Metric({
      namespace: "AWS/DynamoDB",
      metricName: "SuccessfulRequestLatency",
      dimensionsMap: { ...tableDimensions, Operation: "TransactWriteItems" },
      statistic: "p95",
      period,
    });
    input.dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: "HTTP API", left: [apiRequests, apiErrorPercent], right: [apiLatency] }),
      new cloudwatch.GraphWidget({ title: "Session setup", left: [sessionSetup] }),
      new cloudwatch.GraphWidget({
        title: "Lambda errors and throttles",
        left: input.functions.map((fn) => fn.metricErrors({ period })),
        right: input.functions.map((fn) => fn.metricThrottles({ period })),
      }),
      new cloudwatch.GraphWidget({ title: "DynamoDB", left: [tableThrottles, tableSystemErrors], right: [tableLatency] }),
      new cloudwatch.GraphWidget({ title: "Grading queue", left: [queueAge], right: [dlqDepth] }),
    );
  }
}
