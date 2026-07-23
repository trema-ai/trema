export type Sensitivity = "read" | "write" | "destructive";

export type FieldDescriptor = {
  type: "string";
  title: string;
  description?: string;
  example?: string;
  pattern?: string;
  optional?: boolean;
  secret?: boolean;
  enum?: string[];
  default?: string;
  prefix?: string;
  suffix?: string;
  visibleWhen?: { field: string; equals: string };
  automated?: boolean;
};

export type CatalogProvider = {
  key: string;
  displayName: string;
  description?: string;
  logoUrl?: string;
  categories: string[];
  docsUrl: string;
  authMode: string;
  transport: { type: "mcp" | "rest" };
  memberConnectable: boolean;
  configFields: Record<string, FieldDescriptor>;
  credentialFields: Record<string, FieldDescriptor>;
  toolManifest?: Array<{ name: string; description: string; sensitivity: Sensitivity }>;
  defaultScopes: string[];
  availableScopes?: string[];
};

export type Scope = {
  id: string;
  kind: "org" | "shared" | "personal";
  name: string;
  ownerId: string | null;
};

export type CredentialSummary = {
  id: string;
  principalId: string;
  principalName: string;
  mode: string;
  isRevoked: boolean;
  isExpired: boolean;
  isValid: boolean;
  expiresAt: string | null;
  createdAt: string;
};

export type ConnectorInstallation = {
  id: string;
  scopeId: string;
  catalogKey: string;
  enabledTools: "all" | string[];
  sensitivityOverrides: Record<string, Sensitivity>;
  syncedTools: Array<{ name: string; description?: string; sensitivity: Sensitivity }>;
  config: Record<string, string | number | boolean>;
  status: "proposed" | "active" | "archived";
  updatedAt: string;
  credentials: CredentialSummary[];
};

export type Registration = {
  id: string;
  providerKey: string;
  source: "platform" | "customer" | "dynamic";
  clientId: string | null;
  sharedRef: string | null;
  adminConsentGranted: boolean | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  isUsable: boolean;
};

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function providerLogo(provider: CatalogProvider, className = "size-9") {
  return provider.logoUrl ? (
    <img
      src={provider.logoUrl}
      alt=""
      className={`${className} shrink-0 rounded-md border bg-white object-contain p-1.5`}
    />
  ) : (
    <div
      className={`${className} grid shrink-0 place-items-center rounded-md border bg-muted font-medium`}
      aria-hidden="true"
    >
      {provider.displayName.slice(0, 1)}
    </div>
  );
}

export function authModeLabel(mode: string) {
  const labels: Record<string, string> = {
    oauth2_code: "OAuth 2",
    mcp_oauth: "MCP OAuth",
    api_key: "API key",
    basic: "Basic auth",
  };
  return labels[mode] ?? mode.replaceAll("_", " ");
}

export function categoryLabel(categories: string[]) {
  return categories
    .map((category) => {
      const words = category.replaceAll("-", " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" · ");
}
