import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, type RenderResult, render } from "@testing-library/react";
import { type FoldInput, fold } from "@trema/projection";
import {
  at,
  envelope,
  followUps,
  gatedBatch,
  kitchenSink,
  log,
  parkResume,
  principal,
  usage,
} from "@trema/projection/testing";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState } from "#web/components/trema/run-state-badge.tsx";
import type { RunStreamPhase, RunStreamSnapshot } from "#web/hooks/use-run-stream.ts";
import {
  advanceTimeline,
  emptyTimelineMeta,
  isTerminalRunState,
  type PrincipalLike,
} from "#web/lib/run-timeline.ts";
import { RunBlock } from "#web/pages/chat/run-block.tsx";
import { RunTimeline } from "#web/pages/runs/timeline.tsx";

/**
 * Golden parity: the chat thread and the canonical run view render the same
 * projection from the same recorded event logs with no divergence. The fold
 * is one code path with one golden suite (packages/projection/tests); this
 * suite proves the two screens are one renderer over it. The only tolerated
 * differences are the ones web 06 documents:
 *
 * 1. The chat renders the opening steering part as the user bubble instead of
 *    a steering note; the run view, which has no bubble, keeps the note.
 * 2. The chat does not expand outputs — the run view is the run-scoped record.
 * 3. The chat states the terminal itself (a "stopped" divider on a cancelled
 *    run, a failure note when the log carries no error part) where the run
 *    view says it in its run-scoped header, which the chat omits — along with
 *    the deep-linking run footer that replaces those panels.
 * 4. The chat collapses each machinery chunk behind a chain-of-thought
 *    disclosure whose expanded content is the shared timeline rendering.
 * 5. Errors stay at conversation level in chat instead of entering a
 *    chain-of-thought disclosure.
 * 6. The chat renders steering parts as right-aligned user bubbles where the
 *    run view keeps steering notes.
 *
 * Anything else that differs between the two DOMs is a renderer bug.
 */

// The chat tails runs through `useRunStream`; feeding it the fixture fold
// directly keeps the test networkless while exercising the real `RunBlock`
// path (opening suppression included). The run view takes its snapshot as a
// prop, so only the chat side needs the seam.
const streams = vi.hoisted(() => new Map<string, unknown>());

vi.mock("#web/hooks/use-run-stream.ts", () => ({
  useRunStream: (runId: string) => {
    const snapshot = streams.get(runId);
    if (snapshot === undefined) throw new Error(`no stream snapshot seeded for ${runId}`);
    return snapshot;
  },
}));

/** The slots that render projection parts and segment boundaries. */
const PART_SLOTS: ReadonlySet<string> = new Set([
  "text-part",
  "reasoning-block",
  "activity-card",
  "steering-note",
  "approval-card",
  "elicitation-row",
  "error-item",
  "data-part",
  "segment-divider",
]);

interface RenderedPart {
  slot: string;
  text: string;
  /** `data-kind` where the slot carries one (approval cards). */
  kind: string | null;
  /** `data-redacted` where the slot carries one (reasoning blocks). */
  redacted: string | null;
}

/**
 * The structured extraction the parity assertion compares: every part-level
 * slot in document order with its visible text — semantics, not class names,
 * so the test fails on divergent rendering and survives styling churn.
 */
function renderedParts(container: HTMLElement): RenderedPart[] {
  return [...container.querySelectorAll("[data-slot]")]
    .filter((element) => {
      const slot = element.getAttribute("data-slot") ?? "";
      return (
        PART_SLOTS.has(slot) ||
        (slot === "chat-bubble" && element.getAttribute("data-chat-part") === "steering")
      );
    })
    .map((element) => {
      const rawSlot = element.getAttribute("data-slot") ?? "";
      const steering =
        rawSlot === "steering-note" || element.getAttribute("data-chat-part") === "steering";
      return {
        // Difference 6 changes vocabulary, not the semantic part sequence.
        slot: steering ? "steering-note" : rawSlot,
        text: (steering
          ? (element.querySelector("p")?.textContent ?? "")
          : (element.textContent ?? "")
        )
          .replace(/\s+/g, " ")
          .trim(),
        kind: element.getAttribute("data-kind"),
        redacted: element.getAttribute("data-redacted"),
      };
    });
}

function renderWithProviders(ui: ReactElement): RenderResult {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

function expandChatChains(container: HTMLElement) {
  for (const trigger of container.querySelectorAll(
    '[data-slot="chain-of-thought-trigger"][data-state="closed"]',
  )) {
    fireEvent.click(trigger);
  }
}

/** What a parity case needs from a fixture — the recorded log, not the golden. */
interface FixtureLog {
  name: string;
  runId: string;
  events: FoldInput[];
}

interface ParityCase {
  fixture: FixtureLog;
  /** The run state the thread-runs read reports beside the log. */
  state: RunState;
  /** Where the stream is: `static` for settled history, `live` for a tail. */
  phase: RunStreamPhase;
  /** The opening user message, when the run was message-triggered. */
  opening: { author: PrincipalLike; text: string } | null;
  /** Slots the fixture must produce — guards against vacuous parity. */
  mustRender: readonly string[];
}

function makeSnapshot(parityCase: ParityCase): RunStreamSnapshot {
  const { projection, meta } = advanceTimeline(
    fold(parityCase.fixture.runId, []),
    emptyTimelineMeta(),
    parityCase.fixture.events,
  );
  return { phase: parityCase.phase, projection, meta, serverMalformed: 0 };
}

function renderBoth(parityCase: ParityCase): { runView: RenderResult; chat: RenderResult } {
  const { fixture, state, opening } = parityCase;
  const snapshot = makeSnapshot(parityCase);
  streams.set(fixture.runId, snapshot);
  const runView = renderWithProviders(
    <RunTimeline
      runId={fixture.runId}
      runCreatedAt={at}
      snapshot={snapshot}
      queuedInput={[]}
      runSettled={isTerminalRunState(state)}
    />,
  );
  const chat = renderWithProviders(
    <RunBlock
      run={{
        id: fixture.runId,
        state,
        trigger: "message",
        createdAt: at,
        openingMessage: opening,
      }}
    />,
  );
  return { runView, chat };
}

// Fixture coverage the recorded set lacks, built the same way (states the
// projection can reach that no packages/projection fixture exercises).

/** A plain text run opened by a user message — the everyday chat exchange. */
const openingText: FixtureLog = {
  name: "opening text",
  runId: "run-parity-opening",
  events: log([
    { type: "run-started", trigger: "message" },
    { type: "steering", author: principal, text: "Check the deployment" },
    { type: "text-start", blockId: "text-1" },
    { type: "text-delta", blockId: "text-1", delta: "All green." },
    { type: "text-end", blockId: "text-1" },
    { type: "run-finished", outcome: "completed", usage },
  ]),
};

/** A run stopped mid-answer: the terminal is a decision, not a failure. */
const cancelledRun: FixtureLog = {
  name: "cancelled",
  runId: "run-parity-cancelled",
  events: log([
    { type: "run-started", trigger: "message" },
    { type: "text-start", blockId: "text-1" },
    { type: "text-delta", blockId: "text-1", delta: "Starting the check" },
    { type: "run-finished", outcome: "cancelled" },
  ]),
};

/** A run that died without recording an error part on its log. */
const failedRun: FixtureLog = {
  name: "failed",
  runId: "run-parity-failed",
  events: log([
    { type: "run-started", trigger: "message" },
    { type: "text-start", blockId: "text-1" },
    { type: "text-delta", blockId: "text-1", delta: "Looking into it" },
    { type: "run-finished", outcome: "failed" },
  ]),
};

const cases: ParityCase[] = [
  {
    fixture: openingText,
    state: "completed",
    phase: "static",
    opening: { author: principal, text: "Check the deployment" },
    mustRender: ["steering-note", "text-part"],
  },
  {
    fixture: kitchenSink,
    state: "completed",
    phase: "static",
    opening: null,
    mustRender: [
      "reasoning-block",
      "text-part",
      "activity-card",
      "elicitation-row",
      "segment-divider",
      "steering-note",
      "data-part",
      "error-item",
    ],
  },
  {
    fixture: parkResume,
    state: "completed",
    phase: "static",
    opening: null,
    mustRender: ["elicitation-row", "segment-divider", "activity-card", "text-part"],
  },
  {
    fixture: followUps,
    state: "completed",
    phase: "static",
    opening: null,
    mustRender: ["text-part", "segment-divider", "steering-note"],
  },
  {
    fixture: gatedBatch,
    state: "awaiting_approval",
    phase: "live",
    opening: null,
    mustRender: ["activity-card", "approval-card", "segment-divider"],
  },
  {
    fixture: cancelledRun,
    state: "cancelled",
    phase: "static",
    opening: null,
    mustRender: ["text-part"],
  },
  {
    fixture: failedRun,
    state: "failed",
    phase: "static",
    opening: null,
    mustRender: ["text-part"],
  },
];

describe("chat / run view golden parity", () => {
  beforeEach(() => {
    // No test may leave jsdom: any fetch hangs forever instead of escaping.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<never>(() => {})),
    );
  });

  afterEach(() => {
    cleanup();
    streams.clear();
    vi.unstubAllGlobals();
  });

  it.each(cases.map((parityCase) => [parityCase.fixture.name, parityCase] as const))(
    "renders %s identically on both screens",
    (_name, parityCase) => {
      const { runView, chat } = renderBoth(parityCase);
      expandChatChains(chat.container);
      const viewParts = renderedParts(runView.container);

      const rendered = new Set(viewParts.map((part) => part.slot));
      for (const slot of parityCase.mustRender) expect(rendered).toContain(slot);

      // Documented difference 1: the opening steering part is the chat's user
      // bubble; the run view keeps it as its first steering note.
      let shared = viewParts;
      const bubble = chat.container.querySelector(
        '[data-slot="chat-bubble"]:not([data-chat-part])',
      );
      if (parityCase.opening === null) {
        expect(bubble).toBeNull();
      } else {
        expect(bubble?.textContent).toBe(parityCase.opening.text);
        expect(shared[0]?.slot).toBe("steering-note");
        expect(shared[0]?.text).toBe(parityCase.opening.text);
        shared = shared.slice(1);
      }

      // Documented difference 6: every remaining steering part carries the
      // same message text, but the chat uses the user-bubble vocabulary.
      const viewSteeringTexts = shared
        .filter((part) => part.slot === "steering-note")
        .map((part) => part.text);
      const chatSteeringBubbles = [
        ...chat.container.querySelectorAll('[data-slot="chat-bubble"][data-chat-part="steering"]'),
      ];
      expect(chatSteeringBubbles.map((bubble) => bubble.querySelector("p")?.textContent)).toEqual(
        viewSteeringTexts,
      );
      expect(chat.container.querySelector('[data-slot="steering-note"]')).toBeNull();

      // Documented difference 3: the chat states the terminal inline where
      // the run view's header (a run-scoped panel the chat omits) says it.
      const snapshot = streams.get(parityCase.fixture.runId) as RunStreamSnapshot;
      const hasErrorPart = snapshot.projection.segments.some((segment) =>
        segment.parts.some((part) => part.kind === "error"),
      );
      const chatOnly: RenderedPart[] = [];
      if (parityCase.state === "cancelled") {
        chatOnly.push({ slot: "segment-divider", text: "stopped", kind: null, redacted: null });
      }
      if (parityCase.state === "failed" && !hasErrorPart) {
        chatOnly.push({
          slot: "error-item",
          text: "Run failedThe run ended in an error. See the run view.",
          kind: null,
          redacted: null,
        });
      }

      // The parity rule: modulo exactly the documented differences above, the
      // two screens render one identical part sequence.
      expect(renderedParts(chat.container)).toEqual([...shared, ...chatOnly]);

      for (const error of chat.container.querySelectorAll('[data-slot="error-item"]')) {
        expect(error.closest('[data-slot="chain-of-thought-content"]')).toBeNull();
      }

      // The chat's deep link to the canonical run view exists exactly once;
      // the run view, being the destination, renders no footer.
      expect(
        chat.container.querySelectorAll(
          `[data-slot="run-footer"] a[href="/runs/${parityCase.fixture.runId}"]`,
        ),
      ).toHaveLength(1);
      if (["completed", "failed", "cancelled"].includes(parityCase.state)) {
        const footerClasses = chat.container
          .querySelector('[data-slot="run-footer"]')
          ?.className.split(" ");
        expect(footerClasses).toEqual(
          expect.arrayContaining([
            "opacity-0",
            "group-hover/run:opacity-100",
            "group-focus-within/run:opacity-100",
          ]),
        );
      }
      expect(runView.container.querySelector('[data-slot="run-footer"]')).toBeNull();
    },
  );

  it("expands outputs on the run view only (documented difference 2)", () => {
    // kitchen sink's read call carries an outputRef; expanding its card must
    // start the lazy output read on the run view and nothing in the chat.
    const parityCase = cases.find((candidate) => candidate.fixture === kitchenSink);
    if (parityCase === undefined) throw new Error("kitchen sink case missing");
    const { runView, chat } = renderBoth(parityCase);
    expandChatChains(chat.container);

    for (const container of [runView.container, chat.container]) {
      const card = [...container.querySelectorAll('[data-slot="activity-card"]')].find((element) =>
        element.textContent?.includes("Read"),
      );
      const trigger = card?.querySelector("button");
      if (trigger == null) throw new Error("activity card trigger not found");
      fireEvent.click(trigger);
    }

    // The stubbed fetch never resolves, so the run view's output read stays
    // visibly in flight; the chat renders the same card with no output slot.
    expect(runView.container.textContent).toContain("Loading output…");
    expect(chat.container.textContent).not.toContain("Loading output…");
  });

  it("labels each settled machinery chain with its own event-time duration", () => {
    const events = [
      envelope(1, { type: "run-started", trigger: "message" }),
      { ...envelope(2, { type: "reasoning-start", blockId: "reasoning-0" }), at },
      {
        ...envelope(3, {
          type: "reasoning-delta",
          blockId: "reasoning-0",
          delta: "checking",
        }),
        at: "2026-07-19T12:00:02.000Z",
      },
      {
        ...envelope(4, { type: "reasoning-end", blockId: "reasoning-0" }),
        at: "2026-07-19T12:00:03.000Z",
      },
      {
        ...envelope(5, { type: "text-start", blockId: "text-0" }),
        at: "2026-07-19T12:00:04.000Z",
      },
      {
        ...envelope(6, { type: "text-delta", blockId: "text-0", delta: "I will check." }),
        at: "2026-07-19T12:00:05.000Z",
      },
      {
        ...envelope(7, { type: "text-end", blockId: "text-0" }),
        at: "2026-07-19T12:00:06.000Z",
      },
      {
        ...envelope(8, {
          type: "tool-start",
          callId: "call-1",
          name: "lookup",
          title: "Lookup",
          kind: "search",
        }),
        at: "2026-07-19T12:00:10.000Z",
      },
      {
        ...envelope(9, {
          type: "tool-result",
          callId: "call-1",
          status: "ok",
          summary: "found",
        }),
        at: "2026-07-19T12:00:16.000Z",
      },
      {
        ...envelope(10, { type: "run-finished", outcome: "completed", usage }),
        at: "2026-07-19T12:00:30.000Z",
      },
    ] satisfies FoldInput[];
    const fixture = { name: "independent chain timers", runId: "run-timers", events };
    const parityCase: ParityCase = {
      fixture,
      state: "completed",
      phase: "static",
      opening: null,
      mustRender: ["reasoning-block", "text-part", "activity-card"],
    };
    streams.set(fixture.runId, makeSnapshot(parityCase));

    const view = renderWithProviders(
      <RunBlock
        run={{
          id: fixture.runId,
          state: parityCase.state,
          trigger: "message",
          createdAt: at,
          openingMessage: null,
        }}
      />,
    );
    const labels = [...view.container.querySelectorAll('[data-slot="chain-of-thought-trigger"]')].map(
      (trigger) => trigger.textContent?.trim(),
    );

    expect(labels).toEqual(["Worked for 3s", "Worked for 6s"]);
  });
});
