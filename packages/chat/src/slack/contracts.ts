import type { SurfaceApplyContext } from "@trema/surfaces";

export type SlackToken = string | (() => Promise<string> | string);

export interface SlackRecipient {
  teamRef: string;
  userRef: string;
}

export interface SlackDriverOptions {
  signingSecret?: string;
  token: SlackToken;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  minRequestIntervalMs?: number;
  recipient?:
    | SlackRecipient
    | ((
        context: SurfaceApplyContext,
      ) => Promise<SlackRecipient | undefined> | SlackRecipient | undefined);
  nativeCall?: (
    method: string,
    arguments_: Record<string, unknown>,
    token: string,
  ) => Promise<unknown>;
}
