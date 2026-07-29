import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ModelSelector } from "#web/components/trema/model-selector.tsx";
import { modelSelectionValue, resolveModelSelection } from "#web/lib/model-selection.ts";

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
  Element.prototype.scrollIntoView = vi.fn();
});
afterAll(() => vi.unstubAllGlobals());

describe("ModelSelector", () => {
  const offered = [
    { providerName: "openai", modelId: "gpt-5" },
    { providerName: "anthropic", modelId: "claude-opus" },
  ];

  it("drops a persisted model that is no longer offered", () => {
    expect(resolveModelSelection(offered[0]!, offered)).toEqual(offered[0]);
    expect(
      resolveModelSelection({ providerName: "removed", modelId: "old" }, offered),
    ).toBeUndefined();
  });

  it("selects a searched model and closes the list", () => {
    const onValueChange = vi.fn();
    render(
      <ModelSelector
        models={[
          { id: modelSelectionValue(offered[1]!), name: "Claude Opus" },
          { id: modelSelectionValue(offered[0]!), name: "GPT-5" },
        ]}
        value={modelSelectionValue(offered[1]!)}
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "GPT" },
    });
    fireEvent.click(screen.getByText("GPT-5"));

    expect(onValueChange).toHaveBeenCalledWith(modelSelectionValue(offered[0]!));
    expect(screen.queryByPlaceholderText("Search models…")).toBeNull();
  });
});
