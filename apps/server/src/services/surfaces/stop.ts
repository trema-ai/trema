import type { PrincipalRef } from "@trema/harness";

import type { RunServices } from "#server/services/runs/index.js";
import { IntentStateError, submitTargetIntent } from "#server/services/runs/trigger.js";
import type { RequestRunStop } from "#server/services/surfaces/render.js";

/**
 * Bridges a surface-native stop control into the same durable intent path used
 * by API clients. The principal should be the identity associated with the
 * surface recipient; Slack's native stop error does not include the clicker.
 */
export function createSurfaceStopRequester(
  services: RunServices,
  by: PrincipalRef,
): RequestRunStop {
  return async ({ intentId, runId }) => {
    try {
      await submitTargetIntent({
        services,
        input: { intentId, by, intent: { type: "stop", runId } },
      });
      return "recorded";
    } catch (error) {
      if (error instanceof IntentStateError && error.code === "run_not_active") {
        return "already_terminal";
      }
      throw error;
    }
  };
}
