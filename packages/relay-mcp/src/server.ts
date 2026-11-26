import { McpServer, Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Schema } from "effect"
import { RelayRpcClient, RelayRpcClientLive } from "relay-daemon/client"
import { relaySocketPath } from "relay-daemon/socket"
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
const GetMetrics = Tool.make("get_metrics", {
  ...Results,
  description: "Show persisted MCP call counts and estimated tokens saved versus sending the full Relay workspace snapshot. Estimates use 4 characters per token."
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false)

export const RelayToolkit = Toolkit.make(
  RegisterRepository, ListRepositories, ListTasks, GetTask, CreateTask, ClaimTask, UpdateTask,
  ReportProgress, PublishArtifact, CompleteTask, GetEvents, WaitForEvent, GetMetrics
)

const handlers = RelayToolkit.toLayer(Effect.gen(function* () {
  const relay = yield* RelayRpcClient
  const serialize = (value: unknown) => JSON.stringify(value) ?? "null"
  const record = (tool: string, input: unknown, output: unknown) =>
    relay.RecordMcpToolCall({
      tool,
      requestCharacters: serialize(input).length,
      responseCharacters: serialize(output).length
    }).pipe(Effect.catchAll(() => Effect.void))
  const safely = <A, E>(tool: string, input: unknown, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapBoth({
        onFailure: error => record(tool, input, { error: error instanceof Error ? error.message : String(error) }),
        onSuccess: output => record(tool, input, output)
      }),
      Effect.mapError(error => ({
      message: error instanceof Error && Object.keys(error).length === 0
        ? error.message
        : JSON.stringify(error)
      }))
    )
  return {
  register_repository: input => safely("register_repository", input, relay.RegisterRepository(input)),
  list_repositories: () => safely("list_repositories", {}, relay.ListRepositories(undefined).pipe(Effect.map(repositories => ({ repositories })))),
  list_tasks: input => safely("list_tasks", input,
    relay.ListTasks(undefined).pipe(Effect.map(tasks => ({
      tasks: tasks
        .filter(task => !input.repositoryId || task.repositoryId === input.repositoryId)
        .filter(task => !input.status || task.status === input.status)
        .map(({ id, repositoryId, title, status, priority, assignee, updatedAt }) =>
          ({ id, repositoryId, title, status, priority, assignee, updatedAt }))
    })))
  ),
  get_task: input => safely("get_task", input, relay.GetTask({ taskId: input.taskId as TaskId })),
  create_task: input => safely("create_task", input, relay.CreateTask({
      repositoryId: input.repositoryId, title: input.title, description: input.description,
      priority: input.priority as TaskPriority | undefined,
      dependencies: input.dependencies as ReadonlyArray<TaskId> | undefined,
      actor: input.actor
    })),
  claim_task: input => safely("claim_task", input, relay.ClaimTask({ taskId: input.taskId as TaskId, actor: input.actor })),
  update_task: input => safely("update_task", input, relay.UpdateTask({
      taskId: input.taskId as TaskId, status: input.status as TaskStatus | undefined,
      title: input.title, description: input.description, actor: input.actor
    })),
  report_progress: input => safely("report_progress", input, relay.ReportProgress({
    taskId: input.taskId as TaskId, message: input.message, actor: input.actor
  })),
  publish_artifact: input => safely("publish_artifact", input, relay.PublishArtifact({
    taskId: input.taskId as TaskId, artifact: input.artifact, actor: input.actor
  })),
  complete_task: input => safely("complete_task", input, relay.CompleteTask({ taskId: input.taskId as TaskId, actor: input.actor })),
  get_events: input => safely("get_events", input, relay.GetEvents({ afterId: input.afterId }).pipe(Effect.map(events => ({ events })))),
  wait_for_event: input => safely("wait_for_event", input,
    relay.WaitForEvent({
      taskId: input.taskId as TaskId,
      types: input.types as ReadonlyArray<EventType> | undefined,
      timeoutMs: input.timeoutMs ?? 30_000
    }).pipe(Effect.map(event => ({ event })))
  ),
  get_metrics: () => relay.GetMcpMetrics()
  }
}))

export const RelayMcpLayer = McpServer.toolkit(RelayToolkit).pipe(
  Layer.provide(handlers),
  Layer.provide(RelayRpcClientLive(relaySocketPath()))
)
