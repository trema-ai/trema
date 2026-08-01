# Chat SDK Slack primitives decision

## Decision

Adopt Chat SDK 4.35.0 low-level Slack subpaths behind Trema-owned interfaces.

Reject the full Chat runtime and its state, installation, subscription, lock, queue, and plan abstractions.

The primitives remove useful protocol code without owning Trema routing or durability. Two gaps need explicit Trema handling: retries and complete markdown conversion.

## Licensing placement

The Slack adapter is part of the AGPL core. Using Slack does not require a commercial entitlement.

Commercial licensing applies only when an organization adds seats. Surface capabilities and shared-scope Slack behavior stay in the core package.

## Evidence

The slice implements signed ingress and outbound rendering through four isolated imports.

| Primitive | Tested behavior | Result |
| --- | --- | --- |
| `webhook` | Signature verification, five-minute replay rejection, Events API parsing, URL challenges, and Block Kit interaction parsing | Adopt |
| `format` | Bold conversion and Slack user ID linking | Adopt as helpers only |
| `api` | Threaded post, message update, thread replies, and generic Web API calls | Adopt |
| `blocks` | Elicitation buttons and interaction round-trip | Adopt |
| `api` generic call | Streaming start, append, and stop | Adopt with Trema wrappers |

The generated public declarations contain no Chat SDK or Slack SDK types. Upstream objects end inside this package.

## Driver boundary

The slice uses a draft of the platform-neutral driver boundary:

```ts
interface SurfaceRenderDriver {
  capabilities: CapabilityDescriptor
  apply(operations: RenderOperation[], surface: SurfaceRef): Promise<ApplyResult>
  callNative(method: string, arguments: Record<string, unknown>): Promise<unknown>
}

interface SurfaceIngressDriver {
  read(request: Request): Promise<SurfaceEvent>
}
```

The driver receives remote references and returns every created message reference. It does not persist cursors, operations, or realization state.

## Package and runtime

| Property | Validated value |
| --- | --- |
| Chat SDK package | `@chat-adapter/slack` 4.35.0 |
| Official fallback client | `@slack/web-api` 7.19.0 |
| Chat SDK license | MIT |
| Official client license | MIT |
| Declared Chat SDK runtime | Node.js 20 or newer |
| Trema runtime tested | Node.js 24.8.0, ECMAScript modules |
| Low-level JavaScript files | 50,866 bytes total, unminified |
| Installed Chat SDK package body | 340 KiB |
| Installed official client body | 7,808 KiB |

The size figures use local allocated file sizes. They exclude shared transitive packages and package-manager metadata.

The low-level imports do not load the full runtime graph. The [upstream boundary](https://chat-sdk.dev/docs/slack-primitives#import-boundaries) excludes the Chat runtime and Slack SDKs at import time.

The npm package is not a package-size split. Installation still brings the full adapter dependency set, including Chat, Socket Mode, and the official Web API client.

Trema already requires Node.js 24. Chat SDK's Node.js 20 minimum and web-standard request APIs are compatible.

## Errors and rate limits

The low-level API helper distinguishes HTTP failures from Slack platform failures. It throws `SlackApiError` for both after explicit `assertSlackOk` calls.

The helper performs one request. It does not retry, throttle, set a timeout, or expose an abort signal.

Slack returns HTTP 429 with a `Retry-After` header. The helper drops response headers when it creates its error.

The slice wraps the injected fetch function and preserves this header as `retryAfterMs`. Trema errors also carry a stable category and retryable flag.

| Failure | Trema category | Retryable |
| --- | --- | --- |
| HTTP 429 or `ratelimited` | `rate-limited` | Yes, after `retryAfterMs` |
| HTTP 5xx or transport error | `transient` | Yes |
| Revoked or invalid token | `authentication` | No |
| Deleted message or channel | `not-found` | No |
| Other Slack platform error | `permanent` | No |
| Invalid signature or body | `invalid-request` | No |

The renderer core must own retry scheduling, throttling, coalescing, and cursor commits. Slack applies limits per method and workspace. See [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

## Missing primitives and fallbacks

| Gap | Fallback |
| --- | --- |
| No typed low-level stream helpers | Call `chat.startStream`, `chat.appendStream`, and `chat.stopStream` through `callSlackApi` |
| No complete CommonMark-to-mrkdwn conversion | Keep conversion in Trema and use Slack `markdown_text` where valid |
| No parser result for every Slack event | Treat `unsupported` as untrusted input and validate the required raw event in Trema |
| No wrapped Slack method | Call the official client's `WebClient.apiCall` through `callNative` |
| No retry or timeout policy | Return classified errors to the renderer core |

Slack documents recipient IDs for channel streams and Block Kit only on stream completion. See [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream/).

The native fallback creates a short-lived official client. It disables client retries and rejects rate limits so Trema remains the retry owner.

## Required contract changes

The final platform-neutral contracts need these fields:

- A surface reference with installation, location, channel, thread, and optional recipient references.
- Render operations for post, replace, stream start, delta append, stop, and delete.
- An apply result containing the remote message reference for every successful operation.
- A stable error category, retryable flag, method, and optional retry delay.
- Capabilities for delta streaming, final-only blocks, limits, and append-style quirks.
- An ingress result that preserves a stable delivery ID before routing or intent classification.

The final ingress contract must not force the adapter to choose between a new message and steering. Trema dispatch makes that decision from durable run state.

The final rendering contract must pass committed deltas. Slack streaming remains an optimization over persisted projection state.

## Scope exclusions

This slice does not own OAuth, token storage, subscriptions, deduplication, queues, leases, cursors, retries, or durable realizations.

It does not connect a route or worker. Later production work can replace the draft contracts without changing the validated SDK boundary.
