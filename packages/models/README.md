# `@trema/models`

`@trema/models` implements the harness `ModelPort` with AI SDK v7. The package reads no environment variables. Callers pass named endpoints to `createSdkModelPort`.

## The model port

The harness never calls a model provider directly. Every model request goes through `ModelPort`, a narrow interface that `@trema/harness` defines. The interface has two methods: `streamTurn` runs one tool-using turn, and `complete` generates plain text.

The port exists to keep provider details out of the run loop. Authentication, wire formats, stream chunks, and finish reasons stay behind the port. The port accepts the durable transcript and tool definitions, and returns provider-neutral run events, a stop reason, and usage.

This boundary makes the model a replaceable part. Stored runs, transcripts, and events use a provider-neutral format, so a provider change is a configuration change. No stored data needs a migration.

`@trema/models` is the default implementation of this port. It maps harness requests onto AI SDK v7 calls and maps stream chunks back to run events. A host that needs a provider this package does not cover can implement `ModelPort` against the same contract.

## Usage

Create a model port with an endpoint map:

```ts
import { createSdkModelPort } from "@trema/models";

const apiKey = process.env.MODEL_API_KEY;
if (apiKey === undefined) {
  throw new Error("Set MODEL_API_KEY before creating the model port.");
}

const modelPort = createSdkModelPort({
  endpoints: {
    primary: {
      protocol: "openai-compatible",
      baseUrl: "https://models.example.com/v1",
      apiKey,
      headers: {
        "X-Application": "trema-support",
      },
    },
  },
});
```

Pass `modelPort` to the harness run loop or lifecycle integration.

## Configuration

### Select an endpoint

`ModelRef.provider` selects a name from the endpoint map. You may omit it when the map contains exactly one endpoint.

Zero endpoints cause an error when `ModelRef.provider` is absent. Multiple endpoints also require `ModelRef.provider`. An unknown provider causes an error.

This release supports the `openai-compatible` protocol. The package isolates each protocol resolver in `src/resolvers/`.

Future provider packages do not affect transcript or stream mapping.

### Configure thinking levels

Thinking is opt-in. `thinkingLevelMap` keys are model identifier glob patterns. `*` matches any sequence, and insertion order wins.

The first matching entry must list the requested level. Otherwise, thinking degrades to `off`, and the port sends no reasoning option.

### Mediate outbound traffic

Set `fetch` when your host mediates outbound model traffic. The port passes this implementation to the selected endpoint resolver.

## Stability

This package is pre-release. Its API is not yet stable.
