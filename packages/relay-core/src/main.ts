import { Effect, Queue } from "effect"
import { Coordination, CoordinationLive } from "./engine.js"
import { StoreLive } from "./store.js"

const program = Effect.gen(function* () {
  const relay = yield* Coordination
  const repository = yield* relay.registerRepository("demo-repository", [process.cwd()])
  const task = yield* relay.createTask({
    repositoryId: repository.id,
    title: "Implement database layer",
    description: "Build the persistent task store",
    priority: "high"
  })
  const subscriber = yield* relay.subscribe(task.id, ["TaskCompleted"])
  yield* relay.claimTask(task.id, "agent-a")
  yield* relay.reportProgress(task.id, "Schema and repository interface are ready", "agent-a")
  yield* relay.reportProgress(task.id, "SQLite persistence is implemented", "agent-a")
  yield* relay.completeTask(task.id, "agent-a")
  const notification = yield* Queue.take(subscriber)
  yield* Effect.logInfo(`Agent B received ${notification.type} for ${notification.taskId}`)
  yield* Effect.logInfo(JSON.stringify(yield* relay.listTasks(), null, 2))
})

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(CoordinationLive), Effect.provide(StoreLive("relay.db")))))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
