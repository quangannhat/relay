# Relay TUI

A keyboard-driven terminal client for the Relay daemon.

Start `bun run daemon` in another terminal, then run `bun run tui`.

## Keys

- `↑` / `↓` or `j` / `k`: move through tasks
- `Enter`: open/close task details
- `e`: show/hide the durable event stream
- `n`: create a task in the first registered repository
- `r`: refresh
- `q` or `Ctrl+C`: quit

The TUI takes an initial snapshot, then subscribes to the daemon's event
stream. It refreshes repository/task views when events arrive; `r` requests a
manual refresh. The event cursor is replayed on reconnect so events are not
lost across short disconnects. Set `RELAY_DB` and `RELAY_SOCKET` consistently
for both daemon and TUI when using non-default locations.

Keyboard input uses Bun's `process.stdin` terminal events in raw mode, so
single-key navigation works without Enter. No Node modules or readline layer
are used.

## Structure

- `src/main.ts`: app lifecycle, RPC connection, input dispatch, refresh loop
- `src/context/state.ts`: local view and data state
- `src/component/render.ts`: terminal rendering for board, details, and events
