/** @jest-environment node */
import { emitMetric, validateSafeLogMetadata } from "../lambda/shared/logging";

const originalEnvironment = process.env.ENVIRONMENT;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
  jest.restoreAllMocks();
});

describe("custom metric emission", () => {
  it("emits nothing outside production so dev stays inside the free tier", () => {
    process.env.ENVIRONMENT = "dev";
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitMetric("session_setup_failed", 1, "Count");
    expect(write).not.toHaveBeenCalled();
  });

  it("writes an EMF document in production", () => {
    process.env.ENVIRONMENT = "prod";
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitMetric("grading_failed", 1, "Count");
    const document = JSON.parse(String(write.mock.calls[0][0]));
    expect(document._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: "grading_failed", Unit: "Count" }]);
    expect(document).toMatchObject({ Environment: "production", Provider: "application", grading_failed: 1 });
  });
});

describe("safe log operations", () => {
  it("accepts the account read operation", () => {
    expect(validateSafeLogMetadata({ level: "INFO", operation: "account.read", result: "success" }).operation)
      .toBe("account.read");
  });
});
