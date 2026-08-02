/** Platform-neutral capabilities consumed by Trema's renderer core. */
export interface CapabilityDescriptor {
  mutation: "append-only" | "edit" | "render-once";
  streaming: "delta" | "none" | "snapshot";
  dialect: "commonmark" | "mrkdwn" | "plain";
  affordances: {
    buttons: boolean;
    files: boolean;
    presence: boolean;
    reactions: boolean;
    threads: boolean;
  };
  budgets: {
    actionsPerMessage?: number;
    firstPaintMs: number;
    flushIntervalMs: number;
    messageChars: number;
  };
  quirks: {
    blocksOnlyAtFinal?: boolean;
    ephemeralImmutable?: boolean;
    updateAppends?: readonly string[];
  };
}

export interface SurfaceRef {
  surface: string;
  locationRef: string;
  channelRef: string;
  threadRef: string;
  teamRef?: string;
  recipient?: {
    teamRef: string;
    userRef: string;
  };
}

export interface ElicitationContent {
  id: string;
  prompt: string;
  options: readonly {
    id: string;
    label: string;
    style?: "danger" | "primary";
  }[];
}

export interface MessageContent {
  markdown: string;
  elicitation?: ElicitationContent;
}

interface OperationBase {
  operationId: string;
}

export interface PostOperation extends OperationBase {
  type: "post";
  content: MessageContent;
}

export interface ReplaceOperation extends OperationBase {
  type: "replace";
  messageRef: string;
  content: MessageContent;
}

export interface StartStreamOperation extends OperationBase {
  type: "stream-start";
  initialMarkdown: string;
}

export interface AppendStreamOperation extends OperationBase {
  type: "stream-append";
  messageRef: string;
  deltaMarkdown: string;
}

export interface StopStreamOperation extends OperationBase {
  type: "stream-stop";
  messageRef: string;
  finalMarkdown?: string;
  elicitation?: ElicitationContent;
}

export type RenderOperation =
  | AppendStreamOperation
  | PostOperation
  | ReplaceOperation
  | StartStreamOperation
  | StopStreamOperation;

export interface AppliedOperation {
  operationId: string;
  messageRef: string;
}

export interface ApplyResult {
  applied: AppliedOperation[];
}

export interface SurfaceRenderDriver {
  readonly capabilities: CapabilityDescriptor;
  apply(operations: readonly RenderOperation[], surface: SurfaceRef): Promise<ApplyResult>;
  callNative(method: string, arguments_: Record<string, unknown>): Promise<unknown>;
}

export interface DeliveryRetry {
  attempt: number;
  reason?: string;
}

interface SurfaceEventBase {
  surface: string;
  retry?: DeliveryRetry;
}

export interface ChallengeSurfaceEvent extends SurfaceEventBase {
  type: "challenge";
  challenge: string;
}

export interface MessageSurfaceEvent extends SurfaceEventBase {
  type: "message";
  intentId: string;
  surfaceRef: SurfaceRef;
  authorRef: string;
  text: string;
  at: string;
  nativeKind: string;
}

export interface InteractionSurfaceEvent extends SurfaceEventBase {
  type: "interaction";
  intentId: string;
  surfaceRef?: SurfaceRef;
  authorRef: string;
  action:
    | { type: "resolve"; elicitationId: string; optionId: string }
    | { type: "stop"; runId: string }
    | { type: "native"; actionId: string; value?: string };
}

export interface UnsupportedSurfaceEvent extends SurfaceEventBase {
  type: "unsupported";
  nativeType: string;
  nativePayload: unknown;
}

export type SurfaceEvent =
  | ChallengeSurfaceEvent
  | InteractionSurfaceEvent
  | MessageSurfaceEvent
  | UnsupportedSurfaceEvent;

export interface SurfaceIngressDriver {
  read(request: Request): Promise<SurfaceEvent>;
}
