#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { P1Stack } from "../lib/p1-stack";
import { isProductionStage, resolveP1Config } from "../lib/p1-config";

const app = new cdk.App();
const config = resolveP1Config({
  stage: app.node.tryGetContext("stage"),
  allowedOrigin: app.node.tryGetContext("allowedOrigin"),
  alertEmail: app.node.tryGetContext("alertEmail"),
});

new P1Stack(app, `SignalRoom-${config.stageName}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-southeast-1",
  },
  description: `Signal Room serverless application plane (${config.stageName})`,
  terminationProtection: isProductionStage(config.stageName),
  ...config,
});

app.synth();
