# `@trema/projection`

`@trema/projection` is the shared fold from a run's event log to its message projection ([interface 02](../../../wiki/docs/specs/interface/02-messages.md)): segments of ordered, typed parts. Every consumer — the chat thread, the run view, tests — folds through this one code path, so a rendering discrepancy between surfaces is provably a renderer bug.

The package is browser-safe. It depends only on `@trema/harness` for the event schema, and touches no Node globals, no database, and no React.

## API

```ts
fold(runId: string, events: readonly FoldInput[]): Projection
advance(projection: Projection, newEvents: readonly FoldInput[]): Projection
```

`FoldInput` is `{ seq, at, event }` — the envelope shape both read paths deliver, with `event` as the recorded payload, possibly of an unknown type. The fold is pure, deterministic, and total: unknown event types and malformed known payloads are skipped and counted in `Projection.unknownEvents`, never thrown.

`advance` is the incremental path. `fold(runId, all)` equals `advance(fold(runId, first), rest)` at every split point, and events at or below `Projection.lastSeq` are skipped, so re-delivered pages and reconnecting SSE tails are idempotent. The input projection is never mutated; the result is a fresh object sharing untouched segments and parts by reference, which gives React consumers referential change detection.

## Fold rules

- A `*-delta` without its `*-start` opens the block implicitly (crash-write tolerance).
- Lifecycle events (`run-started`, `turn-finished`, `segment-end`, `run-finished`) settle every still-streaming part; `turn-finished` with an error or aborted stop records an error result on unresolved activities.
- `segment-end` closes the current segment; later parts open the next one. An empty trailing segment is never materialized.
- Elicitation parts mutate in place when their resolution lands, wherever they sit; orphan resolutions are tolerated.
- Durable `data` parts reconcile by id; transient `data` events never become parts.
- `Projection.status` mirrors lifecycle events only: `pending`, `running`, `paused`, then `completed`, `failed`, or `cancelled` from `run-finished`.
- The fold allocates no presentation state. Budget math and formatting belong to renderers.

## Golden tests

Fixture logs in `tests/fixtures.ts` replicate the harness emitter sequences — the full event inventory, the park/resolve/resume run, follow-up absorption, and a gated tool batch — each with a checked-in expected `Projection` asserted by deep equality. The projection is the contract: a change to the fold that alters any expected literal is a contract change and must be reviewed as one.

## Stability

This package is pre-release. Its API is not yet stable.
