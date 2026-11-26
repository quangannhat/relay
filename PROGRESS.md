# Relay implementation progress

Last updated: 2026-11-26

Use this file as the pickup note for future sessions. The project brief and
implementation roadmap are in the conversation that initiated the project;
this note records the current repository state and the next bounded work.

## Current state

- Bun/TypeScript monorepo with `relay-core`, `relay-daemon`, `relay-mcp`, and
  `relay-tui`.
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
  - `packages/relay-daemon/src/rpc.ts`: typed Effect RPC contract.
  - `packages/relay-daemon/src/server.ts`: Unix socket RPC server, SQLite owner.
  - `packages/relay-daemon/src/client.ts`: scoped RPC client layer.
  - `packages/relay-daemon/src/main.ts`: independently runnable daemon.
  - `packages/relay-tui/src/main.ts`: keyboard-driven RPC client.
  - `packages/relay-tui/src/context/state.ts`: TUI app state.
  - `packages/relay-tui/src/component/render.ts`: board/details/event rendering.
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
- Last verification: `bun test` (12 passing, including daemon and MCP
  integration flows) and `bun run build` (all packages pass).

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
- Last verification after the client round trip: `bun test` (12 passing) and
  `bun run build` (all packages pass).
- OpenCode v2.3.2 connected to the project-configured local server and
  discovered all 12 tools. Host calls to `list_tasks`, `get_events`, and a
  1-second bounded `wait_for_event` succeeded (`{ event: null }` on timeout).
  `opencode.json` keeps this project-local configuration.

## Phase 4: daemon and local RPC

- Uses `@effect/rpc` 0.76.4 with Effect 3.22.5 and
  `@effect/platform-node` 0.108.0. Unix domain sockets carry NDJSON RPC.
- `bun run daemon` starts a daemon that owns the SQLite connection and core
  `Coordination` service. `RELAY_DB` and `RELAY_SOCKET` configure its database
  and socket; clients must use matching environment values.
- MCP and TUI are now RPC clients; they do not open SQLite themselves.
- `packages/relay-daemon/test/daemon.test.ts` checks real socket RPC, typed
  domain errors, task lifecycle/events, daemon shutdown/restart, and durable
  recovery through a new client.
- OpenCode's configured MCP client was tested against the daemon-backed
  server: tools connected, read-only calls worked, and bounded event waiting
  returned its timeout result.

## Phase 5: structured terminal client

- Replaced the readline command loop with a raw-key, full-screen task board.
- Followed OpenCode's app/context/component separation at Relay's smaller
  scale: app lifecycle and input in `main.ts`, data/view state in
  `context/state.ts`, and board/details/event rendering in `component/render.ts`.
- Added task navigation, task details (including ownership, dependencies,
  progress, and artifacts), a durable event stream, task creation, periodic
  refresh, and terminal cleanup on exit.
- The TUI is still intentionally dependency-light and consumes only daemon
  RPC; it does not own SQLite or coordination logic.
- TUI keyboard input uses Bun's `process.stdin` terminal events with a small
  escape-sequence parser; no Node modules or readline layer are used. Raw
  terminal mode is restored on exit.
- Verification: `bun run build`, `bun test` (13 passing, including a Bun PTY
  test that sends `q` and verifies clean process exit), and `git diff --check`.
- Kept terminal output processing enabled in raw input mode (`opost`) so
  newline rendering remains aligned; PTY test checks CRLF output after raw mode
  is active.

## Next steps

1. Test reconnect behavior with an already-running RPC client across daemon
   restart, and handle stale socket files with a safe active-daemon check.
2. Add status/priority filters and repository selection to the TUI.
3. Consider decisions and extra task operations only when actual workflows
   require them; the current task model does not have decisions.

## Resume commands

```sh
bun install --frozen-lockfile
bun test
bun run build
bun run core
bun run daemon
bun run mcp
```

`bun run core` uses `relay.db` in the current directory. Tests use in-memory
SQLite except for the explicit restart/recovery test.

## MCP integration notes

- Uses `@effect/ai` 0.37.0 and `@effect/platform-node` 0.108.0, compatible
  with the repository's Effect 3.22.5. This keeps protocol and stdio
  lifecycle in Effect rather than adding a separate MCP runtime.
- `bun run mcp` serves stdio and honors `RELAY_DB`.
- `bun run daemon` is a separate process. Start it before MCP or TUI; local
  clients connect to its Unix socket. Socket path defaults are derived from
  the resolved database path, so a custom database and socket configuration
  must match across processes.
- Effect MCP v3 in this package currently returns `notImplemented` for
  `resources/subscribe` and `resources/unsubscribe`. Relay therefore exposes
  `wait_for_event` with a 30-second default / 5-minute maximum; cancellation
  releases its scoped subscription. Use `get_events(afterId)` to reconnect
  without losing missed durable events.
- The stdio smoke check confirmed initialize, repository registration, and
  repository listing. Logs must remain on stderr.
