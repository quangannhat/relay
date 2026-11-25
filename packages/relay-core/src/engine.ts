import { Context, Effect, Layer, PubSub, Queue, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { Conflict, InvalidTransition, NotFound } from "./errors.js"
import { Store } from "./store.js"
import type { EventType, RelayEvent, Repository, Task, TaskId, TaskPriority, TaskStatus } from "./domain.js"

export type NewTask = {
  readonly repositoryId: string
  readonly title: string
  readonly description?: string
  readonly priority?: TaskPriority
  readonly dependencies?: ReadonlyArray<TaskId>
}

export class Coordination extends Context.Tag("relay/Coordination")<Coordination, {
  readonly registerRepository: (name: string, paths: ReadonlyArray<string>) => Effect.Effect<Repository>
  readonly listRepositories: () => Effect.Effect<ReadonlyArray<Repository>>
  readonly createTask: (input: NewTask, actor?: string) => Effect.Effect<Task, NotFound>
  readonly listTasks: () => Effect.Effect<ReadonlyArray<Task>>
  readonly getTask: (id: TaskId) => Effect.Effect<Task, NotFound>
  readonly claimTask: (id: TaskId, actor: string) => Effect.Effect<Task, NotFound | Conflict>
  readonly updateTask: (id: TaskId, patch: { status?: TaskStatus; title?: string; description?: string }, actor: string) =>
    Effect.Effect<Task, NotFound | InvalidTransition>
  readonly reportProgress: (id: TaskId, message: string, actor: string) => Effect.Effect<RelayEvent, NotFound>
  readonly publishArtifact: (id: TaskId, artifact: string, actor: string) => Effect.Effect<RelayEvent, NotFound>
  readonly completeTask: (id: TaskId, actor: string) => Effect.Effect<Task, NotFound | InvalidTransition>
  readonly waitForTask: (id: TaskId, statuses: ReadonlyArray<TaskStatus>) =>
    Effect.Effect<Task, NotFound, Scope.Scope>
  readonly getEvents: (afterId?: number) => Effect.Effect<ReadonlyArray<RelayEvent>>
  readonly subscribe: (taskId: TaskId, types?: ReadonlyArray<EventType>) => Effect.Effect<Queue.Dequeue<RelayEvent>, never, Scope.Scope>
}>() {}

const event = (taskId: TaskId, type: EventType, actor: string, payload: Record<string, unknown>): Omit<RelayEvent, "id"> => ({
  taskId, type, actor, payload, createdAt: Date.now()
})

const canTransition = (from: TaskStatus, to: TaskStatus): boolean => ({
  pending: ["pending", "in_progress", "blocked", "cancelled"],
  in_progress: ["in_progress", "blocked", "completed", "cancelled"],
  blocked: ["blocked", "in_progress", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"]
}[from] as ReadonlyArray<TaskStatus>).includes(to)

export const CoordinationLive = Layer.effect(
  Coordination,
  Effect.gen(function* () {
    const store = yield* Store
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<RelayEvent>(), () => Effect.void)
    const publish = (input: Omit<RelayEvent, "id">) => Effect.gen(function* () {
      const saved = yield* store.appendEvent(input)
      yield* PubSub.publish(pubsub, saved)
      return saved
    })
    const getTask = (id: TaskId) => Effect.flatMap(store.getTask(id), task =>
      task ? Effect.succeed(task) : Effect.fail(new NotFound({ entity: "task", id })))
    const save = (task: Task, type: EventType, actor: string, payload: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* store.saveTask(task)
        yield* publish(event(task.id, type, actor, payload))
        return task
      })
    return Coordination.of({
      registerRepository: (name, paths) => Effect.gen(function* () {
        const repository = { id: `R-${randomUUID().slice(0, 8)}`, name, paths: [...paths], createdAt: Date.now() } as unknown as Repository
        yield* store.addRepository(repository)
        return repository
      }),
      listRepositories: () => store.listRepositories(),
      createTask: (input, actor = "system") => Effect.gen(function* () {
        const repository = yield* Effect.flatMap(store.listRepositories(), repositories =>
          repositories.find(r => r.id === input.repositoryId)
            ? Effect.succeed(true) : Effect.fail(new NotFound({ entity: "repository", id: input.repositoryId })))
        void repository
        const existingTasks = yield* store.listTasks()
        for (const dependency of input.dependencies ?? []) {
          if (!existingTasks.some(task => task.id === dependency)) {
            return yield* Effect.fail(new NotFound({ entity: "task", id: dependency }))
          }
        }
        const now = Date.now()
        const task = {
          id: `T-${randomUUID().slice(0, 8)}`, repositoryId: input.repositoryId, title: input.title,
          description: input.description ?? "",
          status: input.dependencies?.length ? "blocked" as const : "pending" as const,
          priority: input.priority ?? "normal",
          assignee: null, dependencies: [...(input.dependencies ?? [])], progress: [], artifacts: [],
          createdAt: now, updatedAt: now
        } as unknown as Task
        return yield* save(task, "TaskCreated", actor, { title: task.title })
      }),
      listTasks: () => store.listTasks(),
      getTask,
      claimTask: (id, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        if (current.status !== "pending" || current.assignee !== null) return yield* Effect.fail(new Conflict({ message: "task is already claimed or not pending" }))
        const tasks = yield* store.listTasks()
        if (!current.dependencies.every(dependency => tasks.some(task => task.id === dependency && task.status === "completed"))) {
          return yield* Effect.fail(new Conflict({ message: "task dependencies are not completed" }))
        }
        const claimed = yield* store.claimTask(id, actor, Date.now())
        if (!claimed) return yield* Effect.fail(new Conflict({ message: "task was claimed concurrently" }))
        yield* PubSub.publish(pubsub, claimed.event)
        return claimed.task
      }),
      updateTask: (id, patch, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        if (patch.status && !canTransition(current.status, patch.status)) {
          return yield* Effect.fail(new InvalidTransition({ from: current.status, to: patch.status }))
        }
        const updated = { ...current, ...patch, updatedAt: Date.now() } as Task
        return yield* save(updated, patch.status === "completed" ? "TaskCompleted" : "TaskUpdated", actor, patch)
      }),
      reportProgress: (id, message, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        const updated = { ...current, progress: [...current.progress, message], updatedAt: Date.now() }
        yield* store.saveTask(updated)
        return yield* publish(event(id, "ProgressReported", actor, { message }))
      }),
      publishArtifact: (id, artifact, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        const updated = { ...current, artifacts: [...current.artifacts, artifact], updatedAt: Date.now() }
        yield* store.saveTask(updated)
        return yield* publish(event(id, "ArtifactPublished", actor, { artifact }))
      }),
      completeTask: (id, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        if (current.status === "cancelled" || current.status === "completed") {
          return yield* Effect.fail(new InvalidTransition({ from: current.status, to: "completed" }))
        }
        const completed = yield* save({ ...current, status: "completed", updatedAt: Date.now() }, "TaskCompleted", actor, {})
        const tasks = yield* store.listTasks()
        for (const dependent of tasks) {
          if (dependent.status === "blocked" && dependent.dependencies.includes(id)) {
            const dependenciesReady = dependent.dependencies.every(dependency =>
              tasks.some(task => task.id === dependency && (task.id === id || task.status === "completed")))
            if (dependenciesReady) {
              yield* save({ ...dependent, status: "pending", updatedAt: Date.now() }, "TaskUnblocked", actor, { dependency: id })
            }
          }
        }
        return completed
      }),
      waitForTask: (id, statuses) => Effect.gen(function* () {
        const queue = yield* PubSub.subscribe(pubsub)
        const loop = (): Effect.Effect<Task, NotFound, Scope.Scope> => Effect.gen(function* () {
          const current = yield* getTask(id)
          if (statuses.includes(current.status)) return current
          yield* Queue.take(queue)
          return yield* loop()
        })
        return yield* loop()
      }),
      getEvents: (afterId) => store.listEvents(afterId),
      subscribe: (taskId, types) => Effect.gen(function* () {
        const source = yield* PubSub.subscribe(pubsub)
        const output = yield* Queue.unbounded<RelayEvent>()
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(source), item =>
          item.taskId === taskId && (!types || types.includes(item.type))
            ? Queue.offer(output, item)
            : Effect.void)))
        return output
      })
    })
  })
)
