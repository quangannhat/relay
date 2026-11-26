import { McpServer, Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Option, Queue, Schema } from "effect"
import { Coordination, CoordinationLive } from "relay-core/engine"
import { StoreLive } from "relay-core"
import type { EventType, TaskId, TaskPriority, TaskStatus } from "relay-core/domain"

const TaskIdSchema = Schema.String
const Actor = Schema.String
const TaskStatuses = Schema.Literal("pending", "in_progress", "blocked", "completed", "cancelled")
const EventTypes = Schema.Literal(
  "TaskCreated", "TaskClaimed", "TaskUpdated", "TaskCompleted", "TaskBlocked",
  "TaskUnblocked", "ProgressReported", "ArtifactPublished"
)
const Results = {
  success: Schema.Unknown,
  failure: Schema.Struct({ message: Schema.String })
}
const RegisterRepository = Tool.make("register_repository", {
  ...Results,
  description: "Register a repository name and one or more local checkout paths.",
  parameters: { name: Schema.String, paths: Schema.Array(Schema.String) }
})
const ListRepositories = Tool.make("list_repositories", {
  ...Results,
  description: "List registered repositories.",
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false)
const ListTasks = Tool.make("list_tasks", {
  ...Results,
  description: "List compact task summaries; optionally filter by repository and status.",
  parameters: { repositoryId: Schema.optional(Schema.String), status: Schema.optional(TaskStatuses) }
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false)
const GetTask = Tool.make("get_task", {
  ...Results,
  description: "Get a task's full state, dependencies, progress, and artifacts.",
  parameters: { taskId: TaskIdSchema }
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false)
const CreateTask = Tool.make("create_task", {
  ...Results,
  description: "Create a task in a registered repository.",
  parameters: {
    repositoryId: Schema.String,
    title: Schema.String,
    description: Schema.optional(Schema.String),
    priority: Schema.optional(Schema.Literal("low", "normal", "high", "urgent")),
    dependencies: Schema.optional(Schema.Array(Schema.String)),
    actor: Schema.optional(Actor)
  }
})
const ClaimTask = Tool.make("claim_task", {
  ...Results,
  description: "Atomically claim a pending task.",
  parameters: { taskId: TaskIdSchema, actor: Actor }
})
const UpdateTask = Tool.make("update_task", {
  ...Results,
  description: "Update task status, title, or description.",
  parameters: {
    taskId: TaskIdSchema,
    status: Schema.optional(TaskStatuses),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    actor: Actor
  }
})
const ReportProgress = Tool.make("report_progress", {
  ...Results,
  description: "Append a concise progress update to a task.",
  parameters: { taskId: TaskIdSchema, message: Schema.String, actor: Actor }
})
const PublishArtifact = Tool.make("publish_artifact", {
  ...Results,
  description: "Publish an artifact reference on a task.",
  parameters: { taskId: TaskIdSchema, artifact: Schema.String, actor: Actor }
})
const CompleteTask = Tool.make("complete_task", {
  ...Results,
  description: "Complete a task and atomically unblock ready dependents.",
  parameters: { taskId: TaskIdSchema, actor: Actor }
})
const GetEvents = Tool.make("get_events", {
  ...Results,
  description: "Get persisted events with IDs greater than afterId.",
  parameters: { afterId: Schema.optional(Schema.Number) }
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false)
const WaitForEvent = Tool.make("wait_for_event", {
  ...Results,
  description: "Wait up to timeoutMs for a matching task event; use get_events(afterId) to recover missed events.",
  parameters: {
    taskId: TaskIdSchema,
    types: Schema.optional(Schema.Array(EventTypes)),
    timeoutMs: Schema.optional(Schema.Int.pipe(Schema.between(1, 300_000)))
  }
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false)

export const RelayToolkit = Toolkit.make(
  RegisterRepository, ListRepositories, ListTasks, GetTask, CreateTask, ClaimTask, UpdateTask,
  ReportProgress, PublishArtifact, CompleteTask, GetEvents, WaitForEvent
)

const handlers = RelayToolkit.toLayer(Effect.gen(function* () {
  const relay = yield* Coordination
  const safely = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(error => ({
      message: error instanceof Error && Object.keys(error).length === 0
        ? error.message
        : JSON.stringify(error)
    })))
  return {
  register_repository: ({ name, paths }) => safely(relay.registerRepository(name, paths)),
  list_repositories: () => safely(relay.listRepositories()),
  list_tasks: ({ repositoryId, status }) => safely(relay.listTasks().pipe(Effect.map(tasks => tasks
      .filter(task => !repositoryId || task.repositoryId === repositoryId)
      .filter(task => !status || task.status === status)
      .map(({ id, repositoryId, title, status, priority, assignee, updatedAt }) =>
        ({ id, repositoryId, title, status, priority, assignee, updatedAt }))))),
  get_task: ({ taskId }) => safely(relay.getTask(taskId as TaskId)),
  create_task: ({ repositoryId, title, description, priority, dependencies, actor }) => safely(relay.createTask({
      repositoryId, title, description,
      priority: priority as TaskPriority | undefined,
      dependencies: dependencies as ReadonlyArray<TaskId> | undefined
    }, actor)),
  claim_task: ({ taskId, actor }) => safely(relay.claimTask(taskId as TaskId, actor)),
  update_task: ({ taskId, status, title, description, actor }) => safely(relay.updateTask(taskId as TaskId, {
      status: status as TaskStatus | undefined, title, description
    }, actor)),
  report_progress: ({ taskId, message, actor }) => safely(relay.reportProgress(taskId as TaskId, message, actor)),
  publish_artifact: ({ taskId, artifact, actor }) => safely(relay.publishArtifact(taskId as TaskId, artifact, actor)),
  complete_task: ({ taskId, actor }) => safely(relay.completeTask(taskId as TaskId, actor)),
  get_events: ({ afterId }) => safely(relay.getEvents(afterId)),
  wait_for_event: ({ taskId, types, timeoutMs }) => safely(Effect.scoped(Effect.gen(function* () {
      const queue = yield* relay.subscribe(taskId as TaskId, types as ReadonlyArray<EventType> | undefined)
      return yield* Effect.map(
        Effect.timeoutOption(Queue.take(queue), timeoutMs ?? 30_000),
        Option.match({ onNone: () => null, onSome: event => event })
      )
    })))
  }
}))

export const RelayMcpLayer = McpServer.toolkit(RelayToolkit).pipe(
  Layer.provide(handlers),
  Layer.provide(CoordinationLive),
  Layer.provide(StoreLive(process.env.RELAY_DB ?? "relay.db"))
)
