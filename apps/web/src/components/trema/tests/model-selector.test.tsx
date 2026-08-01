import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ModelSelector } from "#web/components/trema/model-selector.tsx";
import { modelSelectionValue } from "#web/lib/model-selection.ts";

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

  it("selects a searched model and closes the list", () => {
    const onValueChange = vi.fn();
    render(
      <ModelSelector
        models={[
          {
            id: modelSelectionValue(offered[1]!),
            name: "Claude Opus",
            provider: "Anthropic",
          },
          { id: modelSelectionValue(offered[0]!), name: "GPT-5", provider: "OpenAI" },
        ]}
        value={modelSelectionValue(offered[1]!)}
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "gpt5" },
    });
    expect(screen.getByText("OpenAI")).toBeTruthy();
    fireEvent.click(screen.getByText("GPT-5"));

    expect(onValueChange).toHaveBeenCalledWith(modelSelectionValue(offered[0]!));
    expect(screen.queryByPlaceholderText("Search models…")).toBeNull();
  });

  it("uses the same fuzzy picker for settings model defaults", () => {
    const onValueChange = vi.fn();
    render(
      <ModelSelector
        models={[
          {
            id: modelSelectionValue(offered[1]!),
            name: "Claude Opus",
            provider: "Anthropic",
            keywords: ["Anthropic"],
          },
          {
            id: modelSelectionValue(offered[0]!),
            name: "GPT-5",
            provider: "OpenAI",
            keywords: ["OpenAI"],
          },
        ]}
        value={modelSelectionValue(offered[1]!)}
        selectedLabel="Claude Opus on Anthropic"
        onValueChange={onValueChange}
        ariaLabel="Choose a model for chat"
        emptyMessage="No model matches."
        placeholder="Choose a model"
        variant="settings"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Choose a model for chat" }));
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "gpt5 openai" },
    });
    fireEvent.click(screen.getByText("GPT-5"));

    expect(onValueChange).toHaveBeenCalledWith(modelSelectionValue(offered[0]!));
  });
});
