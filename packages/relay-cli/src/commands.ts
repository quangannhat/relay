import { readFileSync } from "node:fs"
import { userInfo } from "node:os"
import { resolve, sep } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { RelayRpcClient, RelayRpcClientLive } from "relay-daemon/client"
import { isRelayDaemonRunning, relaySocketPath } from "relay-daemon/socket"

export const commands = ["new", "claim", "done", "show", "ls", "wait", "cancel"]

class CliError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message)
  }
}

const valueFlags = new Set(["-d", "-f", "--repo", "--as", "--status", "--timeout", "--new"])
const boolFlags = new Set(["--result", "--json"])

const parse = (args: string[]) => {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (valueFlags.has(arg)) {
      if (i + 1 >= args.length) throw new CliError(`${arg} needs a value`, 2)
      flags.set(arg, args[++i])
    } else if (boolFlags.has(arg)) flags.set(arg, true)
    else if (arg.startsWith("-") && arg !== "-") throw new CliError(`unknown option ${arg}`, 2)
    else positional.push(arg)
  }
  return { flags, positional }
}

const flag = (flags: Map<string, string | true>, name: string) => {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

const readSource = async (source: string) => {
  try {
    return source === "-" ? await Bun.stdin.text() : readFileSync(source, "utf8")
  } catch (error) {
    throw new CliError(`cannot read ${source === "-" ? "stdin" : source}: ${(error as Error).message}`, 2)
  }
}

const parseDuration = (text: string) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text)
  if (!match) throw new CliError(`invalid duration "${text}" (use e.g. 30s, 10m)`, 2)
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"]!
  return Math.round(Number(match[1]) * unit)
}

const actorOf = (flags: Map<string, string | true>) =>
  flag(flags, "--as") ?? process.env.RELAY_ACTOR ?? `cli-${userInfo().username}`

const describe = (error: unknown): string => {
  if (error instanceof CliError) return error.message
  const tagged = error as { _tag?: string; entity?: string; id?: string; message?: string; from?: string; to?: string }
  switch (tagged?._tag) {
    case "NotFound": return `${tagged.entity} ${tagged.id} not found`
    case "Conflict": return tagged.message ?? "conflict"
    case "InvalidTransition": return `invalid transition ${tagged.from} -> ${tagged.to}`
  }
  return error instanceof Error ? error.message : String(error)
}

const needId = (positional: string[], command: string) => {
  if (!positional[0]) throw new CliError(`usage: relay ${command} <id>`, 2)
  return positional[0] as never
}

const lastArtifact = (task: { artifacts: ReadonlyArray<string> }) => task.artifacts.at(-1)

const run = async (command: string, args: string[]) => {
  const { flags, positional } = parse(args)
  const json = flags.has("--json")
  const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
  const socket = relaySocketPath()
  if (!(await isRelayDaemonRunning(socket))) {
    throw new CliError(`relay: daemon not running at ${socket} (start it with: relay daemon)`, 3)
  }

  const program = Effect.gen(function* () {
    const relay = yield* RelayRpcClient
    const repositoryOf = () => Effect.gen(function* () {
      const explicit = flag(flags, "--repo") ?? process.env.RELAY_REPO
      if (explicit) return explicit
      const repositories = yield* relay.ListRepositories(undefined)
      const cwd = resolve(process.cwd())
      const matches = repositories.flatMap(repository =>
        repository.paths.flatMap(path => {
          const root = resolve(path)
          return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep)
            ? [{ id: repository.id, length: root.length }] : []
        }))
      matches.sort((a, b) => b.length - a.length)
      if (matches[0]) return matches[0].id
      if (repositories.length === 1) return repositories[0].id
      throw new CliError(
        repositories.length === 0
          ? "no repository registered; pass --repo <id> or set RELAY_REPO"
          : `cannot infer repository from ${cwd}; pass --repo <id> or set RELAY_REPO`, 2)
    })
    switch (command) {
      case "new": {
        const title = positional[0]
        if (!title) throw new CliError('usage: relay new "<title>" [-d <text> | -f <file> | -] [--repo <id>]', 2)
        const description = flag(flags, "-d") ??
          (flag(flags, "-f") ? yield* Effect.promise(() => readSource(flag(flags, "-f")!)) :
            positional[1] === "-" ? yield* Effect.promise(() => readSource("-")) : undefined)
        const task = yield* relay.CreateTask({
          repositoryId: yield* repositoryOf(), title, ...(description === undefined ? {} : { description }),
          actor: actorOf(flags)
        })
        out(task.id)
        return 0
      }
      case "claim": {
        const task = yield* relay.ClaimTask({ taskId: needId(positional, "claim"), actor: actorOf(flags) })
        out(`${task.title}\n\n${task.description}`)
        return 0
      }
      case "done": {
        // With --new the task is created here, so a worker can hand off a result without being given an id.
        const title = flag(flags, "--new")
        const actor = actorOf(flags)
        const taskId = title
          ? (yield* relay.CreateTask({ repositoryId: yield* repositoryOf(), title, actor })).id
          : needId(positional, "done")
        const source = title ? positional[0] : positional[1]
        const result = flag(flags, "-f") ? yield* Effect.promise(() => readSource(flag(flags, "-f")!)) :
          source === "-" ? yield* Effect.promise(() => readSource("-")) : source
        const task = yield* relay.GetTask({ taskId })
        if (task.status === "pending" && task.assignee === null) yield* relay.ClaimTask({ taskId, actor })
        if (result !== undefined && result !== "") yield* relay.PublishArtifact({ taskId, artifact: result, actor })
        yield* relay.CompleteTask({ taskId, actor })
        out(`${taskId} completed`)
        return 0
      }
      case "show": {
        const task = yield* relay.GetTask({ taskId: needId(positional, "show") })
        if (flags.has("--result")) {
          const artifact = lastArtifact(task)
          if (artifact === undefined) throw new CliError(`${task.id} has no result`)
          process.stdout.write(artifact)
          return 0
        }
        out(json ? JSON.stringify(task) :
          `id: ${task.id}\nstatus: ${task.status}\nassignee: ${task.assignee ?? "-"}\ntitle: ${task.title}\n\n${task.description}`)
        return 0
      }
      case "ls": {
        const status = flag(flags, "--status")
        const repo = flag(flags, "--repo")
        const tasks = (yield* relay.ListTasks(undefined)).filter(task =>
          (!status || task.status === status) && (!repo || task.repositoryId === repo))
        if (json) out(JSON.stringify(tasks))
        else for (const task of tasks) out(`${task.id} ${task.status} ${task.assignee ?? "-"} ${task.title}`)
        return 0
      }
      case "wait": {
        const taskId = needId(positional, "wait")
        const timeout = parseDuration(flag(flags, "--timeout") ?? "10m")
        const deadline = Date.now() + timeout
        while (true) {
          const task = yield* relay.GetTask({ taskId })
          if (task.status === "completed" || task.status === "cancelled") {
            const artifact = lastArtifact(task)
            if (artifact !== undefined) out(artifact)
            return task.status === "completed" ? 0 : 1
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            process.stderr.write(`relay: timed out waiting for ${taskId}\n`)
            return 124
          }
          yield* relay.WaitForEvent({
            taskId, types: ["TaskCompleted", "TaskUpdated"], timeoutMs: Math.max(1, Math.min(remaining, 15_000))
          })
        }
      }
      case "cancel": {
        const taskId = needId(positional, "cancel")
        yield* relay.UpdateTask({ taskId, status: "cancelled", actor: actorOf(flags) })
        out(`${taskId} cancelled`)
        return 0
      }
    }
    return 2
  })

  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(RelayRpcClientLive(socket)), Effect.scoped))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

export const runCommand = async (command: string, args: string[]) => {
  try {
    process.exitCode = await run(command, args)
  } catch (error) {
    const message = describe(error)
    process.stderr.write(`${message.startsWith("relay:") ? "" : "relay: "}${message}\n`)
    process.exitCode = error instanceof CliError ? error.code : 1
  }
  process.exit()
}
