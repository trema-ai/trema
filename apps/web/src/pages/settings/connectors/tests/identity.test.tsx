import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OrganizationConnectionCard,
  PersonalConnectionRow,
} from "#web/pages/customize/connections.tsx";
import type { Item } from "#web/pages/customize/types.ts";
import { OAuthConnectionDialog } from "#web/pages/settings/connectors/connection-dialogs.tsx";
import { ProviderCard, type ProviderRow } from "#web/pages/settings/connectors/index.tsx";
import type {
  CatalogProvider,
  ConnectorConnection,
} from "#web/pages/settings/connectors/shared.tsx";

afterEach(cleanup);
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterAll(() => vi.unstubAllGlobals());

function renderWithQuery(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const provider: CatalogProvider = {
  key: "linear",
  displayName: "Linear",
  description: "Plan and build products.",
  categories: ["productivity"],
  docsUrl: "https://linear.app/docs",
  authMode: "oauth2_code",
  transport: { type: "rest" },
  supportsPersonalOAuth: true,
  configFields: {},
  credentialFields: {},
  toolManifest: [{ name: "list_issues", description: "List issues" }],
  defaultScopes: ["read"],
  availableScopes: ["read", "write"],
};

const connection: ConnectorConnection = {
  id: "connection-1",
  ownerPrincipalId: "person-1",
  providerKey: "linear",
  authMode: "oauth2_code",
  label: "Acme Linear",
  providerScopes: ["read"],
  isRevoked: false,
  isExpired: false,
  isValid: true,
  refreshExhausted: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-07-31T12:00:00.000Z",
  updatedAt: "2026-07-31T12:00:00.000Z",
  installations: [{ id: "installation-1", scopeId: "personal-1" }],
};

describe("connector identity UX", () => {
  it("presents a personal account as connected by the member", () => {
    renderWithQuery(
      <PersonalConnectionRow
        provider={provider}
        connection={connection}
        onReconnect={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Connected as you · Acme Linear")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByText(/scope|installation|provider permissions/i)).toBeNull();
    expect(document.querySelector('[data-slot="connector-card"]')).toBeTruthy();
  });

  it("identifies an inherited connector as organization-provided", () => {
    const item: Item = {
      id: "installation-org",
      scopeId: "org-1",
      kind: "connector",
      title: "Linear",
      body: {
        catalogKey: "linear",
        connectionId: "connection-org",
        access: { kind: "scope" },
        enabledTools: ["list_issues"],
      },
      status: "active",
      disclosure: "standing",
      createdById: "admin-1",
      sourceSessionId: null,
      confirmedById: null,
      updatedById: null,
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
      lastUsedAt: null,
      version: 1,
    };
    render(<OrganizationConnectionCard provider={provider} item={item} />);

    expect(screen.getByText("Provided by your organization")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();
  });

  it("keeps provider permissions out of the ordinary member connect flow", () => {
    renderWithQuery(
      <OAuthConnectionDialog audience="member" provider={provider} open onOpenChange={vi.fn()} />,
    );

    expect(
      screen.getByText(
        "Choose the Linear account you want Trema to use for connector calls in your personal chats.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeTruthy();
    expect(screen.queryByText("Advanced provider access")).toBeNull();
    expect(screen.queryByText("Provider permissions")).toBeNull();
  });

  it("names the account during member reconnect", () => {
    renderWithQuery(
      <OAuthConnectionDialog
        audience="member"
        provider={provider}
        reconnect={connection}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Reconnect Acme Linear. Trema will use this account for connector calls in your personal chats.",
      ),
    ).toBeTruthy();
  });

  it("keeps connected catalog cards focused on provider identity and health", () => {
    const row: ProviderRow = {
      provider,
      connections: [connection],
      installations: [],
      needsSetup: false,
    };
    render(<ProviderCard row={row} onOpen={vi.fn()} />);

    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.queryByText(/Credential:/)).toBeNull();
    expect(screen.queryByText(/Available in:/)).toBeNull();
    expect(document.querySelector('[data-slot="connector-card"]')).toBeTruthy();
  });

  it("replaces the disconnected status with a connect action", () => {
    const onOpen = vi.fn();
    const row: ProviderRow = {
      provider,
      connections: [],
      installations: [],
      needsSetup: false,
    };
    render(<ProviderCard row={row} onOpen={onOpen} />);

    screen.getByRole("button", { name: "Connect" }).click();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Not connected/i)).toBeNull();
    expect(screen.queryByText(/Credential:|Available in:/)).toBeNull();
  });

  it("puts provider permissions behind an explicit admin advanced section", () => {
    renderWithQuery(
      <OAuthConnectionDialog
        provider={provider}
        scopes={[{ id: "org-1", kind: "org", name: "Organization", ownerId: null }]}
        defaultScopeId="org-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Advanced provider access")).toBeTruthy();
    expect(screen.getByText("Provider permissions")).toBeTruthy();
    expect(screen.getByLabelText("Location")).toBeTruthy();
  });
});
