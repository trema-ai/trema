export type SurfaceErrorCategory =
  | "authentication"
  | "invalid-request"
  | "not-found"
  | "permanent"
  | "rate-limited"
  | "transient";

export class SurfaceDriverError extends Error {
  readonly category: SurfaceErrorCategory;
  readonly method: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: {
      category: SurfaceErrorCategory;
      cause?: unknown;
      method?: string;
      retryAfterMs?: number;
      retryable: boolean;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "SurfaceDriverError";
    this.category = options.category;
    this.method = options.method;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}
