import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Queue } from "effect"
import { Coordination, CoordinationLive } from "../src/engine.js"
import { StoreLive } from "../src/store.js"

const withRelay = <A>(program: Effect.Effect<A, any, never>) =>
  Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(CoordinationLive), Effect.provide(StoreLive(":memory:")))))

describe("Relay coordination engine", () => {
  it("persists repositories, tasks, and events", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", ["/worktree", "/worktree-feature"])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Build API" })
      return { repo, task, events: yield* relay.getEvents() }
    }))
    expect(result.repo.paths).toHaveLength(2)
    expect(result.task.status).toBe("pending")
    expect(result.events.map(event => event.type)).toEqual(["TaskCreated"])
  })

  it("allows only one concurrent claimant", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", [])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Claim me" })
      const claims = yield* Effect.all([
        relay.claimTask(task.id, "agent-a").pipe(Effect.either),
        relay.claimTask(task.id, "agent-b").pipe(Effect.either)
      ], { concurrency: "unbounded" })
      return { claims, task: yield* relay.getTask(task.id) }
    }))
    expect(result.claims.filter(claim => claim._tag === "Right")).toHaveLength(1)
    expect(result.task.assignee === "agent-a" || result.task.assignee === "agent-b").toBe(true)
  })

  it("filters live notifications and supports incremental history", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", [])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Notify me" })
      const other = yield* relay.createTask({ repositoryId: repo.id, title: "Other" })
      const queue = yield* relay.subscribe(task.id, ["TaskCompleted"])
      yield* relay.claimTask(task.id, "agent-a")
      yield* relay.reportProgress(task.id, "not a completion", "agent-a")
      yield* relay.claimTask(other.id, "agent-b")
      yield* relay.completeTask(task.id, "agent-a")
      const notification = yield* Queue.take(queue)
      const events = yield* relay.getEvents(1)
      return { notification, events }
    }))
    expect(result.notification.type).toBe("TaskCompleted")
    expect(result.notification.taskId).not.toBe("")
    expect(result.events.every(event => event.id > 1)).toBe(true)
  })

  it("waits for a task condition and persists artifacts", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", [])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Wait for me" })
      const waiting = relay.waitForTask(task.id, ["completed"]).pipe(Effect.fork)
      yield* relay.claimTask(task.id, "agent-a")
      yield* relay.publishArtifact(task.id, "src/db/repository.ts", "agent-a")
      yield* relay.completeTask(task.id, "agent-a")
      const fiber = yield* waiting
      return yield* Fiber.join(fiber)
    }))
    expect(result.status).toBe("completed")
    expect(result.artifacts).toEqual(["src/db/repository.ts"])
  })

  it("rejects invalid status transitions", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", [])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Transition" })
      return yield* relay.updateTask(task.id, { status: "completed" }, "agent-a").pipe(Effect.either)
    }))
    expect(result._tag).toBe("Left")
  })
})
