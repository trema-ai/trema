import type { ScopeKind } from "#server/generated/prisma/client.js";
import type { ToolAnnotations } from "#server/services/connectors/installations.js";

/**
 * One call as the delegated-mode classifier sees it. Everything the provider
 * authored — the description, the annotations — is untrusted input: a
 * malicious server writes exactly the description that reads as harmless, so
 * the classifier's prompt treats this as evidence to weigh, never as an
 * instruction to follow.
 */
export interface ApprovalClassifierCall {
  toolKey: string;
  connectorKey: string;
  toolName: string;
  description?: string;
  annotations?: ToolAnnotations;
  args: unknown;
  scopeKind: ScopeKind;
}

export type ApprovalClassifierVerdict =
  | { verdict: "proceed" }
  | { verdict: "escalate"; reason: string };

/**
 * The call-time classifier behind `delegated` mode.
 *
 * Its one power is to add a pause: `escalate` turns the call into an
 * interrupt; `proceed` lets a call the deterministic layer already authorized
 * run without one. It can never widen access. Conservative bias is part of
 * the contract — uncertain is `escalate` — and so is failing closed: a judge
 * that throws is treated as an escalation by the caller.
 *
 * No implementation ships yet. The gate treats an absent classifier as
 * `delegated` being unavailable, so every session runs `ask` (or `full`
 * where policy grants it) until the satellite-model wiring lands
 * (wiki docs/plans/context-implementation.md, step 17).
 */
export interface ApprovalClassifier {
  judge(call: ApprovalClassifierCall): Promise<ApprovalClassifierVerdict>;
}
