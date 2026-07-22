import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CredentialDecryptionError,
  CredentialEncryptionConfigError,
  decryptEnvelope,
  encryptEnvelope,
} from "#/lib/crypto/index.js";

const key = () => randomBytes(32).toString("base64");

describe("credential envelope encryption", () => {
  it("round-trips a typed payload without embedding plaintext", () => {
    const masterKey = key();
    const payload = { accessToken: "token-not-in-envelope", raw: { scope: "read" } };
    const encrypted = encryptEnvelope(payload, masterKey);

    expect(encrypted).not.toContain(payload.accessToken);
    expect(decryptEnvelope<typeof payload>(encrypted, masterKey)).toEqual(payload);
  });

  it("fails with a typed configuration error when the key is missing or malformed", () => {
    expect(() => encryptEnvelope({}, undefined)).toThrow(CredentialEncryptionConfigError);
    expect(() => encryptEnvelope({}, "not-a-32-byte-key")).toThrow(CredentialEncryptionConfigError);
  });

  it("rejects a wrong master key", () => {
    const encrypted = encryptEnvelope({ value: "secret" }, key());
    expect(() => decryptEnvelope(encrypted, key())).toThrow(CredentialDecryptionError);
  });

  it("detects payload tampering through GCM authentication", () => {
    const masterKey = key();
    const envelope = JSON.parse(encryptEnvelope({ value: "secret" }, masterKey));
    const bytes = Buffer.from(envelope.payload.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    envelope.payload.ciphertext = bytes.toString("base64");

    expect(() => decryptEnvelope(JSON.stringify(envelope), masterKey)).toThrow(
      CredentialDecryptionError,
    );
  });
});
