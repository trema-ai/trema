import type { TranscriptMessage, Usage } from "../core/index.js";
import type {
  ContextSession,
  OpenSessionRequest,
  SearchContextResult,
  SessionSnapshot,
} from "../ports/index.js";

export class FakeContextSession implements ContextSession {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly #snapshot: SessionSnapshot;
  readonly #results = new Map<string, unknown>();

  constructor(snapshot: SessionSnapshot) {
    this.#snapshot = snapshot;
  }

  setResult(method: string, result: unknown): void {
    this.#results.set(method, result);
  }

  async open(request: OpenSessionRequest): Promise<SessionSnapshot> {
    this.#record("open", request);
    return this.#snapshot;
  }

  async renew(sessionId: string): Promise<void> {
    this.#record("renew", sessionId);
  }

  async close(sessionId: string, usage: Usage): Promise<void> {
    this.#record("close", sessionId, usage);
  }

  async reportMessages(sessionId: string, messages: TranscriptMessage[]): Promise<void> {
    this.#record("reportMessages", sessionId, messages);
  }

  async searchContext(sessionId: string, query: string, kinds?: string[], limit?: number): Promise<SearchContextResult[]> {
    this.#record("searchContext", sessionId, query, kinds, limit);
    return (this.#results.get("searchContext") as SearchContextResult[] | undefined) ?? [];
  }

  async getItem(sessionId: string, id: string): Promise<unknown> {
    return this.#result("getItem", sessionId, id);
  }

  async saveMemory(sessionId: string, type: string, title: string, content: string): Promise<unknown> {
    return this.#result("saveMemory", sessionId, type, title, content);
  }

  async updateMemory(sessionId: string, id: string, content: string): Promise<unknown> {
    return this.#result("updateMemory", sessionId, id, content);
  }

  async loadSkill(sessionId: string, name: string): Promise<unknown> {
    return this.#result("loadSkill", sessionId, name);
  }

  async useConnector(sessionId: string, toolKey: string, args: unknown, approvalId?: string): Promise<unknown> {
    return this.#result("useConnector", sessionId, toolKey, args, approvalId);
  }

  async proposeSkill(sessionId: string, name: string, description: string, body: string): Promise<unknown> {
    return this.#result("proposeSkill", sessionId, name, description, body);
  }

  async fetchTranscript(sessionId: string, conversationId: string, aroundSeq?: number, window?: number): Promise<unknown> {
    return this.#result("fetchTranscript", sessionId, conversationId, aroundSeq, window);
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  #result(method: string, ...args: unknown[]): unknown {
    this.#record(method, ...args);
    return this.#results.get(method);
  }
}
