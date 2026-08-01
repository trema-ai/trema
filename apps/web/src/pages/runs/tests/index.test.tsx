import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunsPage } from "#web/pages/runs/index.tsx";

const query = vi.hoisted(() => ({
  result: {} as {
    isPending: boolean;
    error: Error | null;
    data?: {
      runs: Array<{
        access: "full" | "metadata";
        id: string;
        state: "running" | "completed";
        trigger: "api" | "message";
        createdAt: string;
        updatedAt: string;
        threadRef?: string;
        surface?: string;
        locationRef?: string;
      }>;
    };
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => query.result,
}));

vi.mock("#web/lib/api.ts", () => ({
  orpc: { runs: { list: { queryOptions: ({ input }: { input: unknown }) => ({ input }) } } },
}));

function Location() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/runs"]}>
      <RunsPage />
      <Location />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  query.result = {
    isPending: false,
    error: null,
    data: {
      runs: [
        {
          access: "full",
          id: "run-001",
          state: "running",
          trigger: "api",
          threadRef: "thread-001",
          surface: "slack",
          locationRef: "C012345",
          createdAt: "2026-07-31T12:00:00.000Z",
          updatedAt: "2026-07-31T12:01:00.000Z",
        },
        {
          access: "metadata",
          id: "run-002",
          state: "completed",
          trigger: "message",
          createdAt: "2026-07-31T11:00:00.000Z",
          updatedAt: "2026-07-31T11:02:00.000Z",
        },
      ],
    },
  };
});

afterEach(cleanup);

describe("RunsPage", () => {
  it("discovers readable and audit-only runs without offering conversational input", () => {
    renderPage();

    expect(screen.getByText("slack")).toBeTruthy();
    expect(screen.getByText("C012345")).toBeTruthy();
    expect(screen.getByText("Personal scope")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send|new run|new chat/i })).toBeNull();
  });

  it("opens a selected run", () => {
    renderPage();

    const row = screen.getByText("run-001").closest("tr");
    if (row === null) throw new Error("Run row was not rendered");
    fireEvent.click(row);

    expect(screen.getByTestId("location").textContent).toBe("/runs/run-001");
  });

  it("copies a run ID without opening the run", () => {
    renderPage();

    const copy = screen.getAllByRole("button", { name: "Copy" })[0];
    if (copy === undefined) throw new Error("Run copy button was not rendered");
    fireEvent.keyDown(copy, { key: "Enter" });
    fireEvent.click(copy);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("run-001");
    expect(screen.getByTestId("location").textContent).toBe("/runs");
  });

  it("keeps an operational empty state", () => {
    query.result = { isPending: false, error: null, data: { runs: [] } };
    renderPage();

    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Runs started from configured integrations, automations, and the API appear here.",
      ),
    ).toBeTruthy();
  });
});
