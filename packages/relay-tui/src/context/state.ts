import type { RelayEvent, Repository, Task } from "relay-core/domain"

export type View = "board" | "events" | "details"
export type AppState = {
  view: View
  repositories: ReadonlyArray<Repository>
  tasks: ReadonlyArray<Task>
  events: ReadonlyArray<RelayEvent>
  selected: number
  message: string
  loading: boolean
  running: boolean
}

export const createState = (): AppState => ({
  view: "board",
  repositories: [],
  tasks: [],
  events: [],
  selected: 0,
  message: "Connecting to Relay daemon…",
  loading: true,
  running: true
})
