# Relay implementation progress

Last updated: 2026-11-26

Use this file as the pickup note for future sessions. The project brief and
implementation roadmap are in the conversation that initiated the project;
this note records the current repository state and the next bounded work.

## Current state

- Bun/TypeScript monorepo with `relay-core` and a minimal `relay-tui`.
- Effect 3 is used for domain schemas, services, Layers, PubSub, queues, and
  scoped lifetimes. The lockfile resolves Effect 3.22.5.
- Persistence currently uses Bun's built-in `bun:sqlite`, not Effect SQL.
  Keep SQLite as the source of truth; the current dependency set does not
  include an Effect SQL driver.
- Core code:
  - `packages/relay-core/src/domain.ts`: repository, task, and event schemas.
  - `packages/relay-core/src/store.ts`: SQLite schema and persistence adapter.
  - `packages/relay-core/src/engine.ts`: coordination service and live event
    delivery.
  - `packages/relay-core/src/main.ts`: simulated-agent demo.
  - `packages/relay-core/test/engine.test.ts`: behavior tests.
- `README.md` has the quick-start commands and architecture summary.

## Completed

- Phase 1 vertical slice: repository registration; task creation/listing;
  atomic task claiming; task transitions; durable task/event storage; live
  event publication.
- Reactive coordination basics: filtered subscriptions, condition-based task
  waiting, incremental event retrieval, dependency blocking/unblocking.
- Restart test verifies task state and event history survive reopening SQLite.
- Task mutations, progress reports, and artifact publications now save their
  state and corresponding event in one SQLite transaction. The event is
  broadcast only after commit.
- Task rows now carry an optimistic `revision`. Updates use a conditional SQL
  write, so a stale writer gets a conflict and does not append an event. The
  store migrates existing databases by adding the revision column.
- Waiter interruption has a behavior test.
- Completing a task and unblocking all newly-ready dependents now runs in a
  single transaction. A stale revision in any dependent rolls the whole
  operation back; live notifications are sent only after commit.
- Last verification: `bun test` (11 passing, including an MCP stdio integration
  flow) and `bun run build` (all packages pass).

## MCP integration test

- `packages/relay-mcp/test/stdio.test.ts` launches the actual stdio server,
  connects with the official `@modelcontextprotocol/sdk` 1.32.2 client,
  discovers tools, registers a repository, creates dependent tasks, claims a
  task, waits only for completion while progress arrives, completes it,
  verifies deterministic unblocking, and retrieves persisted events.
- Tool errors are returned as MCP `isError` results with structured details.
- The official client exposed that top-level arrays/null are not valid
  `structuredContent`; list and wait tools now return object envelopes.
- `@modelcontextprotocol/sdk` is a test-only dependency. The production
  adapter remains on Effect MCP.
- Last verification after the client round trip: `bun test` (11 passing) and
  `bun run build` (all packages pass).
- OpenCode v2.3.2 connected to the project-configured local server and
  discovered all 12 tools. Host calls to `list_tasks`, `get_events`, and a
  1-second bounded `wait_for_event` succeeded (`{ event: null }` on timeout).
  `opencode.json` keeps this project-local configuration.

## Next steps

1. Phase 4: investigate Effect RPC 0.x and platform socket support, then
   define a small local RPC contract over the existing coordination services.
   Keep MCP on the same application boundary; do not duplicate business logic.
2. Add daemon startup/shutdown and reconnect tests before routing MCP through
   the daemon. TUI should remain a separate client.
3. Consider decisions and extra task operations only when actual workflows
   require them; the current task model does not have decisions.

## Resume commands

```sh
bun install --frozen-lockfile
bun test
bun run build
bun run core
bun run mcp
```

`bun run core` uses `relay.db` in the current directory. Tests use in-memory
SQLite except for the explicit restart/recovery test.

## MCP integration notes

- Uses `@effect/ai` 0.37.0 and `@effect/platform-node` 0.108.0, compatible
  with the repository's Effect 3.22.5. This keeps protocol and stdio
  lifecycle in Effect rather than adding a separate MCP runtime.
- `bun run mcp` serves stdio and honors `RELAY_DB`.
- Effect MCP v3 in this package currently returns `notImplemented` for
  `resources/subscribe` and `resources/unsubscribe`. Relay therefore exposes
  `wait_for_event` with a 30-second default / 5-minute maximum; cancellation
  releases its scoped subscription. Use `get_events(afterId)` to reconnect
  without losing missed durable events.
- The stdio smoke check confirmed initialize, repository registration, and
  repository listing. Logs must remain on stderr.
