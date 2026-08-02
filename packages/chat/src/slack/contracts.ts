export type SlackToken = string | (() => Promise<string> | string);

export interface SlackDriverOptions {
  signingSecret?: string;
  token: SlackToken;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  nativeCall?: (
    method: string,
    arguments_: Record<string, unknown>,
    token: string,
  ) => Promise<unknown>;
}
