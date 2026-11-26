import { expect, it } from "bun:test"
import { Effect, Schedule, Stream } from "effect"
import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { RelayRpcClient, RelayRpcClientLive } from "../src/client.js"

const withClient = <A>(socketPath: string, program: Effect.Effect<A, any, never>) =>
  Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(RelayRpcClientLive(socketPath)))))

it("serves coordination over a local socket and recovers after daemon restart", async () => {
  const directory = join(process.cwd(), `.relay-daemon-${crypto.randomUUID()}`)
  const socketPath = join(directory, "relay.sock")
  const databasePath = join(directory, "relay.db")
  const startDaemon = () => {
    const child = spawn(process.execPath, ["packages/relay-daemon/src/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, RELAY_SOCKET: socketPath, RELAY_DB: databasePath },
      stdio: ["ignore", "ignore", "ignore"]
    })
    child.on("error", error => {
      throw error
    })
    return child
  }
  const stopDaemon = async (child: ReturnType<typeof startDaemon>) => {
    const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    await stopped
  }
  const ready = <A>(program: Effect.Effect<A, any, never>) =>
    program.pipe(Effect.retry({
      schedule: Schedule.spaced("100 millis").pipe(Schedule.compose(Schedule.recurs(30)))
    }))

  let daemon: ReturnType<typeof startDaemon> | undefined
  try {
    daemon = startDaemon()
    const created = await withClient(socketPath, Effect.gen(function* () {
      const relay = yield* RelayRpcClient
      const repositories = yield* ready(relay.ListRepositories({}))
      expect(repositories).toHaveLength(0)
      const missing = yield* relay.GetTask({ taskId: "T-missing" as any }).pipe(Effect.either)
      expect(missing._tag).toBe("Left")
      if (missing._tag === "Left") expect(missing.left._tag).toBe("NotFound")
      const repository = yield* relay.RegisterRepository({
        name: "rpc-test", paths: ["/tmp/rpc-test"]
      })
      const task = yield* relay.CreateTask({
        repositoryId: repository.id,
        title: "Persist across daemon restart",
        actor: "agent-a"
      })
      yield* relay.ClaimTask({ taskId: task.id, actor: "agent-a" })
      yield* relay.ReportProgress({
        taskId: task.id, message: "RPC service is ready", actor: "agent-a"
      })
      yield* relay.CompleteTask({ taskId: task.id, actor: "agent-a" })
      const events = yield* relay.GetEvents({ afterId: 0 })
      const subscribed = yield* Stream.runCollect(
        relay.SubscribeEvents({ afterId: 0 }).pipe(Stream.take(4))
      )
      return { taskId: task.id, events, subscribed }
    }))
    expect(created.events.map(event => event.type)).toEqual([
      "TaskCreated", "TaskClaimed", "ProgressReported", "TaskCompleted"
    ])
    expect(Array.from(created.subscribed, event => event.id)).toEqual(created.events.map(event => event.id))

    const duplicate = spawn(process.execPath, ["packages/relay-daemon/src/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, RELAY_SOCKET: socketPath, RELAY_DB: databasePath },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let duplicateOutput = ""
    duplicate.stdout?.on("data", chunk => { duplicateOutput += chunk.toString() })
    duplicate.stderr?.on("data", chunk => { duplicateOutput += chunk.toString() })
    const duplicateExitCode = await new Promise<number | null>(resolve => {
      duplicate.once("exit", code => resolve(code))
    })
    expect(duplicateExitCode).toBe(0)
    expect(duplicateOutput).toContain("Relay daemon is already running")
    expect(duplicateOutput).not.toContain("EADDRINUSE")

    await stopDaemon(daemon)
    daemon = undefined
    daemon = startDaemon()
    const recovered = await withClient(socketPath, Effect.gen(function* () {
      const relay = yield* RelayRpcClient
      const task = yield* ready(relay.GetTask({ taskId: created.taskId as any }))
      const events = yield* relay.GetEvents({ afterId: 1 })
      return { task, events }
    }))
    expect(recovered.task.status).toBe("completed")
    expect(recovered.task.assignee).toBe("agent-a")
    expect(recovered.events).toHaveLength(3)
  } finally {
    if (daemon) await stopDaemon(daemon)
    rmSync(databasePath, { force: true })
    rmSync(`${databasePath}-wal`, { force: true })
    rmSync(`${databasePath}-shm`, { force: true })
    rmSync(socketPath, { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

it("replaces a stale socket left behind by a killed daemon", async () => {
  const directory = join(process.cwd(), `.relay-daemon-${crypto.randomUUID()}`)
  const socketPath = join(directory, "relay.sock")
  const databasePath = join(directory, "relay.db")
  const startDaemon = () => spawn(process.execPath, ["packages/relay-daemon/src/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_SOCKET: socketPath, RELAY_DB: databasePath },
    stdio: ["ignore", "ignore", "ignore"]
  })
  const listRepositories = () => withClient(socketPath, Effect.gen(function* () {
    const relay = yield* RelayRpcClient
    return yield* relay.ListRepositories({}).pipe(Effect.retry({
      schedule: Schedule.spaced("100 millis").pipe(Schedule.compose(Schedule.recurs(30)))
    }))
  }))

  let daemon: ReturnType<typeof startDaemon> | undefined
  try {
    daemon = startDaemon()
    await listRepositories()
    const killed = new Promise<void>(resolve => daemon!.once("exit", () => resolve()))
    daemon.kill("SIGKILL")
    await killed
    expect(existsSync(socketPath)).toBe(true)

    daemon = startDaemon()
    expect(await listRepositories()).toHaveLength(0)
  } finally {
    if (daemon && daemon.exitCode === null) {
      const stopped = new Promise<void>(resolve => daemon!.once("exit", () => resolve()))
      daemon.kill("SIGTERM")
      await stopped
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
