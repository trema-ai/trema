import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChainOfThought,
  chainOfThoughtLabel,
  disclosureOpen,
} from "#web/components/trema/chain-of-thought.tsx";

afterEach(cleanup);

describe("ChainOfThought", () => {
  it("uses the count-free working labels", () => {
    expect(chainOfThoughtLabel(true)).toBe("Working…");
    expect(chainOfThoughtLabel(false)).toBe("Worked it out");
  });

  it("carries the worked-for duration once settled", () => {
    expect(chainOfThoughtLabel(false, "12s")).toBe("Worked for 12s");
    // A settled duration never leaks into the live label.
    expect(chainOfThoughtLabel(true, "12s")).toBe("Working…");
  });

  it("carries the ticking timer while streaming", () => {
    expect(chainOfThoughtLabel(true, undefined, "9s")).toBe("Working for 9s");
    // The live timer never leaks into the settled label.
    expect(chainOfThoughtLabel(false, undefined, "9s")).toBe("Worked it out");
  });

  it("auto-opens while streaming and auto-collapses when settled", () => {
    const view = render(
      <ChainOfThought streaming>
        <span>machinery</span>
      </ChainOfThought>,
    );

    expect(
      view.container.querySelector('[data-slot="chain-of-thought"]')?.getAttribute("data-state"),
    ).toBe("open");
    expect(view.getByRole("button", { name: "Working…" }).querySelector("svg")).toBeNull();

    view.rerender(
      <ChainOfThought streaming={false}>
        <span>machinery</span>
      </ChainOfThought>,
    );

    expect(
      view.container.querySelector('[data-slot="chain-of-thought"]')?.getAttribute("data-state"),
    ).toBe("closed");
    expect(view.getByRole("button", { name: "Worked it out" })).toBeDefined();
  });

  it("lets the first manual toggle override later streaming changes", () => {
    const view = render(
      <ChainOfThought streaming={false}>
        <span>machinery</span>
      </ChainOfThought>,
    );
    const trigger = view.getByRole("button", { name: "Worked it out" });
    fireEvent.click(trigger);

    view.rerender(
      <ChainOfThought streaming>
        <span>machinery</span>
      </ChainOfThought>,
    );
    expect(
      view.container.querySelector('[data-slot="chain-of-thought"]')?.getAttribute("data-state"),
    ).toBe("open");

    fireEvent.click(view.getByRole("button", { name: "Working…" }));
    view.rerender(
      <ChainOfThought streaming={false}>
        <span>machinery</span>
      </ChainOfThought>,
    );
    expect(
      view.container.querySelector('[data-slot="chain-of-thought"]')?.getAttribute("data-state"),
    ).toBe("closed");
  });
});

describe("disclosureOpen", () => {
  it("uses automatic state only until a user choice exists", () => {
    expect(disclosureOpen(null, true)).toBe(true);
    expect(disclosureOpen(null, false)).toBe(false);
    expect(disclosureOpen(false, true)).toBe(false);
    expect(disclosureOpen(true, false)).toBe(true);
  });
});
