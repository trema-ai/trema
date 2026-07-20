import type { StopReason } from "@trema/harness";
import type { FinishReason } from "ai";

export function toStopReason(reason: FinishReason | "unknown"): StopReason {
  switch (reason) {
    case "stop": return "stop";
    case "tool-calls": return "toolUse";
    case "length": return "length";
    case "content-filter":
    case "error":
    case "other":
    case "unknown":
      return "error";
  }
}
