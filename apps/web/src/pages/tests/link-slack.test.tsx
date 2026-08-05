import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkSlackPage } from "#web/pages/link-slack.tsx";

const api = vi.hoisted(() => ({
  session: {
    data: { user: { id: "user-1" } } as { user: { id: string } } | null,
    refetch: vi.fn(),
  },
  preview: {
    isPending: false,
    error: null as Error | null,
    data: {
      orgId: "org-1",
      orgName: "Acme",
      surface: "slack" as const,
      workspaceId: "T123ABC",
      userId: "U123ABC",
      expiresAt: "2026-08-05T12:15:00.000Z",
    },
  },
  redeem: vi.fn(),
  switchOrg: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => api.preview,
  useQueryClient: () => ({ invalidateQueries: api.invalidateQueries }),
}));

vi.mock("#web/lib/api.ts", () => ({
  authClient: {
    useSession: () => api.session,
  },
  orpc: {
    messaging: {
      slack: {
        identityChallenges: {
          preview: { queryOptions: (options: unknown) => options },
        },
      },
    },
  },
  rpcClient: {
    messaging: {
      slack: {
        identityChallenges: {
          redeem: (...args: unknown[]) => api.redeem(...args),
        },
      },
    },
    org: {
      switch: (...args: unknown[]) => api.switchOrg(...args),
    },
  },
}));

vi.mock("#web/pages/home.tsx", () => ({
  Loading: () => <div>Loading</div>,
}));

function Location() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(entry = "/link/slack?token=challenge-token") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/link/slack" element={<LinkSlackPage />} />
        <Route path="/sign-in" element={<Location />} />
        <Route path="/runs" element={<Location />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.session.data = { user: { id: "user-1" } };
  api.session.refetch.mockReset().mockResolvedValue(undefined);
  api.preview.isPending = false;
  api.preview.error = null;
  api.preview.data = {
    orgId: "org-1",
    orgName: "Acme",
    surface: "slack",
    workspaceId: "T123ABC",
    userId: "U123ABC",
    expiresAt: "2026-08-05T12:15:00.000Z",
  };
  api.redeem.mockReset();
  api.switchOrg.mockReset().mockResolvedValue(undefined);
  api.invalidateQueries.mockReset();
});

afterEach(cleanup);

describe("LinkSlackPage", () => {
  it("shows a missing-token error when the challenge token is absent", () => {
    renderPage("/link/slack");

    expect(screen.getByRole("heading", { name: "Link Slack account" })).toBeTruthy();
    expect(screen.getByText("This link is missing its challenge token.")).toBeTruthy();
  });

  it("redirects unauthenticated visitors to sign-in with a returnTo", () => {
    api.session.data = null;
    renderPage();

    expect(screen.getByTestId("location").textContent).toBe(
      `/sign-in?returnTo=${encodeURIComponent("/link/slack?token=challenge-token")}`,
    );
  });

  it.each([
    {
      reason: "identity_conflict",
      message:
        "This Slack account is already linked to another Trema member. Ask a Trema administrator to resolve the conflict.",
    },
    {
      reason: "deactivated",
      message: "A deactivated member cannot link a Slack identity.",
    },
    {
      reason: "not_a_member",
      message: "You must be an active member of this organization to link this Slack account.",
    },
  ] as const)("renders the $reason redeem failure without matching prose", async ({ reason, message }) => {
    api.redeem.mockRejectedValue(
      Object.assign(new Error("Server prose that must not be parsed"), {
        data: { reason },
      }),
    );
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Link my Trema account" }));

    await waitFor(() => {
      expect(screen.getByText(message)).toBeTruthy();
    });
    expect(api.switchOrg).not.toHaveBeenCalled();
  });

  it("confirms a successful link after redeem", async () => {
    api.redeem.mockResolvedValue({
      orgId: "org-1",
      identityLinkId: "link-1",
      principalId: "principal-1",
      workspaceId: "T123ABC",
      userId: "U123ABC",
    });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Link my Trema account" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Slack account linked" })).toBeTruthy();
    });
    expect(
      screen.getByText(
        "Slack user U123ABC in workspace T123ABC is linked to your Trema account. Return to Slack and retry your original message.",
      ),
    ).toBeTruthy();
    expect(api.switchOrg).toHaveBeenCalledWith({ orgId: "org-1" });
    expect(api.session.refetch).toHaveBeenCalledOnce();
    expect(api.invalidateQueries).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Continue in Trema" })).toBeTruthy();
  });
});
