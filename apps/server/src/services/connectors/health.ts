import { decryptEnvelope } from "#server/lib/crypto/index.js";

export type ConnectorConnectionHealth = {
  revokedAt: Date | null;
  expiresAt: Date | null;
  refreshExhausted: boolean;
  canRefresh?: boolean;
  credentialAvailable?: boolean;
  lastRefreshFailure?: Date | null;
};

export type ConnectorConnectionHealthStatus =
  | "available"
  | "revoked"
  | "expired"
  | "refresh_exhausted"
  | "unavailable"
  | "missing";

export function connectorConnectionValidity(
  connection: ConnectorConnectionHealth,
  now = new Date(),
) {
  const isRevoked = connection.revokedAt !== null;
  const isCredentialUnavailable = connection.credentialAvailable === false;
  const isExpired =
    connection.expiresAt !== null &&
    connection.expiresAt <= now &&
    (!connection.canRefresh ||
      (connection.lastRefreshFailure !== undefined && connection.lastRefreshFailure !== null));
  return {
    isRevoked,
    isExpired,
    isCredentialUnavailable,
    isValid: !isRevoked && !isExpired && !isCredentialUnavailable && !connection.refreshExhausted,
  };
}

export function connectorConnectionHealthStatus(
  connection: ConnectorConnectionHealth | undefined,
  now = new Date(),
): ConnectorConnectionHealthStatus {
  if (connection === undefined) return "missing";
  const validity = connectorConnectionValidity(connection, now);
  if (validity.isRevoked) return "revoked";
  if (connection.refreshExhausted) return "refresh_exhausted";
  if (validity.isCredentialUnavailable) return "unavailable";
  if (validity.isExpired) return "expired";
  return "available";
}

function credentialHasRefreshToken(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const direct = payload.refreshToken;
  if (typeof direct === "string" && direct.length > 0) return true;
  const raw = payload.raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const nested = (raw as Record<string, unknown>).refresh_token;
  return typeof nested === "string" && nested.length > 0;
}

export function connectorConnectionCredentialHealth(
  connection: { authMode: string; ciphertext: string },
  masterKey?: string,
): { canRefresh: boolean; credentialAvailable: boolean } {
  try {
    const credential = decryptEnvelope<unknown>(connection.ciphertext, masterKey);
    return {
      canRefresh:
        (connection.authMode === "oauth2_code" || connection.authMode === "mcp_oauth") &&
        credentialHasRefreshToken(credential),
      credentialAvailable: true,
    };
  } catch {
    return { canRefresh: false, credentialAvailable: false };
  }
}
