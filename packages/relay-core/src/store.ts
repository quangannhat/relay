import { Database } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"
import type { RelayEvent, Repository, Task, TaskId } from "./domain.js"

type TaskRow = Omit<Task, "dependencies" | "progress" | "artifacts"> & {
  dependencies: string; progress: string; artifacts: string
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
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
})

export class Store extends Context.Tag("relay/Store")<Store, {
  readonly addRepository: (repository: Repository) => Effect.Effect<void>
  readonly listRepositories: () => Effect.Effect<ReadonlyArray<Repository>>
  readonly saveTask: (task: Task) => Effect.Effect<void>
  readonly listTasks: () => Effect.Effect<ReadonlyArray<Task>>
  readonly getTask: (id: TaskId) => Effect.Effect<Task | undefined>
  readonly claimTask: (id: TaskId, actor: string, now: number) => Effect.Effect<{ task: Task; event: RelayEvent } | undefined>
  readonly appendEvent: (event: Omit<RelayEvent, "id">) => Effect.Effect<RelayEvent>
  readonly listEvents: (afterId?: number) => Effect.Effect<ReadonlyArray<RelayEvent>>
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
          FOREIGN KEY (repository_id) REFERENCES repositories(id)
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task_id TEXT NOT NULL,
          actor TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
        );
      `)
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
    const saveTask = (value: Task) => Effect.sync(() => {
      db.query(`
        INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.id, value.repositoryId, value.title, value.description, value.status, value.priority,
        value.assignee, JSON.stringify(value.dependencies), JSON.stringify(value.progress),
        JSON.stringify(value.artifacts), value.createdAt, value.updatedAt)
    })
    const listTasks = () => Effect.sync(() =>
      db.query("SELECT *, created_at as createdAt, updated_at as updatedAt FROM tasks ORDER BY updated_at DESC")
        .all().map((r: any) => taskFromRow(r)))
    const getTask = (id: TaskId) => Effect.sync(() => {
      const row = db.query("SELECT *, created_at as createdAt, updated_at as updatedAt FROM tasks WHERE id = ?").get(id) as TaskRow | undefined
      return row && taskFromRow(row)
    })
    const claimTask = (id: TaskId, actor: string, now: number) => Effect.sync(() => {
      const transaction = db.transaction(() => {
        const result = db.query("UPDATE tasks SET status = 'in_progress', assignee = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND assignee IS NULL")
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
    const appendEvent = (value: Omit<RelayEvent, "id">) => Effect.sync(() => {
        const result = db.query("INSERT INTO events (type, task_id, actor, payload, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(value.type, value.taskId, value.actor, JSON.stringify(value.payload), value.createdAt)
        return { ...value, id: Number(result.lastInsertRowid) }
    })
    const listEvents = (afterId = 0) => Effect.sync(() =>
      db.query("SELECT id, type, task_id as taskId, actor, payload, created_at as createdAt FROM events WHERE id > ? ORDER BY id")
        .all(afterId).map((r: any) => ({ ...r, payload: JSON.parse(r.payload) })))
    return Store.of({
      addRepository, listRepositories, saveTask, listTasks, getTask, claimTask, appendEvent, listEvents
    })
  }))
)
