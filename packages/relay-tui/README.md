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

The TUI refreshes repositories, tasks, and events every three seconds. Set
`RELAY_DB` and `RELAY_SOCKET` consistently for both daemon and TUI when using
non-default locations.

## Structure

- `src/main.ts`: app lifecycle, RPC connection, input dispatch, refresh loop
- `src/context/state.ts`: local view and data state
- `src/component/render.ts`: terminal rendering for board, details, and events
