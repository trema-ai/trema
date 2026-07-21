import type { ToolDef, TranscriptMessage, Usage } from "#/core/index.js";

/** Instructions, rules, and available skills fixed for a context session. */
export interface SessionStanding {
  instructions: string;
  rules: Array<{ id: string; type: string; content: string }>;
  skillIndex: Array<{ name: string; description: string }>;
}

/** Context and tools resolved when a session opens. */
export interface SessionSnapshot {
  sessionId: string;
  mode: "service" | "delegated";
  /** Opaque hierarchy used to resolve the session. */
  scopeChain: unknown[];
  standing: SessionStanding;
  tools: ToolDef[];
  /** Opaque policy state fixed for this session. */
  policySnapshot: unknown;
  /** Stable identifier for the resolved snapshot contents. */
  snapshotHash: string;
}

/** Identity and location used to resolve a context session. */
export interface OpenSessionRequest {
  surface: string;
  locationRef: unknown;
  requester: { externalUserId: string } | { principalId: string };
}

/** Ranked context item returned by a session search. */
export interface SearchContextResult {
  id: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
}

/** Provides context, memory, connectors, approvals, and feedback for a run. */
export interface ContextSession {
  /** Resolves a new session snapshot for the request. */
  open(request: OpenSessionRequest): Promise<SessionSnapshot>;
  /** Extends the lifetime of an existing session. */
  renew(sessionId: string): Promise<void>;
  /** Finalizes a session with its aggregate usage. */
  close(sessionId: string, usage: Usage): Promise<void>;
  /** Reports committed transcript messages to the session. */
  reportMessages(sessionId: string, messages: TranscriptMessage[]): Promise<void>;
  /** Searches context visible to the session, optionally filtered by kind. */
  searchContext(
    sessionId: string,
    query: string,
    kinds?: string[],
    limit?: number,
  ): Promise<SearchContextResult[]>;
  /** Loads one context item visible to the session. */
  getItem(sessionId: string, id: string): Promise<unknown>;
  /** Creates a memory item in the session's scope. */
  saveMemory(sessionId: string, type: string, title: string, content: string): Promise<unknown>;
  /** Replaces the content of a memory item. */
  updateMemory(sessionId: string, id: string, content: string): Promise<unknown>;
  /** Loads a named skill visible to the session. */
  loadSkill(sessionId: string, name: string): Promise<unknown>;
  /** Invokes a connector with an optional resolved approval. */
  useConnector(
    sessionId: string,
    toolKey: string,
    args: unknown,
    approvalId?: string,
  ): Promise<unknown>;
  /** Proposes a skill for the session's scope. */
  proposeSkill(
    sessionId: string,
    name: string,
    description: string,
    body: string,
  ): Promise<unknown>;
  /** Fetches transcript context around an optional event sequence. */
  fetchTranscript(
    sessionId: string,
    conversationId: string,
    aroundSeq?: number,
    window?: number,
  ): Promise<unknown>;
  /** Applies an approval decision and its persistence scope. */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: "approved" | "denied",
    scope: "once" | "run" | "always",
  ): Promise<void>;
  /** Proposes persistent policy for a tool after an `always` resolution. */
  proposePolicyEdit(sessionId: string, toolKey: string): Promise<void>;
  /** Reports feedback associated with a completed run. */
  reportFeedback(sessionId: string, runId: string, value: string): Promise<void>;
}
