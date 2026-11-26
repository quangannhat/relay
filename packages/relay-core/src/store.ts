import { Database } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"
import type { McpMetrics, McpToolMetric, RelayEvent, Repository, Task, TaskId } from "./domain.js"

type TaskRow = Omit<Task, "dependencies" | "progress" | "artifacts"> & {
  dependencies: string; progress: string; artifacts: string
}
export type TaskMutation = {
  readonly task: Task
  readonly event: Omit<RelayEvent, "id">
  readonly expectedRevision?: number
}
const taskFromRow = (row: TaskRow): Task => ({
  id: row.id,
  repositoryId: (row as any).repository_id,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  assignee: row.assignee,
  dependencies: JSON.parse(row.dependencies),
  progress: JSON.parse(row.progress),
  artifacts: JSON.parse(row.artifacts),
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
})

export class Store extends Context.Tag("relay/Store")<Store, {
  readonly addRepository: (repository: Repository) => Effect.Effect<void>
  readonly listRepositories: () => Effect.Effect<ReadonlyArray<Repository>>
  readonly saveTaskAndEvent: (task: Task, event: Omit<RelayEvent, "id">, expectedRevision?: number) => Effect.Effect<RelayEvent | undefined>
  readonly saveTasksAndEvents: (mutations: ReadonlyArray<TaskMutation>) => Effect.Effect<ReadonlyArray<RelayEvent> | undefined>
  readonly listTasks: () => Effect.Effect<ReadonlyArray<Task>>
  readonly getTask: (id: TaskId) => Effect.Effect<Task | undefined>
  readonly claimTask: (id: TaskId, actor: string, now: number) => Effect.Effect<{ task: Task; event: RelayEvent } | undefined>
  readonly listEvents: (afterId?: number) => Effect.Effect<ReadonlyArray<RelayEvent>>
  readonly recordMcpToolCall: (tool: string, requestCharacters: number, responseCharacters: number, now: number) => Effect.Effect<void>
  readonly getMcpMetrics: () => Effect.Effect<McpMetrics>
}>() {}

export const StoreLive = (file = "relay.db") => Layer.scoped(
  Store,
  Effect.acquireRelease(
    Effect.sync(() => {
      const db = new Database(file)
      db.exec("PRAGMA journal_mode = WAL")
      db.exec(`
        CREATE TABLE IF NOT EXISTS repositories (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, paths TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
          status TEXT NOT NULL, priority TEXT NOT NULL, assignee TEXT, dependencies TEXT NOT NULL,
          progress TEXT NOT NULL, artifacts TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (repository_id) REFERENCES repositories(id)
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task_id TEXT NOT NULL,
          actor TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_tool_metrics (
          tool TEXT PRIMARY KEY,
          calls INTEGER NOT NULL,
          request_characters INTEGER NOT NULL,
          response_characters INTEGER NOT NULL,
          estimated_request_tokens INTEGER NOT NULL,
          estimated_response_tokens INTEGER NOT NULL,
          estimated_workspace_baseline_tokens INTEGER NOT NULL,
          estimated_tokens_saved INTEGER NOT NULL,
          last_called_at INTEGER NOT NULL
        );
      `)
      const taskColumns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
      if (!taskColumns.some(column => column.name === "revision")) {
        db.exec("ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")
      }
      return db
    }),
    db => Effect.sync(() => db.close())
  ).pipe(Effect.map(db => {
    const addRepository = (value: Repository) => Effect.sync(() => {
      db.query("INSERT OR REPLACE INTO repositories VALUES (?, ?, ?, ?)").run(
        value.id, value.name, JSON.stringify(value.paths), value.createdAt)
    })
    const listRepositories = () => Effect.sync(() =>
      db.query("SELECT id, name, paths, created_at as createdAt FROM repositories ORDER BY name")
        .all().map((r: any) => ({ ...r, paths: JSON.parse(r.paths) })))
    const saveTasksAndEvents = (mutations: ReadonlyArray<TaskMutation>) => Effect.sync(() => {
      const staleRevision = Symbol("stale revision")
      const transaction = db.transaction(() => {
        const savedEvents: Array<RelayEvent> = []
        for (const { task, event, expectedRevision } of mutations) {
          if (expectedRevision === undefined) {
            db.query(`
              INSERT INTO tasks
                (id, repository_id, title, description, status, priority, assignee, dependencies, progress, artifacts, created_at, updated_at, revision)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(task.id, task.repositoryId, task.title, task.description, task.status, task.priority,
              task.assignee, JSON.stringify(task.dependencies), JSON.stringify(task.progress),
              JSON.stringify(task.artifacts), task.createdAt, task.updatedAt, task.revision)
          } else {
            const result = db.query(`
              UPDATE tasks SET repository_id = ?, title = ?, description = ?, status = ?, priority = ?,
                assignee = ?, dependencies = ?, progress = ?, artifacts = ?, updated_at = ?, revision = ?
              WHERE id = ? AND revision = ?
            `).run(task.repositoryId, task.title, task.description, task.status, task.priority,
              task.assignee, JSON.stringify(task.dependencies), JSON.stringify(task.progress),
              JSON.stringify(task.artifacts), task.updatedAt, task.revision, task.id, expectedRevision)
            if (result.changes === 0) throw staleRevision
          }
          const inserted = db.query("INSERT INTO events (type, task_id, actor, payload, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(event.type, event.taskId, event.actor, JSON.stringify(event.payload), event.createdAt)
          savedEvents.push({ ...event, id: Number(inserted.lastInsertRowid) })
        }
        return savedEvents
      })
      try {
        return transaction()
      } catch (error) {
        if (error === staleRevision) return undefined
        throw error
      }
    })
    const saveTaskAndEvent = (task: Task, event: Omit<RelayEvent, "id">, expectedRevision?: number) =>
      Effect.map(saveTasksAndEvents([{ task, event, expectedRevision }]), events => events?.[0])
    const listTasks = () => Effect.sync(() =>
      db.query("SELECT *, created_at as createdAt, updated_at as updatedAt FROM tasks ORDER BY updated_at DESC")
        .all().map((r: any) => taskFromRow(r)))
    const getTask = (id: TaskId) => Effect.sync(() => {
      const row = db.query("SELECT *, created_at as createdAt, updated_at as updatedAt FROM tasks WHERE id = ?").get(id) as TaskRow | undefined
      return row && taskFromRow(row)
    })
    const claimTask = (id: TaskId, actor: string, now: number) => Effect.sync(() => {
      const transaction = db.transaction(() => {
        const result = db.query("UPDATE tasks SET status = 'in_progress', assignee = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'pending' AND assignee IS NULL")
          .run(actor, now, id)
        if (result.changes === 0) return undefined
        const row = db.query("SELECT *, created_at as createdAt, updated_at as updatedAt FROM tasks WHERE id = ?").get(id) as TaskRow
        const input = { type: "TaskClaimed" as const, taskId: id, actor, payload: { assignee: actor }, createdAt: now }
        const inserted = db.query("INSERT INTO events (type, task_id, actor, payload, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(input.type, input.taskId, input.actor, JSON.stringify(input.payload), input.createdAt)
        return { task: taskFromRow(row), event: { ...input, id: Number(inserted.lastInsertRowid) } }
      })
      return transaction()
    })
    const listEvents = (afterId = 0) => Effect.sync(() =>
      db.query("SELECT id, type, task_id as taskId, actor, payload, created_at as createdAt FROM events WHERE id > ? ORDER BY id")
        .all(afterId).map((r: any) => ({ ...r, payload: JSON.parse(r.payload) })))
    const recordMcpToolCall = (tool: string, requestCharacters: number, responseCharacters: number, now: number) =>
      Effect.gen(function* () {
        const workspace = {
          repositories: yield* listRepositories(),
          tasks: yield* listTasks(),
          events: yield* listEvents()
        }
        const requestTokens = Math.ceil(requestCharacters / 4)
        const responseTokens = Math.ceil(responseCharacters / 4)
        const baselineTokens = Math.ceil(JSON.stringify(workspace).length / 4)
        const tokensSaved = Math.max(0, baselineTokens - requestTokens - responseTokens)
        yield* Effect.sync(() => {
          db.query(`
            INSERT INTO mcp_tool_metrics (
              tool, calls, request_characters, response_characters,
              estimated_request_tokens, estimated_response_tokens,
              estimated_workspace_baseline_tokens, estimated_tokens_saved, last_called_at
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tool) DO UPDATE SET
              calls = calls + 1,
              request_characters = request_characters + excluded.request_characters,
              response_characters = response_characters + excluded.response_characters,
              estimated_request_tokens = estimated_request_tokens + excluded.estimated_request_tokens,
              estimated_response_tokens = estimated_response_tokens + excluded.estimated_response_tokens,
              estimated_workspace_baseline_tokens = estimated_workspace_baseline_tokens + excluded.estimated_workspace_baseline_tokens,
              estimated_tokens_saved = estimated_tokens_saved + excluded.estimated_tokens_saved,
              last_called_at = excluded.last_called_at
          `).run(tool, requestCharacters, responseCharacters, requestTokens, responseTokens, baselineTokens, tokensSaved, now)
        })
      })
    const getMcpMetrics = () => Effect.sync(() => {
      const byTool = db.query(`
        SELECT tool, calls, request_characters as requestCharacters,
          response_characters as responseCharacters,
          estimated_request_tokens as estimatedRequestTokens,
          estimated_response_tokens as estimatedResponseTokens,
          estimated_workspace_baseline_tokens as estimatedWorkspaceBaselineTokens,
          estimated_tokens_saved as estimatedTokensSaved,
          last_called_at as lastCalledAt
        FROM mcp_tool_metrics ORDER BY calls DESC, tool
      `).all() as Array<McpToolMetric>
      return byTool.reduce<McpMetrics>((total, metric) => ({
        calls: total.calls + metric.calls,
        requestCharacters: total.requestCharacters + metric.requestCharacters,
        responseCharacters: total.responseCharacters + metric.responseCharacters,
        estimatedRequestTokens: total.estimatedRequestTokens + metric.estimatedRequestTokens,
        estimatedResponseTokens: total.estimatedResponseTokens + metric.estimatedResponseTokens,
        estimatedWorkspaceBaselineTokens: total.estimatedWorkspaceBaselineTokens + metric.estimatedWorkspaceBaselineTokens,
        estimatedTokensSaved: total.estimatedTokensSaved + metric.estimatedTokensSaved,
        byTool: [...total.byTool, metric]
      }), {
        calls: 0,
        requestCharacters: 0,
        responseCharacters: 0,
        estimatedRequestTokens: 0,
        estimatedResponseTokens: 0,
        estimatedWorkspaceBaselineTokens: 0,
        estimatedTokensSaved: 0,
        byTool: []
      })
    })
    return Store.of({
      addRepository, listRepositories, saveTaskAndEvent, saveTasksAndEvents, listTasks, getTask, claimTask, listEvents,
      recordMcpToolCall, getMcpMetrics
    })
  }))
)
