import { Context, Effect, Layer, PubSub, Queue, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { Conflict, InvalidTransition, NotFound } from "./errors.js"
import { Store, type TaskMutation } from "./store.js"
import type { EventType, McpMetrics, RelayEvent, Repository, Task, TaskId, TaskPriority, TaskStatus } from "./domain.js"

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
  readonly createTask: (input: NewTask, actor?: string) => Effect.Effect<Task, NotFound | Conflict>
  readonly listTasks: () => Effect.Effect<ReadonlyArray<Task>>
  readonly getTask: (id: TaskId) => Effect.Effect<Task, NotFound>
  readonly claimTask: (id: TaskId, actor: string) => Effect.Effect<Task, NotFound | Conflict>
  readonly updateTask: (id: TaskId, patch: { status?: TaskStatus; title?: string; description?: string }, actor: string) =>
    Effect.Effect<Task, NotFound | InvalidTransition | Conflict>
  readonly reportProgress: (id: TaskId, message: string, actor: string) => Effect.Effect<RelayEvent, NotFound | Conflict>
  readonly publishArtifact: (id: TaskId, artifact: string, actor: string) => Effect.Effect<RelayEvent, NotFound | Conflict>
  readonly completeTask: (id: TaskId, actor: string) => Effect.Effect<Task, NotFound | InvalidTransition | Conflict>
  readonly waitForTask: (id: TaskId, statuses: ReadonlyArray<TaskStatus>) =>
    Effect.Effect<Task, NotFound, Scope.Scope>
  readonly getEvents: (afterId?: number) => Effect.Effect<ReadonlyArray<RelayEvent>>
  readonly subscribe: (taskId?: TaskId, types?: ReadonlyArray<EventType>) => Effect.Effect<Queue.Dequeue<RelayEvent>, never, Scope.Scope>
  readonly recordMcpToolCall: (tool: string, requestCharacters: number, responseCharacters: number) => Effect.Effect<void>
  readonly getMcpMetrics: () => Effect.Effect<McpMetrics>
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
    const getTask = (id: TaskId) => Effect.flatMap(store.getTask(id), task =>
      task ? Effect.succeed(task) : Effect.fail(new NotFound({ entity: "task", id })))
    const save = (task: Task, type: EventType, actor: string, payload: Record<string, unknown>, expectedRevision?: number) =>
      Effect.gen(function* () {
        const savedEvent = yield* store.saveTaskAndEvent(task, event(task.id, type, actor, payload), expectedRevision)
        if (!savedEvent) return yield* Effect.fail(new Conflict({ message: "task changed concurrently; reload and retry" }))
        yield* PubSub.publish(pubsub, savedEvent)
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
          assignee: null, dependencies: [...(input.dependencies ?? [])], progress: [], artifacts: [], revision: 0,
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
        // RPC callers send omitted fields as explicit undefined; spreading those would erase the stored values.
        const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as typeof patch
        const updated = { ...current, ...changes, revision: current.revision + 1, updatedAt: Date.now() } as Task
        return yield* save(updated, changes.status === "completed" ? "TaskCompleted" : "TaskUpdated", actor, changes, current.revision)
      }),
      reportProgress: (id, message, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        const updated = { ...current, progress: [...current.progress, message], revision: current.revision + 1, updatedAt: Date.now() }
        const savedEvent = yield* store.saveTaskAndEvent(updated, event(id, "ProgressReported", actor, { message }), current.revision)
        if (!savedEvent) return yield* Effect.fail(new Conflict({ message: "task changed concurrently; reload and retry" }))
        yield* PubSub.publish(pubsub, savedEvent)
        return savedEvent
      }),
      publishArtifact: (id, artifact, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        const updated = { ...current, artifacts: [...current.artifacts, artifact], revision: current.revision + 1, updatedAt: Date.now() }
        const savedEvent = yield* store.saveTaskAndEvent(updated, event(id, "ArtifactPublished", actor, { artifact }), current.revision)
        if (!savedEvent) return yield* Effect.fail(new Conflict({ message: "task changed concurrently; reload and retry" }))
        yield* PubSub.publish(pubsub, savedEvent)
        return savedEvent
      }),
      completeTask: (id, actor) => Effect.gen(function* () {
        const current = yield* getTask(id)
        if (current.status === "cancelled" || current.status === "completed") {
          return yield* Effect.fail(new InvalidTransition({ from: current.status, to: "completed" }))
        }
        const tasks = yield* store.listTasks()
        const now = Date.now()
        const completed = { ...current, status: "completed" as const, revision: current.revision + 1, updatedAt: now }
        const mutations: TaskMutation[] = [{
          task: completed,
          event: event(id, "TaskCompleted", actor, {}),
          expectedRevision: current.revision
        }]
        for (const dependent of tasks) {
          if (dependent.status === "blocked" && dependent.dependencies.includes(id)) {
            const dependenciesReady = dependent.dependencies.every(dependency =>
              tasks.some(task => task.id === dependency && (task.id === id || task.status === "completed")))
            if (dependenciesReady) {
              mutations.push({
                task: { ...dependent, status: "pending", revision: dependent.revision + 1, updatedAt: now },
                event: event(dependent.id, "TaskUnblocked", actor, { dependency: id }),
                expectedRevision: dependent.revision
              })
            }
          }
        }
        const savedEvents = yield* store.saveTasksAndEvents(mutations)
        if (!savedEvents) return yield* Effect.fail(new Conflict({ message: "task changed concurrently; reload and retry" }))
        for (const savedEvent of savedEvents) yield* PubSub.publish(pubsub, savedEvent)
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
      recordMcpToolCall: (tool, requestCharacters, responseCharacters) =>
        store.recordMcpToolCall(tool, requestCharacters, responseCharacters, Date.now()),
      getMcpMetrics: () => store.getMcpMetrics(),
      subscribe: (taskId, types) => Effect.gen(function* () {
        const source = yield* PubSub.subscribe(pubsub)
        const output = yield* Queue.unbounded<RelayEvent>()
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(source), item =>
          (!taskId || item.taskId === taskId) && (!types || types.includes(item.type))
            ? Queue.offer(output, item)
            : Effect.void)))
        return output
      })
    })
  })
)
