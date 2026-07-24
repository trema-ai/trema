# `@trema/connectors`

`@trema/connectors` ships the connector provider catalog: one `ProviderDef` per provider, validated by zod, plus the loader and the OpenAPI-to-manifest tooling. Provider definitions are data — auth recipe, transport recipe, config and credential fields, and (for REST) a curated tool manifest. The server imports the catalog; it never defines providers of its own.

## Catalog policy

The catalog holds the ten tools startups reach for first, one entry per product:

- A provider gets an MCP entry when its official remote MCP server is generally available and at least as capable for org use as the REST path (service identity, scope control, API coverage). Tools then come from `tools/list` at sync time, not from this package.
- Otherwise the provider gets a REST entry with a hand-curated `toolManifest` — this covers vendors without a usable MCP server and vendors whose MCP server is beta, personal-scoped, or narrower than their REST API.

REST entries pin the provider's official machine-readable spec in `transport.openApiSpecUrl`. The link is provenance and regeneration input for the script below; nothing fetches it at runtime.

## Adding a REST provider

Author the definition in `src/providers/<key>.ts` and register it in `src/providers/index.ts`. The tool manifest is a curated subset — a 300-operation API becomes a handful of good tools, not 300 bad ones. To derive the manifest from the provider's OpenAPI 3.x spec:

```sh
# See what the spec offers (method, path, operationId, summary):
pnpm --filter @trema/connectors openapi-to-manifest -- ./spec.json --list

# Convert a curated selection; --format ts emits a paste-ready toolManifest:
pnpm --filter @trema/connectors openapi-to-manifest -- ./spec.json \
  --curation ./curation.yaml --format ts
```

A curation file names the operations and overrides what the spec gets wrong:

```yaml
tools:
  - operationId: listTickets
    name: search_tickets            # snake_case tool name
    description: Search open tickets.
  - method: POST
    path: /tickets
    sensitivity: write              # default heuristic: GET=read, DELETE=destructive, else write
```

Review the output before committing: trim descriptions, drop parameters the model does not need, and check sensitivity classes. `loadProviderCatalog` validates every entry at startup — template placeholders must reference declared config or credential fields, and hook names must exist in the registry.

Use `tool.baseUrl` only when an operation lives on a different API host than
`transport.baseUrl`. The optional URL replaces the transport base URL for that
tool. It accepts the same `${config.*}` and `${credentials.*}` placeholders as
the transport URL, and catalog validation checks every placeholder.

## Tests

```sh
pnpm --filter @trema/connectors test
pnpm --filter @trema/connectors typecheck
```
