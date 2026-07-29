import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunFooter } from "#web/components/trema/run-footer.tsx";

afterEach(cleanup);

describe("RunFooter", () => {
  it("copies settled assistant prose", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MemoryRouter>
        <RunFooter
          runId="run-1"
          startedAt="2026-07-29T12:00:00Z"
          endedAt="2026-07-29T12:00:03Z"
          copyText="Assistant response"
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("Assistant response");
  });

  it("does not offer copy while the run is live", () => {
    render(
      <MemoryRouter>
        <RunFooter
          runId="run-1"
          startedAt={new Date().toISOString()}
          live
          copyText="Partial response"
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("shows a waiting state without a working timer while paused", () => {
    render(
      <MemoryRouter>
        <RunFooter
          runId="run-1"
          startedAt={new Date(Date.now() - 33_000).toISOString()}
          live
          waitingForDecision
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Paused · Waiting for your decision")).toBeTruthy();
    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(document.querySelector('[data-slot="status-dot"]')?.getAttribute("data-tone")).toBe(
      "wait",
    );
  });
});
