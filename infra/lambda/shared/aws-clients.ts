import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const secretsClient = new SecretsManagerClient({});
export const sqsClient = new SQSClient({});

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required runtime configuration: ${name}`);
  return value;
}

export function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid positive integer runtime configuration: ${name}`);
  }
  return value;
}
