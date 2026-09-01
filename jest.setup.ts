import "@testing-library/jest-dom";

import { randomUUID } from "node:crypto";

Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  value: randomUUID,
});
