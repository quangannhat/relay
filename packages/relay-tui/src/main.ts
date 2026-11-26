import { Effect } from "effect"
import { RelayRpcClient, RelayRpcClientLive } from "relay-daemon/client"
import { relaySocketPath } from "relay-daemon/socket"
import { createState } from "./context/state.js"
import { render } from "./component/render.js"
import { createInterface } from "node:readline"

const state = createState()

const program = Effect.gen(function* () {
  const relay = yield* RelayRpcClient
  const input = yield* Effect.acquireRelease(
    Effect.sync(() => createInterface({ input: process.stdin, output: process.stdout })),
    readline => Effect.sync(() => readline.close())
  )
  let refreshing = false
  const refresh = async () => {
    if (refreshing) return
    refreshing = true
    state.loading = true
    state.message = "Refreshing from daemon…"
    render(state)
    try {
      const data = await Effect.runPromise(Effect.gen(function* () {
        const repositories = yield* relay.ListRepositories(undefined)
        const tasks = yield* relay.ListTasks(undefined)
        const events = yield* relay.GetEvents({})
        return { repositories, tasks, events }
      }))
      state.repositories = data.repositories
      state.tasks = data.tasks
      state.events = data.events
      state.selected = Math.min(state.selected, Math.max(0, state.tasks.length - 1))
      state.message = ""
    } catch (error) {
      state.message = `Daemon unavailable: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      state.loading = false
      refreshing = false
      render(state)
    }
  }
  const ask = (question: string) => Effect.promise<string>(() => new Promise(resolve => {
    process.stdin.off("data", onKey)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    input.question(question, answer => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
      process.stdin.on("data", onKey)
      resolve(answer)
    })
  }))

  render(state)
  void refresh()
  const timer = setInterval(() => void refresh(), 3000)
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.on("data", onKey)
    }),
    () => Effect.sync(() => {
      clearInterval(timer)
      process.stdin.off("data", onKey)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdout.write("\u001b[?25h")
    })
  )
  process.stdout.write("\u001b[?25l")

  const handleKey = (key: string) => Effect.gen(function* () {
    if (key === "q" || key === "\u0003") {
      state.running = false
      return
    }
    if (key === "\u001b[A" || key === "k") state.selected = Math.max(0, state.selected - 1)
    else if (key === "\u001b[B" || key === "j") state.selected = Math.min(state.tasks.length - 1, state.selected + 1)
    else if (key === "\r" && state.tasks.length) state.view = state.view === "details" ? "board" : "details"
    else if (key === "e") state.view = state.view === "events" ? "board" : "events"
    else if (key === "r") yield* Effect.promise(refresh)
    else if (key === "n") {
      if (!state.repositories.length) state.message = "Register a repository before creating tasks."
      else {
        const repositoryId = state.repositories[0].id
        const title = (yield* ask(`\nNew task title (${state.repositories[0].name}): `)).trim()
        if (title) {
          yield* relay.CreateTask({ repositoryId, title, actor: "human" })
          state.message = "Task created."
          yield* Effect.promise(refresh)
        }
      }
    } else if (key === "b" || key === "\u001b") state.view = "board"
    render(state)
  })
  function onKey(data: Buffer) {
    const key = data.toString()
    Effect.runPromise(handleKey(key)).catch(error => {
      state.message = error instanceof Error ? error.message : String(error)
      render(state)
    })
  }

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
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
