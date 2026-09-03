#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { P1Stack } from "../lib/p1-stack";
import { resolveP1Config } from "../lib/p1-config";

const app = new cdk.App();
const config = resolveP1Config({
  stage: app.node.tryGetContext("stage"),
  allowedOrigin: app.node.tryGetContext("allowedOrigin"),
  geminiSecretArn: app.node.tryGetContext("geminiSecretArn"),
  globalMonthlyInterviewLimit: app.node.tryGetContext("globalMonthlyInterviewLimit"),
  userMonthlyInterviewLimit: app.node.tryGetContext("userMonthlyInterviewLimit"),
  sessionDurationMinutes: app.node.tryGetContext("sessionDurationMinutes"),
});

new P1Stack(app, `SignalRoom-${config.stageName}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-southeast-1",
  },
  description: `Signal Room P1 serverless application plane (${config.stageName})`,
  terminationProtection: config.stageName === "prod",
  ...config,
});

app.synth();
