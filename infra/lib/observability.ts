import { Duration } from "aws-cdk-lib";
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

export const MONTHLY_BUDGET_USD = 1;

export interface ProductionObservabilityInput {
  stageName: string;
  api: apigwv2.HttpApi;
  functions: lambda.IFunction[];
  gradingDlq: sqs.IQueue;
  metricNamespace: string;
  alertEmail: string;
}

/**
 * Production-only monitoring sized for the CloudWatch free tier: 10 alarm metrics,
 * 10 custom metrics, and 3 dashboards per account. Every alarm has a single metric.
 */
export function addProductionObservability(
  scope: Construct,
  input: ProductionObservabilityInput,
): cloudwatch.Dashboard {
  const period = Duration.minutes(5);
  const api5xx = new cloudwatch.Metric({
    namespace: "AWS/ApiGateway",
    metricName: "5xx",
    dimensionsMap: { ApiId: input.api.apiId, Stage: "$default" },
    statistic: "Sum",
    period,
  });
  const applicationMetric = (metricName: string) => new cloudwatch.Metric({
    namespace: input.metricNamespace,
    metricName,
    dimensionsMap: { Environment: "production", Provider: "application" },
    statistic: "Sum",
    period,
  });
  const dlqDepth = input.gradingDlq.metricApproximateNumberOfMessagesVisible({ period, statistic: "Maximum" });

  const alertTopic = new sns.Topic(scope, "OperationsAlerts", {
    topicName: `signal-room-${input.stageName}-alerts`,
    enforceSSL: true,
  });
  alertTopic.addSubscription(new subscriptions.EmailSubscription(input.alertEmail));
  const notify = new cloudwatchActions.SnsAction(alertTopic);

  const alarms: Array<[string, cloudwatch.IMetric]> = [
    ["ApiServerErrors", api5xx],
    ...input.functions.map((fn): [string, cloudwatch.IMetric] => [`${fn.node.id}Errors`, fn.metricErrors({ period })]),
    ["GradingDlqDepth", dlqDepth],
    ["GradingFailures", applicationMetric("grading_failed")],
    ["SessionSetupFailures", applicationMetric("session_setup_failed")],
  ];
  for (const [id, metric] of alarms) {
    const alarm = new cloudwatch.Alarm(scope, `${id}Alarm`, {
      metric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(notify);
  }

  const dashboard = new cloudwatch.Dashboard(scope, "OperationsDashboard", {
    dashboardName: `signal-room-${input.stageName}`,
    defaultInterval: Duration.hours(24),
  });
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: "HTTP API 5xx", left: [api5xx] }),
    new cloudwatch.GraphWidget({ title: "Lambda errors", left: input.functions.map((fn) => fn.metricErrors({ period })) }),
    new cloudwatch.GraphWidget({
      title: "Grading",
      left: [applicationMetric("grading_failed"), applicationMetric("session_setup_failed")],
      right: [dlqDepth],
    }),
  );

  new budgets.CfnBudget(scope, "MonthlyCostBudget", {
    budget: {
      budgetName: `signal-room-${input.stageName}-monthly`,
      budgetType: "COST",
      timeUnit: "MONTHLY",
      budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: "USD" },
    },
    notificationsWithSubscribers: [
      {
        notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: input.alertEmail }],
      },
      {
        notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: input.alertEmail }],
      },
    ],
  });
  return dashboard;
}
