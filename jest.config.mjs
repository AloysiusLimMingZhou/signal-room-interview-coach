import nextJest from "next/jest.js";

const createJestConfig = nextJest({ dir: "./" });

export default createJestConfig({
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testMatch: ["<rootDir>/src/**/*.test.{ts,tsx}"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  collectCoverageFrom: [
    "src/lib/{cost,interview,interview-machine}.{ts,tsx}",
  ],
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 70,
      lines: 75,
      statements: 75,
    },
  },
});
