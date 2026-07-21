import { describe, expect, it } from "vitest";

import {
  hashBootstrapToken,
  verifyBootstrapToken,
} from "../index.js";

describe("bootstrap token hashing", () => {
  it("accepts only the token matching the persisted SHA-256 hash", () => {
    const persistedHash = hashBootstrapToken("correct token");

    expect(verifyBootstrapToken("correct token", persistedHash)).toBe(true);
    expect(verifyBootstrapToken("wrong token", persistedHash)).toBe(false);
  });

  it("rejects malformed persisted hashes without comparing unequal buffers", () => {
    expect(verifyBootstrapToken("token", "not-a-sha256-hash")).toBe(false);
  });
});
