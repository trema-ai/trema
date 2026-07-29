import type { ProviderCatalog } from "@trema/connectors";

import type { Approval, ApprovalMode, Prisma } from "#server/generated/prisma/client.js";
import {
  CredentialDecryptionError,
  CredentialEncryptionConfigError,
} from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import type { ApprovalClassifier } from "#server/services/approvals/classifier.js";
import {
  ApprovalArgsMismatchError,
  ApprovalNotFoundError,
  ApprovalStateError,
  ApprovalValidationError,
  claimApprovalExecution,
  findToolGrant,
  hashApprovalArgs,
  requestApproval,
  requireApproval,
} from "#server/services/approvals/index.js";
import {
  ConnectorApprovalRequiredError,
  type ConnectorCallAuthority,
  ConnectorConnectionNotFoundError,
  type ConnectorFetch,
  ConnectorProviderNotFoundError,
  ConnectorReconnectRequiredError,
  ConnectorSsrfRejectedError,
  ConnectorToolNotAvailableError,
  ConnectorToolValidationError,
  ConnectorTransportError,
  executeConnectorTool,
  type McpClientFactory,
  type PlatformAppDirectory,
  type ResolvedConnectorTool,
  resolveConnectorTool,
} from "#server/services/connectors/index.js";
import { type DataPlaneSession, DataPlaneToolError } from "#server/services/dataplane/index.js";
import { resolveEffectiveMode } from "#server/services/policies/index.js";

/**
 * The namespace the built-in context approvals own.
 *
 * An `Approval.toolKey` for a connector call is the connector tool key
 * verbatim — `catalogKey:toolName`, the same string the model passes and the
 * same string a re-invocation carries — so the approve endpoint, the approvals
 * queue, and the policy resolver all read one vocabulary. `context:` is the
 * one namespace that is not a connector's, and a call may not claim it.
 */
const RESERVED_NAMESPACE = "context:";

export interface UseConnectorInput {
  toolKey: string;
  args: Record<string, unknown>;
  /** The model's one-line justification, shown to whoever approves the call. */
  reason: string;
  /** The approval a person granted for this exact call, on the second attempt. */
  approvalId?: string;
  /** Resolve the gate without touching the provider. Used by the run harness preflight. */
  authorizeOnly?: boolean;
  /**
   * The delegated-mode classifier, when one is configured. Absent, `delegated`
   * is unavailable and the gate degrades those sessions to `ask` — the safe
   * default needs no LLM.
   */
  classifier?: ApprovalClassifier;
  masterKey?: string;
  catalog?: ProviderCatalog;
  platformApps?: PlatformAppDirectory;
  fetch?: ConnectorFetch;
  clientFactory?: McpClientFactory;
  now?: Date;
}

export type UseConnectorResult =
  | {
      status: "authorized";
      toolKey: string;
      mode: ApprovalMode;
    }
  | {
      status: "executed";
      toolKey: string;
      /** The approval mode the call ran under. */
      mode: ApprovalMode;
      result: unknown;
      approvalId?: string;
    }
  | {
      status: "approval_required";
      toolKey: string;
      mode: ApprovalMode;
      approvalId: string;
      /** The classifier's one-line reason, when a delegated call escalated. */
      escalationReason?: string;
      expiresAt: string;
      message: string;
    };

/** How the audit stream records what became of one proxied call. */
type ConnectorCallOutcome = "executed" | "approval_required" | "failed";

interface AuditInput {
  session: DataPlaneSession;
  toolKey: string;
  argsHash: string;
  outcome: ConnectorCallOutcome;
  resolved?: ResolvedConnectorTool;
  /** The effective mode the gate resolved for this call, once it resolved one. */
  mode?: ApprovalMode;
  /** What let an executed call run. */
  authority?: ConnectorCallAuthority;
  approvalId?: string;
  errorCode?: string;
  durationMs: number;
}

/**
 * One entry per proxied call, whatever became of it — the uniform audit the
 * proxy boundary exists for. The arguments are the caller's content and the
 * provider's: only their fingerprint is recorded here, which is the same value
 * `services/approvals` stores, so an execution matches its approval by hash.
 *
 * The tuple the spec asks for names two people, not one: the agent principal
 * that made the call and the person the run was acting for. The second is what
 * turns "an agent read this inbox" into "an agent read this inbox for Dana",
 * and a surface identity with no principal behind it is recorded as itself.
 *
 * A failed write never throws: the audit records the call's outcome and must
 * not change it — not a completed side effect into a reported failure, not a
 * policy answer or a coded refusal into an unclassified error. The class of
 * the write's own failure is all that may be logged; its message is text
 * nobody redacted.
 */
async function recordCall(db: Database, input: AuditInput): Promise<void> {
  try {
    await writeCallRecord(db, input);
  } catch (error) {
    log.error("Connector audit write failed", {
      sessionId: input.session.id,
      toolKey: input.toolKey,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function writeCallRecord(db: Database, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      orgId: input.session.orgId,
      actorPrincipalId: input.session.actingPrincipalId,
      action: "dataplane.use_connector",
      subject: input.resolved?.installationItemId ?? input.session.id,
      payload: {
        sessionId: input.session.id,
        scopeId: input.session.scopeId,
        requesterPrincipalId: input.session.requesterPrincipalId,
        requesterExternalRef: input.session.requesterExternalRef,
        toolKey: input.toolKey,
        connector: input.resolved?.connectorKey ?? null,
        tool: input.resolved?.toolName ?? null,
        mode: input.mode ?? null,
        authority: input.authority ?? null,
        installationItemId: input.resolved?.installationItemId ?? null,
        argsHash: input.argsHash,
        outcome: input.outcome,
        approvalId: input.approvalId ?? null,
        errorCode: input.errorCode ?? null,
        durationMs: input.durationMs,
      } satisfies Prisma.InputJsonObject,
    },
  });
}

/**
 * The refusal a broken installation gets. The classes behind it — a connection
 * row that is gone, a provider key no catalog knows, a credential this
 * deployment cannot decrypt — are all the same thing to a run: nothing it did
 * caused them and nothing it does will clear them, so the code says so rather
 * than leaving the harness to read a generic failure as something to retry.
 * The message is fixed, because these errors quote server internals.
 */
const MISCONFIGURED_CODE = "connector_misconfigured";
const MISCONFIGURED_MESSAGE =
  "This connector is not set up correctly in this deployment, so the call cannot run. Say so and stop; retrying will not help.";

/** The audit's code for a failure, and "unknown" for one nobody classified. */
function failureCode(error: unknown): string {
  return describeConnectorFailure(error)?.code ?? "unknown";
}

/**
 * Every refusal on this path, as a code the harness can switch on and a message
 * the model can act on. Returns nothing for a failure nobody classified, which
 * the mount turns into its generic answer rather than repeating text it has not
 * inspected.
 */
export function describeConnectorFailure(
  error: unknown,
): { code: string; message: string } | undefined {
  if (
    error instanceof DataPlaneToolError ||
    error instanceof ConnectorToolNotAvailableError ||
    error instanceof ConnectorToolValidationError ||
    error instanceof ConnectorSsrfRejectedError ||
    error instanceof ConnectorTransportError ||
    error instanceof ConnectorApprovalRequiredError ||
    error instanceof ApprovalArgsMismatchError
  ) {
    return { code: error.code, message: error.message };
  }
  // `reconnect_needed` is the one a harness has to act on rather than retry: it
  // means send the person to the reconnect flow.
  if (error instanceof ConnectorReconnectRequiredError) {
    return { code: error.code, message: error.message };
  }
  if (
    error instanceof ConnectorConnectionNotFoundError ||
    error instanceof ConnectorProviderNotFoundError ||
    error instanceof CredentialDecryptionError ||
    error instanceof CredentialEncryptionConfigError
  ) {
    return { code: MISCONFIGURED_CODE, message: MISCONFIGURED_MESSAGE };
  }
  if (error instanceof ApprovalStateError) return { code: error.code, message: error.message };
  if (error instanceof ApprovalNotFoundError) {
    return { code: "approval_not_found", message: error.message };
  }
  if (error instanceof ApprovalValidationError) {
    return { code: "approval_invalid", message: error.message };
  }
  return undefined;
}

/**
 * What a granted approval will be spent on: the installation that serves the
 * call and the connection whose credential it carries.
 *
 * Both are read from the resolution the approver's decision was made about, and
 * both are re-read from a fresh resolution when the decision is claimed. That
 * pair is the smallest thing that can change underneath an approval and change
 * what the call actually does — repointing an installation at another
 * connection swaps the credential without touching the tool, the arguments, or
 * the session.
 */
interface ExecutionBinding {
  installationItemId: string;
  connectionId: string;
}

function executionBinding(resolved: ResolvedConnectorTool): ExecutionBinding {
  return {
    installationItemId: resolved.installationItemId,
    connectionId: resolved.body.connectionId,
  };
}

/**
 * Whether the approval still covers what a fresh resolution says will run.
 *
 * An approval with no recorded binding never matches a connector call: nothing
 * says the two agree, and "nothing said otherwise" is not how a decision about
 * a credential is inherited.
 */
function bindingHolds(approval: Approval, expected: ExecutionBinding): boolean {
  const recorded = approval.executionBinding;
  if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) return false;
  return (
    recorded.installationItemId === expected.installationItemId &&
    recorded.connectionId === expected.connectionId
  );
}

/**
 * Proxy one connector call for a running session.
 *
 * Everything that decides whether the call may happen sits here, on the far
 * side of the harness: the installation the session's scope chain resolves
 * to, and the approval gate — the requester's chosen mode clamped to the
 * pinned policy ceiling, thread grants, and in delegated mode the call-time
 * classifier. A call the gate pauses comes back as `approval_required` with
 * an id, which is a result and not an error — the harness renders the
 * prompt, relays the decision, and calls again with the id and the same
 * arguments.
 *
 * The approve round trip re-resolves everything from the database, so the call
 * that executes is checked against the call that was approved rather than
 * assumed to be it: same session, same tool key, same arguments, and the same
 * installation and connection. An admin who repoints an installation while a
 * person is deciding invalidates the decision rather than silently
 * redirecting it, and the run is told to ask again.
 *
 * The second call claims the approval before the provider is touched, so a
 * provider that answers slowly or not at all still costs exactly one
 * execution. A failure after the claim keeps it: out here nothing can prove the
 * call did not reach the provider, and "it might have run" is what at-most-once
 * refuses to retry.
 *
 * Every call that gets past its own arguments leaves exactly one audit row,
 * including the ones that fail before anything is resolved. A proxy boundary
 * whose refusals are invisible is not an audit trail.
 */
export async function useConnector(
  db: Database,
  session: DataPlaneSession,
  input: UseConnectorInput,
): Promise<UseConnectorResult> {
  const startedAt = Date.now();
  const toolKey = input.toolKey.trim();
  const args = input.args;
  const argsHash = hashApprovalArgs(args);
  const elapsed = () => Date.now() - startedAt;
  let resolved: ResolvedConnectorTool | undefined;
  let mode: ApprovalMode | undefined;
  let authority: ConnectorCallAuthority | undefined;
  const approvalId: string | undefined = input.approvalId;

  try {
    if (toolKey.startsWith(RESERVED_NAMESPACE)) {
      throw new DataPlaneToolError(
        "connector_tool_not_available",
        `'${RESERVED_NAMESPACE}' names this app's own operations, not a connector`,
      );
    }
    const engineInput = {
      orgId: session.orgId,
      scopeChain: session.scopeChain,
      sessionScopeKind: session.scopeKind,
      principalId: session.actingPrincipalId,
      toolKey,
      args,
      ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
      ...(input.platformApps ? { platformApps: input.platformApps } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
      ...(input.now ? { now: input.now } : {}),
    };

    resolved = await resolveConnectorTool(db, engineInput);
    const binding = executionBinding(resolved);
    // The requester's chosen mode, clamped to the pinned ceiling. An untrusted
    // catalog entry pins to `ask` whatever the rows say, and `delegated`
    // degrades to `ask` when no classifier is configured.
    mode = resolveEffectiveMode({
      rows: session.policyRows,
      scopeChain: session.scopeChain,
      connectorKey: resolved.connectorKey,
      connectorTrusted: resolved.provider.trusted === true,
      requestedMode: session.approvalMode,
      classifierAvailable: input.classifier !== undefined,
    });
    let escalationReason: string | undefined;

    if (approvalId) {
      const approval = await requireApproval(db, session.orgId, approvalId);
      // The approval names one call in one session. `claimApprovalExecution`
      // binds the arguments and the single execution; these two clauses are
      // what stop an approval granted for one tool, or granted to another run,
      // from covering this one.
      if (approval.sessionId !== session.id || approval.toolKey !== toolKey) {
        throw new DataPlaneToolError(
          "approval_mismatch",
          "That approval was granted for a different call",
        );
      }
      // And this one stops the call from changing underneath a decision that
      // has already been made. It runs before the claim: an approval refused
      // here was never spent, so a person can grant the changed call afresh.
      // The resolution compared here is the resolution the execution below is
      // pinned to, so a repoint landing between the two runs the call against
      // the pair the approver saw — never the repointed one.
      if (!bindingHolds(approval, binding)) {
        log.warn("Approval no longer matches its call", {
          approvalId,
          sessionId: session.id,
          toolKey,
        });
        throw new DataPlaneToolError(
          "approval_superseded",
          "The approved call changed underneath its approval — ask again",
        );
      }
      if (!input.authorizeOnly) {
        await claimApprovalExecution(db, {
          orgId: session.orgId,
          approvalId,
          args,
          ...(input.now ? { now: input.now } : {}),
        });
      }
      authority = "approval_claimed";
    } else if (mode === "full") {
      authority = "mode_full";
    } else {
      // A person may already have widened their consent: a thread grant from
      // this session, or a standing grant for this requester. Either skips
      // the gate in both remaining modes.
      const grant = await findToolGrant(db, {
        orgId: session.orgId,
        toolKey,
        sessionId: session.id,
        scopeChain: session.scopeChain,
        requesterPrincipalId: session.requesterPrincipalId,
      });
      if (grant) {
        authority = "thread_grant";
      } else if (mode === "delegated" && input.classifier) {
        // The classifier's one power is to add a pause. A judge that throws
        // is an escalation — delegated mode fails open only on an explicit
        // `proceed`, never on an error.
        const verdict = await input.classifier
          .judge({
            toolKey,
            connectorKey: resolved.connectorKey,
            toolName: resolved.toolName,
            ...(resolved.description ? { description: resolved.description } : {}),
            ...(resolved.annotations ? { annotations: resolved.annotations } : {}),
            args,
            scopeKind: session.scopeKind,
          })
          .catch((error: unknown) => {
            log.warn("Approval classifier failed; escalating", {
              sessionId: session.id,
              toolKey,
              errorName: error instanceof Error ? error.name : typeof error,
            });
            return {
              verdict: "escalate",
              reason: "The classifier could not judge this call",
            } as const;
          });
        if (verdict.verdict === "proceed") {
          authority = "delegated_proceed";
        } else {
          escalationReason = verdict.reason;
        }
      }
    }

    if (authority === undefined) {
      const requested = await requestApproval(db, {
        orgId: session.orgId,
        sessionId: session.id,
        toolKey,
        mode,
        ...(escalationReason ? { escalationReason } : {}),
        connectorKey: resolved.connectorKey,
        args,
        reason: input.reason,
        executionBinding: { ...binding },
        ...(input.now ? { now: input.now } : {}),
      });
      await recordCall(db, {
        session,
        toolKey,
        argsHash,
        outcome: "approval_required",
        resolved,
        mode,
        approvalId: requested.approval.id,
        durationMs: elapsed(),
      });
      return {
        status: "approval_required",
        toolKey,
        mode,
        approvalId: requested.approval.id,
        ...(requested.approval.escalationReason
          ? { escalationReason: requested.approval.escalationReason }
          : {}),
        expiresAt: requested.approval.expiresAt.toISOString(),
        message:
          "A person has to approve this call. Say so and stop here; once it is approved, call again with the same arguments and this approvalId.",
      };
    }

    if (input.authorizeOnly) {
      return { status: "authorized", toolKey, mode };
    }

    const result = await executeConnectorTool(db, { ...engineInput, resolved, authority });
    await recordCall(db, {
      session,
      toolKey,
      argsHash,
      outcome: "executed",
      resolved,
      mode,
      authority,
      ...(approvalId ? { approvalId } : {}),
      durationMs: elapsed(),
    });
    return {
      status: "executed",
      toolKey,
      mode,
      result,
      ...(approvalId ? { approvalId } : {}),
    };
  } catch (error) {
    // Every refusal and every failure lands here, so every one of them is
    // recorded once. A claimed approval is deliberately not released: the
    // request left this process, so nothing here can prove the provider did
    // not act on it.
    await recordCall(db, {
      session,
      toolKey,
      argsHash,
      outcome: "failed",
      ...(resolved ? { resolved } : {}),
      ...(mode ? { mode } : {}),
      ...(authority ? { authority } : {}),
      ...(approvalId ? { approvalId } : {}),
      errorCode: failureCode(error),
      durationMs: elapsed(),
    });
    log.warn("Connector proxy call failed", {
      sessionId: session.id,
      toolKey,
      ...(resolved ? { connector: resolved.connectorKey, tool: resolved.toolName } : {}),
      errorCode: failureCode(error),
    });
    throw error;
  }
}
