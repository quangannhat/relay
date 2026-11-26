import { Schema } from "effect"

export const RepositoryId = Schema.String.pipe(Schema.brand("RepositoryId"))
export type RepositoryId = Schema.Schema.Type<typeof RepositoryId>
export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = Schema.Schema.Type<typeof TaskId>

export const TaskStatus = Schema.Literal("pending", "in_progress", "blocked", "completed", "cancelled")
export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>
export const TaskPriority = Schema.Literal("low", "normal", "high", "urgent")
export type TaskPriority = Schema.Schema.Type<typeof TaskPriority>

export const Repository = Schema.Struct({
  id: RepositoryId,
  name: Schema.String,
  paths: Schema.Array(Schema.String),
  createdAt: Schema.Number
})
export type Repository = Schema.Schema.Type<typeof Repository>

export const Task = Schema.Struct({
  id: TaskId,
  repositoryId: RepositoryId,
  title: Schema.String,
  description: Schema.String,
  status: TaskStatus,
  priority: TaskPriority,
  assignee: Schema.NullOr(Schema.String),
  dependencies: Schema.Array(TaskId),
  progress: Schema.Array(Schema.String),
  artifacts: Schema.Array(Schema.String),
  revision: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number
})
export type Task = Schema.Schema.Type<typeof Task>

export const EventType = Schema.Literal(
  "TaskCreated", "TaskClaimed", "TaskUpdated", "TaskCompleted", "TaskBlocked",
  "TaskUnblocked", "ProgressReported", "ArtifactPublished"
)
export type EventType = Schema.Schema.Type<typeof EventType>

export const RelayEvent = Schema.Struct({
  id: Schema.Number,
  type: EventType,
  taskId: TaskId,
  actor: Schema.String,
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  createdAt: Schema.Number
})
export type RelayEvent = Schema.Schema.Type<typeof RelayEvent>

export const McpToolMetric = Schema.Struct({
  tool: Schema.String,
  calls: Schema.Number,
  requestCharacters: Schema.Number,
  responseCharacters: Schema.Number,
  estimatedRequestTokens: Schema.Number,
  estimatedResponseTokens: Schema.Number,
  estimatedWorkspaceBaselineTokens: Schema.Number,
  estimatedTokensSaved: Schema.Number,
  lastCalledAt: Schema.Number
})
export type McpToolMetric = Schema.Schema.Type<typeof McpToolMetric>

export const McpMetrics = Schema.Struct({
  calls: Schema.Number,
  requestCharacters: Schema.Number,
  responseCharacters: Schema.Number,
  estimatedRequestTokens: Schema.Number,
  estimatedResponseTokens: Schema.Number,
  estimatedWorkspaceBaselineTokens: Schema.Number,
  estimatedTokensSaved: Schema.Number,
  byTool: Schema.Array(McpToolMetric)
})
export type McpMetrics = Schema.Schema.Type<typeof McpMetrics>

export type TaskSummary = Pick<Task, "id" | "title" | "status" | "priority" | "assignee" | "updatedAt">
