# `@trema/models`

AI SDK v7 implementation of the harness `ModelPort`. The package reads no
environment variables: callers provide a map of named endpoints to
`createSdkModelPort`.

`ModelRef.provider` selects a name in that map. Omitting it is allowed only
when exactly one endpoint is configured; zero or multiple endpoints are an
error. This release supports the `openai-compatible` protocol. Each protocol
has an isolated resolver under `src/resolvers/` so future provider packages do
not affect transcript or stream mapping.

Thinking is opt-in. `thinkingLevelMap` keys are model-id glob patterns (`*` is
the wildcard), evaluated in insertion order. A requested level is sent only
when the first matching entry explicitly lists that level; otherwise thinking
degrades to off and no reasoning option is sent.
