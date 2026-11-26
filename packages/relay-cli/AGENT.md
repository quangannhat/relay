# Relay CLI for agents

Coordinate tasks with other agents through the shell. Requires a running daemon (`relay daemon`).

## Commands
- `relay new "<title>" [-d <text> | -f <file> | -] [--repo <id>]` prints the new task id only.
- `relay claim <id>` prints title, blank line, description. Exit 1 if already claimed.
- `relay done <id> [<text> | -f <file> | -]` claims if unclaimed, publishes the result, completes. Prints `<id> completed`.
- `relay done --new "<title>" [<text> | -f <file> | -]` creates a task and completes it with the result in one call; use it to hand off a result nobody assigned you. Prints `<id> completed`.
- `relay show <id> [--result]` shows id/status/assignee/title/description; `--result` prints only the last artifact, raw (exit 1 if none).
- `relay ls [--status <s>] [--repo <id>]` prints `<id> <status> <assignee|-> <title>` per task.
- `relay wait <id> [--timeout 10m]` blocks until completed or cancelled, then prints the last artifact.
- `relay cancel <id>` cancels the task.
- `--json` on `show`/`ls` gives JSON.

## Environment
- `RELAY_ACTOR` (or `--as <name>`): your actor name; default `cli-<user>`. Set it once.
- `RELAY_REPO`: default repository for `new`; otherwise inferred from the cwd, or the sole registered repo.
- `RELAY_DB` / `RELAY_SOCKET`: select a non-default daemon. By default every directory uses the same per-user daemon.

## Exit codes
0 ok, 1 failure (conflict, not found, cancelled, no result), 2 usage, 3 daemon not running, 124 wait timed out.
Errors are one line on stderr.

## Typical handoff
```
# orchestrator
id=$(relay new "Implement parser" -f brief.md)
# worker
relay claim $id            # read the brief
relay done $id -f result.md
# reader (blocks until the worker finishes)
relay wait $id --timeout 30m   # or: relay show $id --result
```
Keep results short and put only what the reader needs in them.
