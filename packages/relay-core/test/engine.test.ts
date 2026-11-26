import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Queue } from "effect"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { Coordination, CoordinationLive } from "../src/engine.js"
import { Store, StoreLive } from "../src/store.js"

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

  it("rejects stale task revisions without recording their event", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const store = yield* Store
      const repo = yield* relay.registerRepository("repo", [])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Original" })
      const event = {
        type: "TaskUpdated" as const, taskId: task.id, actor: "agent-a",
        payload: { title: "First update" }, createdAt: Date.now()
      }
      const first = yield* store.saveTaskAndEvent(
        { ...task, title: "First update", revision: task.revision + 1 }, event, task.revision
      )
      const stale = yield* store.saveTaskAndEvent(
        { ...task, title: "Stale update", revision: task.revision + 1 },
        { ...event, actor: "agent-b", payload: { title: "Stale update" } },
        task.revision
      )
      return { first, stale, task: yield* relay.getTask(task.id), events: yield* relay.getEvents() }
    }))
    expect(result.first).toBeDefined()
    expect(result.stale).toBeUndefined()
    expect(result.task.title).toBe("First update")
    expect(result.task.revision).toBe(1)
    expect(result.events).toHaveLength(2)
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

  it("cancels a task waiter cleanly when its owning fiber is interrupted", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", [])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Cancel waiter" })
      const waiter = yield* Effect.fork(relay.waitForTask(task.id, ["completed"]))
      yield* Fiber.interrupt(waiter)
      yield* relay.claimTask(task.id, "agent-a")
      yield* relay.completeTask(task.id, "agent-a")
      return yield* relay.getTask(task.id)
    }))
    expect(result.status).toBe("completed")
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

  it("keeps fields that a patch leaves undefined", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", [])
      const task = yield* relay.createTask({ repositoryId: repo.id, title: "Keep title", description: "Keep description" })
      return yield* relay.updateTask(task.id, { status: "in_progress", title: undefined, description: undefined }, "agent-a")
    }))
    expect(result.status).toBe("in_progress")
    expect(result.title).toBe("Keep title")
    expect(result.description).toBe("Keep description")
  })

  it("blocks dependent tasks and unblocks them after completion", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const repo = yield* relay.registerRepository("repo", [])
      const dependency = yield* relay.createTask({ repositoryId: repo.id, title: "Dependency" })
      const dependent = yield* relay.createTask({
        repositoryId: repo.id, title: "Dependent", dependencies: [dependency.id]
      })
      const before = yield* relay.claimTask(dependent.id, "agent-b").pipe(Effect.either)
      yield* relay.claimTask(dependency.id, "agent-a")
      yield* relay.completeTask(dependency.id, "agent-a")
      const after = yield* relay.getTask(dependent.id)
      return { before, after }
    }))
    expect(result.before._tag).toBe("Left")
    expect(result.after.status).toBe("pending")
  })

  it("rolls back completion if a dependent task has a stale revision", async () => {
    const result = await withRelay(Effect.gen(function* () {
      const relay = yield* Coordination
      const store = yield* Store
      const repo = yield* relay.registerRepository("repo", [])
      const dependency = yield* relay.createTask({ repositoryId: repo.id, title: "Dependency" })
      const dependent = yield* relay.createTask({
        repositoryId: repo.id, title: "Dependent", dependencies: [dependency.id]
      })
      const now = Date.now()
      const saved = yield* store.saveTasksAndEvents([
        {
          task: { ...dependency, status: "completed", revision: dependency.revision + 1, updatedAt: now },
          event: { type: "TaskCompleted", taskId: dependency.id, actor: "agent-a", payload: {}, createdAt: now },
          expectedRevision: dependency.revision
        },
        {
          task: { ...dependent, status: "pending", revision: dependent.revision + 1, updatedAt: now },
          event: { type: "TaskUnblocked", taskId: dependent.id, actor: "agent-a", payload: {}, createdAt: now },
          expectedRevision: dependent.revision + 1
        }
      ])
      return {
        saved,
        dependency: yield* relay.getTask(dependency.id),
        dependent: yield* relay.getTask(dependent.id),
        events: yield* relay.getEvents()
      }
    }))
    expect(result.saved).toBeUndefined()
    expect(result.dependency.status).toBe("pending")
    expect(result.dependent.status).toBe("blocked")
    expect(result.events).toHaveLength(2)
  })

  it("recovers task state and events after a store restart", async () => {
    const file = join(process.cwd(), `.relay-restart-${crypto.randomUUID()}.db`)
    try {
      const created = await withFileRelay(file, Effect.gen(function* () {
        const relay = yield* Coordination
        const repo = yield* relay.registerRepository("persistent", [])
        const task = yield* relay.createTask({ repositoryId: repo.id, title: "Survive restart" })
        yield* relay.claimTask(task.id, "agent-a")
        return task.id
      }))
      const recovered = await withFileRelay(file, Effect.gen(function* () {
        const relay = yield* Coordination
        return { task: yield* relay.getTask(created), events: yield* relay.getEvents() }
      }))
      expect(recovered.task.assignee).toBe("agent-a")
      expect(recovered.events.length).toBe(2)
    } finally {
      rmSync(file, { force: true })
      rmSync(`${file}-wal`, { force: true })
      rmSync(`${file}-shm`, { force: true })
    }
  })
})

const withFileRelay = <A>(file: string, program: Effect.Effect<A, any, never>) =>
  Effect.runPromise(Effect.scoped(program.pipe(
    Effect.provide(CoordinationLive),
    Effect.provide(StoreLive(file))
  )))
