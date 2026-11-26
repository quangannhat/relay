import { Effect, Schedule, Stream } from "effect"
import { RelayRpcClient, RelayRpcClientLive } from "relay-daemon/client"
import { relaySocketPath } from "relay-daemon/socket"
import { createState } from "./context/state.js"
import { render } from "./component/render.js"

const state = createState()
const stty = (args: string[]) => Bun.spawnSync({
  cmd: ["stty", ...args],
  stdin: "inherit",
  stdout: "pipe",
  stderr: "ignore"
})

const program = Effect.gen(function* () {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return yield* Effect.fail(new Error("Relay TUI requires an interactive terminal"))
  }
  const relay = yield* RelayRpcClient
  let refreshing = false
  let refreshQueued = false
  let eventCursor = 0
  const refresh = async () => {
    if (refreshing) {
      refreshQueued = true
      return
    }
    refreshing = true
    state.loading = true
    state.message = "Refreshing from daemon…"
    render(state)
    try {
      do {
        refreshQueued = false
        const data = await Effect.runPromise(Effect.gen(function* () {
          const repositories = yield* relay.ListRepositories(undefined)
          const tasks = yield* relay.ListTasks(undefined)
          const events = yield* relay.GetEvents({ afterId: eventCursor })
          return { repositories, tasks, events }
        }))
        state.repositories = data.repositories
        state.tasks = data.tasks
        state.selected = Math.min(state.selected, Math.max(0, state.tasks.length - 1))
        for (const event of data.events) {
          if (event.id <= eventCursor) continue
          eventCursor = event.id
          state.events = [...state.events, event].slice(-500)
        }
      } while (refreshQueued && state.running)
      state.message = ""
    } catch (error) {
      state.message = `Daemon unavailable: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      state.loading = false
      refreshing = false
      if (state.running) render(state)
    }
  }
  render(state)
  void refresh()
  const watchEvents = Effect.suspend(() => Stream.runForEach(
    relay.SubscribeEvents({ afterId: eventCursor }),
    event => Effect.gen(function* () {
      if (event.id <= eventCursor) return
      eventCursor = event.id
      state.events = [...state.events, event].slice(-500)
      yield* Effect.promise(refresh)
    })
  )).pipe(
    Effect.retry({ schedule: Schedule.spaced("1 second") }),
    Effect.catchAllCause(cause => Effect.sync(() => {
      if (state.running) {
        state.message = `Event subscription failed: ${String(cause)}`
        render(state)
      }
    }))
  )
  yield* Effect.forkScoped(watchEvents)

  const handleKey = (key: string) => Effect.gen(function* () {
    if (state.titleInput !== null) {
      if (key === "\r" || key === "\n") {
        const title = state.titleInput.trim()
        state.titleInput = null
        if (title && state.repositories.length) {
          yield* relay.CreateTask({ repositoryId: state.repositories[0].id, title, actor: "human" })
          state.message = "Task created."
          yield* Effect.promise(refresh)
        }
      } else if (key === "\u001b") state.titleInput = null
      else if (key === "\u007f" || key === "\b") state.titleInput = state.titleInput.slice(0, -1)
      else if (key.length === 1 && key >= " ") state.titleInput += key
      render(state)
      return
    }
    if (key === "q" || key === "\u0003") {
      state.running = false
      state.message = "Shutting down…"
      render(state)
      return
    }
    if (key === "\u001b[A" || key === "k") state.selected = Math.max(0, state.selected - 1)
    else if (key === "\u001b[B" || key === "j") state.selected = Math.min(state.tasks.length - 1, state.selected + 1)
    else if (key === "\r" && state.tasks.length) state.view = state.view === "details" ? "board" : "details"
    else if (key === "e") state.view = state.view === "events" ? "board" : "events"
    else if (key === "r") yield* Effect.promise(refresh)
    else if (key === "n") {
      if (!state.repositories.length) state.message = "Register a repository before creating tasks."
      else state.titleInput = ""
    } else if (key === "b" || key === "\u001b") state.view = "board"
    render(state)
  })
  const onKey = (key: string) => {
    Effect.runPromise(handleKey(key)).catch(error => {
      state.message = error instanceof Error ? error.message : String(error)
      render(state)
    })
  }
  let pending = ""
  const decoder = new TextDecoder()
  const onData = (data: Uint8Array) => {
    pending += decoder.decode(data, { stream: true })
    while (pending.length) {
      if (pending.startsWith("\u001b")) {
        if (pending.length < 3) break
        const sequence = pending.slice(0, 3)
        if (sequence === "\u001b[A" || sequence === "\u001b[B") {
          onKey(sequence)
          pending = pending.slice(3)
          continue
        }
        onKey("\u001b")
        pending = pending.slice(1)
        continue
      }
      const [character] = Array.from(pending)
      onKey(character)
      pending = pending.slice(character.length)
    }
  }
  let terminalSettings = ""
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const saved = stty(["-g"])
      if (saved.exitCode !== 0) throw new Error("Unable to read terminal settings (stty -g failed)")
      terminalSettings = saved.stdout.toString().trim()
      const raw = stty(["raw", "-echo", "opost"])
      if (raw.exitCode !== 0) throw new Error("Unable to enable terminal key input (stty raw failed)")
      process.stdin.on("data", onData)
      process.stdin.resume()
    }),
    () => Effect.sync(() => {
      process.stdin.off("data", onData)
      if (terminalSettings) stty([terminalSettings])
      process.stdout.write("\u001b[?25h")
    })
  )
  process.stdout.write("\u001b[?25l")

  while (state.running) {
    yield* Effect.promise<void>(() => new Promise(resolve => {
      const check = setInterval(() => {
        if (!state.running) {
          clearInterval(check)
          resolve()
        }
      }, 100)
    }))
  }
})

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(RelayRpcClientLive(relaySocketPath())))))
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
