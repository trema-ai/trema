import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface EnvelopeV1 {
  v: 1;
  keyWrap: {
    alg: "A256GCM";
    wrappedKey: string;
    iv: string;
    authTag: string;
  };
  payload: {
    alg: "A256GCM";
    iv: string;
    authTag: string;
    ciphertext: string;
  };
}

export class CredentialEncryptionConfigError extends Error {
  constructor(message = "TREMA_CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte key") {
    super(message);
    this.name = "CredentialEncryptionConfigError";
  }
}

export class CredentialDecryptionError extends Error {
  constructor() {
    super("Credential envelope could not be decrypted");
    this.name = "CredentialDecryptionError";
  }
}

function decodeMasterKey(value: string | undefined): Buffer {
  if (!value) throw new CredentialEncryptionConfigError();
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  ) {
    throw new CredentialEncryptionConfigError();
  }
  return decoded;
}

function encryptBytes(plaintext: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptBytes(
  encrypted: { iv: string; authTag: string; ciphertext: string },
  key: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
}

export function encryptEnvelope(value: unknown, masterKey: string | undefined): string {
  const wrappingKey = decodeMasterKey(masterKey);
  const dataKey = randomBytes(32);
  const encryptedPayload = encryptBytes(Buffer.from(JSON.stringify(value), "utf8"), dataKey);
  const wrappedDataKey = encryptBytes(dataKey, wrappingKey);
  const envelope: EnvelopeV1 = {
    v: 1,
    keyWrap: {
      alg: "A256GCM",
      wrappedKey: wrappedDataKey.ciphertext,
      iv: wrappedDataKey.iv,
      authTag: wrappedDataKey.authTag,
    },
    payload: { alg: "A256GCM", ...encryptedPayload },
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(serialized: string): EnvelopeV1 {
  try {
    const value = JSON.parse(serialized) as Partial<EnvelopeV1>;
    if (
      value.v !== 1 ||
      value.keyWrap?.alg !== "A256GCM" ||
      value.payload?.alg !== "A256GCM" ||
      !value.keyWrap.wrappedKey ||
      !value.keyWrap.iv ||
      !value.keyWrap.authTag ||
      !value.payload.iv ||
      !value.payload.authTag ||
      !value.payload.ciphertext
    ) {
      throw new Error("invalid envelope");
    }
    return value as EnvelopeV1;
  } catch {
    throw new CredentialDecryptionError();
  }
}

export function decryptEnvelope<T>(serialized: string, masterKey: string | undefined): T {
  const wrappingKey = decodeMasterKey(masterKey);
  const envelope = parseEnvelope(serialized);
  try {
    const dataKey = decryptBytes(
      {
        iv: envelope.keyWrap.iv,
        authTag: envelope.keyWrap.authTag,
        ciphertext: envelope.keyWrap.wrappedKey,
      },
      wrappingKey,
    );
    const plaintext = decryptBytes(envelope.payload, dataKey);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new CredentialDecryptionError();
  }
}
