export type ConnectorConnectionHealth = {
  revokedAt: Date | null;
  expiresAt: Date | null;
  refreshExhausted: boolean;
};

export type ConnectorConnectionHealthStatus =
  | "available"
  | "revoked"
  | "expired"
  | "refresh_exhausted"
  | "missing";

export function connectorConnectionValidity(
  connection: ConnectorConnectionHealth,
  now = new Date(),
) {
  const isRevoked = connection.revokedAt !== null;
  const isExpired = connection.expiresAt !== null && connection.expiresAt <= now;
  return {
    isRevoked,
    isExpired,
    isValid: !isRevoked && !isExpired && !connection.refreshExhausted,
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
  if (validity.isExpired) return "expired";
  return "available";
}
