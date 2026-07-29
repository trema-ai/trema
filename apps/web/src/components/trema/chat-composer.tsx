import { ArrowUp, Loader2Icon, Square } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";

import { Button } from "#web/components/ui/button.tsx";
import { cn } from "#web/lib/utils.ts";

type ChatComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  /**
   * Present only while a run is active on the thread. The send button morphs
   * to stop exactly while a run is active and the input is empty; any typing
   * restores send — sending mid-run is a steer, never blocked.
   */
  onStop?: (() => void) | undefined;
  /** Stop pressed and waiting for the cancelled terminal on the tail. */
  stopping?: boolean;
  /** A failed send, stated above the input; the draft stays in the box. */
  error?: string | undefined;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** Optional controls in the action row, immediately left of send/stop. */
  actions?: ReactNode;
};

/**
 * The chat composer: the default assistant-ui shape — a rounded shell with
 * the input on top and an action row below — wired by hand because its
 * submit path is the intent endpoint, not a chat runtime. Enter sends,
 * Shift+Enter breaks the line, and an in-flight IME composition swallows
 * Enter so committing kana or hanzi never fires a send.
 */
function ChatComposer({
  value,
  onValueChange,
  onSend,
  onStop,
  stopping = false,
  error,
  placeholder = "Ask anything",
  autoFocus = false,
  className,
  actions,
}: ChatComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Start typing anywhere outside a text field and the keystroke flows into
  // the composer. Focusing during keydown lets that same character land in it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.isComposing) return;
      if (event.key.length !== 1) return;

      const input = inputRef.current;
      if (!input) return;

      const active = document.activeElement as HTMLElement | null;
      if (active === input) return;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable)
      ) {
        return;
      }

      input.focus();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Auto-grow: the textarea tracks its content up to the max height. The
  // frame-after pass repeats the measurement once layout has fully settled —
  // at mount the first read can see pre-stylesheet geometry and stick the
  // empty input at the cap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the resize reads the DOM, not `value`, but must re-run whenever the content changes
  useLayoutEffect(() => {
    const resize = () => {
      const input = inputRef.current;
      if (input === null) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
    };
    resize();
    const frame = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  const canSend = value.trim() !== "";
  const showStop = onStop !== undefined && !canSend;

  return (
    <div data-slot="chat-composer" className={cn("flex w-full flex-col", className)}>
      {error !== undefined && <p className="mb-2 text-meta text-destructive">{error}</p>}
      <div className="flex w-full flex-col gap-2 rounded-md border border-border/70 bg-card p-2 shadow-xs">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // A composition commit arrives as Enter too; it is input, not a send.
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) onSend();
          }}
          placeholder={placeholder}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the composer is the chat screen's one input; focusing it on open is the expected behavior
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Message input"
          className="max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none placeholder:text-muted-foreground/80"
        />
        <div className="flex items-center justify-end gap-1">
          {actions}
          {showStop ? (
            <Button
              type="button"
              size="icon-sm"
              aria-label={stopping ? "Stopping" : "Stop"}
              disabled={stopping}
              onClick={onStop}
              className="size-7 rounded-full"
            >
              {stopping ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Square className="size-3.5 fill-current" />
              )}
            </Button>
          ) : (
            <Button
              type="button"
              size="icon-sm"
              aria-label="Send"
              disabled={!canSend}
              onClick={onSend}
              className="size-7 rounded-full"
            >
              <ArrowUp className="size-4.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export { ChatComposer, type ChatComposerProps };
