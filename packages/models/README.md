# `@trema/models`

`@trema/models` implements the harness `ModelPort` with AI SDK v7. The package reads no environment variables. Callers pass named endpoints to `createSdkModelPort`.

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
