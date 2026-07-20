/** Supplies ISO 8601 timestamps for durable event envelopes. */
export interface Clock {
  /** Returns the current time as an ISO 8601 string. */
  now(): string;
}
