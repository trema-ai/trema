import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "#web/components/trema/chat-composer.tsx";

afterEach(cleanup);

describe("ChatComposer", () => {
  it("focuses on printable typing outside text controls", () => {
    const { container } = render(
      <>
        <button type="button">Elsewhere</button>
        <input aria-label="Other input" />
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: jsdom needs an explicit tab stop to model contenteditable focus */}
        <div contentEditable suppressContentEditableWarning tabIndex={0}>
          Editor
        </div>
        <ChatComposer value="" onValueChange={() => {}} onSend={() => {}} />
      </>,
    );

    const composer = screen.getByLabelText("Message input");
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    fireEvent.keyDown(window, { key: "a" });
    expect(document.activeElement).toBe(composer);

    const otherInput = screen.getByLabelText("Other input");
    otherInput.focus();
    fireEvent.keyDown(window, { key: "b" });
    expect(document.activeElement).toBe(otherInput);

    const editor = container.querySelector<HTMLElement>("[contenteditable]");
    if (editor === null) throw new Error("contenteditable fixture missing");
    Object.defineProperty(editor, "isContentEditable", { value: true });
    editor.focus();
    fireEvent.keyDown(window, { key: "c" });
    expect(document.activeElement).toBe(editor);
  });

  it("keeps IME Enter as input and sends on plain Enter", () => {
    const onSend = vi.fn();
    render(<ChatComposer value="こんにちは" onValueChange={() => {}} onSend={onSend} />);

    const composer = screen.getByLabelText("Message input");
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });
});
