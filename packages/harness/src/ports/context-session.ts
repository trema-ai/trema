import type { ToolDef, TranscriptMessage, Usage } from "../core/index.js";

export interface SessionStanding {
  instructions: string;
  rules: Array<{ id: string; type: string; content: string }>;
  skillIndex: Array<{ name: string; description: string }>;
}

export interface SessionSnapshot {
  sessionId: string;
  mode: "service" | "delegated";
  scopeChain: unknown[];
  standing: SessionStanding;
  tools: ToolDef[];
  policySnapshot: unknown;
  snapshotHash: string;
}

export interface OpenSessionRequest {
  surface: string;
  locationRef: unknown;
  requester: { externalUserId: string } | { principalId: string };
}

export interface SearchContextResult {
  id: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
}

export interface ContextSession {
  open(request: OpenSessionRequest): Promise<SessionSnapshot>;
  renew(sessionId: string): Promise<void>;
  close(sessionId: string, usage: Usage): Promise<void>;
  reportMessages(sessionId: string, messages: TranscriptMessage[]): Promise<void>;
  searchContext(sessionId: string, query: string, kinds?: string[], limit?: number): Promise<SearchContextResult[]>;
  getItem(sessionId: string, id: string): Promise<unknown>;
  saveMemory(sessionId: string, type: string, title: string, content: string): Promise<unknown>;
  updateMemory(sessionId: string, id: string, content: string): Promise<unknown>;
  loadSkill(sessionId: string, name: string): Promise<unknown>;
  useConnector(sessionId: string, toolKey: string, args: unknown, approvalId?: string): Promise<unknown>;
  proposeSkill(sessionId: string, name: string, description: string, body: string): Promise<unknown>;
  fetchTranscript(sessionId: string, conversationId: string, aroundSeq?: number, window?: number): Promise<unknown>;
}
