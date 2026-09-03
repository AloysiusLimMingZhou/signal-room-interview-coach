import nextJest from "next/jest.js";

const createJestConfig = nextJest({ dir: "./" });

export default createJestConfig({
  testEnvironment: "node",
  testMatch: ["<rootDir>/infra/test/**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  coveragePathIgnorePatterns: ["<rootDir>/infra/dist/"],
});
