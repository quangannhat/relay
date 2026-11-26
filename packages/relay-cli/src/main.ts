import { commands, runCommand } from "./commands.js"

const usage = `Relay local coordination

Usage:
  relay daemon   Start the local coordination daemon
  relay tui      Open the interactive terminal UI
  relay mcp      Start the MCP stdio server
  relay --help   Show this help

Agent commands (talk to the running daemon; plain-text output):
  relay new "<title>" [-d <text> | -f <file> | -] [--repo <id>]   Create a task, print its id
  relay claim <id>                      Claim a task, print title and description
  relay done <id> [<text> | -f <file> | -]   Claim if needed, publish result, complete
  relay done --new "<title>" [<text> | -f <file> | -]   Create a task and complete it with the result
  relay show <id> [--result] [--json]   Show a task, or only its last artifact
  relay ls [--status <s>] [--repo <id>] [--json]   List tasks
  relay wait <id> [--timeout 10m]       Block until done; exit 0 completed, 1 cancelled, 124 timeout
  relay cancel <id>                     Cancel a task
  Options: --as <actor> (default: RELAY_ACTOR, else cli-<user>); repository
  defaults to RELAY_REPO, then the one matching the current directory.
  Exit codes: 1 failure, 2 usage, 3 daemon not running, 124 timeout.

The daemon and all clients default to ~/.local/share/relay/relay.db and its socket, from
any directory. Set RELAY_DB or RELAY_SOCKET to use another one.`

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case "daemon":
    await import("../../relay-daemon/src/main.js")
    break
  case "tui":
    await import("../../relay-tui/src/main.js")
    break
  case "mcp":
    await import("../../relay-mcp/src/main.js")
    break
  case undefined:
  case "--help":
  case "-h":
  case "help":
    console.log(usage)
    break
  default:
    if (commands.includes(command)) {
      await runCommand(command, rest)
      break
    }
    console.error(`Unknown command: ${command}\n\n${usage}`)
    process.exitCode = 2
}
