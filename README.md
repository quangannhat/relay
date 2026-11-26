# Relay

Relay is a local-first coordination engine for independent agents and humans.
This is a Bun monorepo. `relay-core` contains the coordination services and
durable SQLite state. `relay-mcp` exposes those services over MCP stdio;
`relay-daemon` owns the SQLite connection and serves coordination over a local
Effect RPC socket; MCP and `relay-tui` are separate clients.

## Architecture

```text
packages/relay-core/src/domain.ts  -> schemas and domain types
packages/relay-core/src/store.ts   -> SQLite source of truth
packages/relay-core/src/engine.ts  -> coordination operations and PubSub delivery
packages/relay-core/src/main.ts    -> deterministic simulated-agent demonstration
packages/relay-core/test/          -> behavior tests
packages/relay-daemon/src/rpc.ts   -> typed local RPC contract
packages/relay-daemon/src/server.ts -> daemon server layer
packages/relay-daemon/src/main.ts  -> independently runnable daemon
packages/relay-mcp/src/server.ts   -> Effect-native MCP tool adapter
packages/relay-mcp/src/main.ts     -> MCP stdio entrypoint
packages/relay-tui/src/main.ts     -> primary human client
```

The engine publishes only after a database commit. Task claiming uses a
conditional SQL update inside a SQLite transaction, so concurrent agents
cannot both claim a pending task. Event IDs are SQLite autoincrement values
and can be replayed with `getEvents(afterId)`. Live subscriptions are
best-effort low-latency delivery; persisted events are the reconnect path.

The daemon owns SQLite and the application services. MCP and TUI connect to
its local Unix socket; closing either client does not stop the daemon. Durable
event retrieval uses `get_events(afterId)`. `wait_for_event` is a bounded,
cancellable blocking tool because the installed Effect MCP server does not
implement resource subscribe/unsubscribe; persisted events remain the
reconnection path.

The TUI reads an initial snapshot, then subscribes to the daemon's
`SubscribeEvents` stream. The daemon replays persisted events after the
subscriber's cursor before delivering live PubSub events, so the TUI does not
poll for updates.

MCP exposes `get_metrics` for persisted per-tool call counts, request/response
size estimates, and estimated tokens saved. The estimate compares each
serialized MCP argument/result against serializing the entire current Relay
workspace (repositories, tasks, and events), with a simple 4-characters-per-
token heuristic. It is a directional estimate, not model-tokenizer accounting;
tool schemas, system prompts, and other conversation context are excluded.

## Run

Requires Bun 1.1+.

See [PROGRESS.md](./PROGRESS.md) for the implementation handoff, verification
status, and suggested next steps.

```sh
bun install
bun test
bun run daemon
bun run core
bun run mcp
bun run tui
```

Run `bun run daemon` in its own terminal before `bun run mcp` or `bun run tui`.
If a daemon already owns the configured socket, starting another daemon prints
that it is already running and exits without disturbing the active process.
The project includes an OpenCode MCP config in `opencode.json`; it launches
the MCP server directly with `bun` so stdout remains a clean protocol channel.
Other clients can launch `bun run mcp`. Set `RELAY_DB` or `RELAY_SOCKET` on the
daemon and clients to override their shared defaults.

`bun run core` is a standalone demo that creates `relay.db`, registers a
repository, runs a simulated claim/progress/completion flow, and demonstrates
a filtered completion subscription. Do not run it at the same time as the
daemon using that same database.

## Compile and install

Build a self-contained executable for the current OS and architecture:

```sh
bun run compile
./dist/relay --help
```

The executable supports `relay daemon`, `relay tui`, and `relay mcp`. Install
it for the current user under `~/.local/bin/relay` with:

```sh
bun run install:binary
```

Set `RELAY_INSTALL_DIR` to install somewhere else. The install command compiles
first; add the destination directory to `PATH` if it is not already there.
