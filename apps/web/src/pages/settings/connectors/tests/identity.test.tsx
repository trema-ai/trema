import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OrganizationConnectionCard,
  PersonalConnectionRow,
} from "#web/pages/customize/connections.tsx";
import type { ConnectorBody } from "#web/pages/customize/types.ts";
import {
  OAuthConnectionDialog,
  providerScopesForOAuthConnect,
} from "#web/pages/settings/connectors/connection-dialogs.tsx";
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
  isCredentialUnavailable: false,
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
        personalScopeId="personal-1"
        installationHealth="available"
        onReconnect={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Connected as you · Acme Linear")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByText(/scope|installation|provider permissions/i)).toBeNull();
    expect(document.querySelector('[data-slot="connector-card"]')).toBeTruthy();
  });

  it("offers a recovery action when a valid personal account is no longer installed", () => {
    renderWithQuery(
      <PersonalConnectionRow
        provider={provider}
        connection={{ ...connection, installations: [] }}
        personalScopeId="personal-1"
        installationHealth={undefined}
        onReconnect={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Setup needed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeTruthy();
    expect(document.querySelector('[data-status="missing"]')).toBeTruthy();
  });

  it("offers an MCP setup retry when the installed account has no usable tools", () => {
    renderWithQuery(
      <PersonalConnectionRow
        provider={{ ...provider, transport: { type: "mcp" } }}
        connection={connection}
        personalScopeId="personal-1"
        installationHealth="setup_required"
        onReconnect={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Setup needed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy();
    expect(document.querySelector('[data-status="missing"]')).toBeTruthy();
  });

  it("offers a REST setup retry when server validation rejects the installed body", () => {
    renderWithQuery(
      <PersonalConnectionRow
        provider={provider}
        connection={connection}
        personalScopeId="personal-1"
        installationHealth={undefined}
        onReconnect={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Setup needed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy();
  });

  it("identifies an inherited connector as organization-provided", () => {
    const body: ConnectorBody = {
      catalogKey: "linear",
      connectionId: "connection-org",
      access: { kind: "scope" },
      enabledTools: ["list_issues"],
    };
    const { rerender } = render(
      <OrganizationConnectionCard provider={provider} body={body} health="available" />,
    );

    expect(screen.getByText("Provided by your organization")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();

    rerender(<OrganizationConnectionCard provider={provider} body={body} health="revoked" />);
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();

    rerender(
      <OrganizationConnectionCard provider={provider} body={body} health="setup_required" />,
    );
    expect(screen.getByText("Setup needed")).toBeTruthy();
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

  it("preserves stored provider scopes during a member reconnect", () => {
    const selectedScopes = ["read", "write"];

    expect(
      providerScopesForOAuthConnect({
        audience: "member",
        provider,
        reconnect: { ...connection, providerScopes: selectedScopes },
        selectedScopes,
      }),
    ).toEqual(selectedScopes);
    expect(
      providerScopesForOAuthConnect({
        audience: "member",
        provider,
        selectedScopes: provider.defaultScopes,
      }),
    ).toBeUndefined();
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

  it("marks a provider unhealthy when an MCP installation needs setup", () => {
    const row: ProviderRow = {
      provider: { ...provider, transport: { type: "mcp" } },
      connections: [connection],
      installations: [
        {
          id: "installation-1",
          scopeId: "org-1",
          catalogKey: provider.key,
          connectionId: connection.id,
          access: { kind: "scope" },
          enabledTools: "all",
          syncedTools: [],
          health: "setup_required",
          status: "active",
          updatedAt: "2026-07-31T12:00:00.000Z",
        },
      ],
      needsSetup: false,
    };
    render(<ProviderCard row={row} onOpen={vi.fn()} />);

    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
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
