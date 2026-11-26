import { Rpc, RpcGroup, RpcSchema } from "@effect/rpc"
import { Schema } from "effect"
import {
  EventType, McpMetrics, RelayEvent, Repository, Task, TaskId, TaskPriority, TaskStatus
} from "relay-core/domain"

export const RelayRpcError = Schema.Union(
  Schema.TaggedStruct("NotFound", { entity: Schema.String, id: Schema.String }),
  Schema.TaggedStruct("Conflict", { message: Schema.String }),
  Schema.TaggedStruct("InvalidTransition", { from: Schema.String, to: Schema.String })
)

export const RelayRpc = RpcGroup.make(
  Rpc.make("RegisterRepository", {
    payload: { name: Schema.String, paths: Schema.Array(Schema.String) },
    success: Repository
  }),
  Rpc.make("ListRepositories", { success: Schema.Array(Repository) }),
  Rpc.make("CreateTask", {
    payload: {
      repositoryId: Schema.String,
      title: Schema.String,
      description: Schema.optional(Schema.String),
      priority: Schema.optional(TaskPriority),
      dependencies: Schema.optional(Schema.Array(TaskId)),
      actor: Schema.optional(Schema.String)
    },
    success: Task,
    error: RelayRpcError
  }),
  Rpc.make("ListTasks", { success: Schema.Array(Task) }),
  Rpc.make("GetTask", {
    payload: { taskId: TaskId },
    success: Task,
    error: RelayRpcError
  }),
  Rpc.make("ClaimTask", {
    payload: { taskId: TaskId, actor: Schema.String },
    success: Task,
    error: RelayRpcError
  }),
  Rpc.make("UpdateTask", {
    payload: {
      taskId: TaskId,
      status: Schema.optional(TaskStatus),
      title: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      actor: Schema.String
    },
    success: Task,
    error: RelayRpcError
  }),
  Rpc.make("ReportProgress", {
    payload: { taskId: TaskId, message: Schema.String, actor: Schema.String },
    success: RelayEvent,
    error: RelayRpcError
  }),
  Rpc.make("PublishArtifact", {
    payload: { taskId: TaskId, artifact: Schema.String, actor: Schema.String },
    success: RelayEvent,
    error: RelayRpcError
  }),
  Rpc.make("CompleteTask", {
    payload: { taskId: TaskId, actor: Schema.String },
    success: Task,
    error: RelayRpcError
  }),
  Rpc.make("GetEvents", {
    payload: { afterId: Schema.optional(Schema.Number) },
    success: Schema.Array(RelayEvent)
  }),
  Rpc.make("SubscribeEvents", {
    payload: { afterId: Schema.optional(Schema.Number) },
    success: RpcSchema.Stream({ success: RelayEvent, failure: Schema.Never })
  }),
  Rpc.make("RecordMcpToolCall", {
    payload: {
      tool: Schema.String,
      requestCharacters: Schema.Number,
      responseCharacters: Schema.Number
    },
    success: Schema.Void
  }),
  Rpc.make("GetMcpMetrics", { success: McpMetrics }),
  Rpc.make("WaitForEvent", {
    payload: {
      taskId: TaskId,
      types: Schema.optional(Schema.Array(EventType)),
      timeoutMs: Schema.Int.pipe(Schema.between(1, 300_000))
    },
    success: Schema.NullOr(RelayEvent)
  })
)
