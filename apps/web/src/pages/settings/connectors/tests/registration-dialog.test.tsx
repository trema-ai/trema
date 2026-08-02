import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegistrationDialog } from "#web/pages/settings/connectors/registration-dialog.tsx";
import type { CatalogProvider, Registration } from "#web/pages/settings/connectors/shared.tsx";

const api = vi.hoisted(() => ({
  createRegistration: vi.fn(),
  deleteRegistration: vi.fn(),
  registrationKey: ["connectors", "registrations"],
  connectionKey: ["connectors", "connections"],
  connectorInstallationKey: ["connectors", "installations"],
  slackInstallationKey: ["messaging", "slack", "installations"],
}));

vi.mock("#web/lib/api.ts", () => ({
  orpc: {
    connectors: {
      registrations: {
        list: { queryOptions: () => ({ queryKey: api.registrationKey }) },
      },
      connections: { list: { key: () => api.connectionKey } },
      installations: { list: { key: () => api.connectorInstallationKey } },
    },
    messaging: {
      slack: { installations: { list: { key: () => api.slackInstallationKey } } },
    },
  },
  rpcClient: {
    connectors: {
      registrations: {
        create: api.createRegistration,
        delete: api.deleteRegistration,
      },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const provider: CatalogProvider = {
  key: "slack",
  displayName: "Slack",
  description: "Team messaging",
  categories: ["communication"],
  docsUrl: "https://api.slack.com/apps",
  authMode: "oauth2_code",
  transport: { type: "rest" },
  supportsPersonalOAuth: false,
  configFields: {},
  credentialFields: {},
  toolManifest: [],
  defaultScopes: [],
  availableScopes: [],
};

const registration: Registration = {
  id: "registration-1",
  providerKey: "slack",
  source: "customer",
  clientId: "client-1234567890",
  sharedRef: null,
  adminConsentGranted: null,
  notes: null,
  isUsable: true,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
};

afterEach(cleanup);

beforeEach(() => {
  api.createRegistration.mockReset();
  api.deleteRegistration.mockReset().mockResolvedValue({ id: registration.id });
});

describe("registration removal", () => {
  it("warns that accounts are revoked and refreshes every affected Slack query", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    for (const queryKey of [
      api.registrationKey,
      api.connectionKey,
      api.connectorInstallationKey,
      api.slackInstallationKey,
    ]) {
      queryClient.setQueryData(queryKey, {});
    }

    render(
      <QueryClientProvider client={queryClient}>
        <RegistrationDialog
          provider={provider}
          registrations={[registration]}
          callbackUrl="https://trema.example/api/v1/connectors/oauth/callback"
          open
          onOpenChange={() => undefined}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.getByText(/Every connector account using this app will be revoked/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove app" }));

    await waitFor(() =>
      expect(api.deleteRegistration).toHaveBeenCalledWith({ id: registration.id }),
    );
    await waitFor(() => {
      for (const queryKey of [
        api.registrationKey,
        api.connectionKey,
        api.connectorInstallationKey,
        api.slackInstallationKey,
      ]) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
      }
    });
  });
});
