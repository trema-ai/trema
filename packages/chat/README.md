# `@trema/chat`

Chat surface drivers that keep platform SDK types behind Trema-owned contracts.

The package groups each platform under its own source folder. The current Slack adapter establishes the pattern for Teams, Discord, and other chat surfaces.

## Run the evidence

Run the package checks from the repository root:

```sh
pnpm --filter @trema/chat typecheck
pnpm --filter @trema/chat test
pnpm --filter @trema/chat build
```

The package is not connected to production routing, persistence, or credentials.

## Evaluation

Read [the Slack adoption decision](./docs/slack-primitives.md) for compatibility, size, errors, fallbacks, and required contract changes.
