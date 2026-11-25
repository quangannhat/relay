# Relay

Relay is a local-first coordination engine for independent agents and humans.
This is a Bun monorepo. `relay-core` contains the Phase 1 vertical slice:
Effect services, durable
SQLite state, atomic claims, persisted events, and filtered live subscriptions.
`relay-tui` is the primary human client and currently provides a minimal
browse-only terminal view over the core service boundary.

## Architecture

```text
packages/relay-core/src/domain.ts  -> schemas and domain types
packages/relay-core/src/store.ts   -> SQLite source of truth
packages/relay-core/src/engine.ts  -> coordination operations and PubSub delivery
packages/relay-core/src/main.ts    -> deterministic simulated-agent demonstration
packages/relay-core/test/          -> behavior tests
packages/relay-tui/src/main.ts     -> primary human client
```

The engine publishes only after a database commit. Task claiming uses a
conditional SQL update inside a SQLite transaction, so concurrent agents
cannot both claim a pending task. Event IDs are SQLite autoincrement values
and can be replayed with `getEvents(afterId)`. Live subscriptions are
best-effort low-latency delivery; persisted events are the reconnect path.

MCP, daemon/RPC, and TUI adapters are intentionally deferred until the core
service boundary is stable.

## Run

Requires Bun 1.1+.

```sh
bun install
bun test
bun run core
bun run tui
```

`bun run core` creates `relay.db`, registers a repository, runs a simulated
claim/progress/completion flow, and demonstrates a filtered completion
subscription. Delete `relay.db` to start the demonstration from scratch.
