import type { AppState } from "../context/state.js"

const esc = "\u001b["
const bold = (text: string) => `\u001b[1m${text}\u001b[0m`
const dim = (text: string) => `\u001b[2m${text}\u001b[0m`

export const render = (state: AppState) => {
  const width = Math.max(50, process.stdout.columns ?? 80)
  const rule = "─".repeat(width)
  process.stdout.write(`${esc}2J${esc}H`)
  console.log(`${bold(" ◈ RELAY")} ${dim("coordination workspace")}`)
  console.log(dim(rule))
  if (state.view === "events") {
    console.log(`\n  ${bold("EVENT STREAM")}  ${dim("latest 30")}\n`)
    if (state.events.length === 0) console.log("  No events yet.")
    for (const event of state.events.slice(-30).reverse()) {
      console.log(`  #${String(event.id).padEnd(4)} ${event.type.padEnd(18)} ${event.taskId}  ${dim(`@${event.actor}`)}`)
    }
  } else if (state.view === "details" && state.tasks[state.selected]) {
    const selected = state.tasks[state.selected]
    console.log(`\n  ${bold(selected.title)}\n`)
    console.log(`  ${dim("ID")}           ${selected.id}`)
    console.log(`  ${dim("STATUS")}       ${selected.status}`)
    console.log(`  ${dim("PRIORITY")}     ${selected.priority}`)
    console.log(`  ${dim("ASSIGNEE")}     ${selected.assignee ?? "unassigned"}`)
    console.log(`  ${dim("REPOSITORY")}   ${state.repositories.find(repo => repo.id === selected.repositoryId)?.name ?? selected.repositoryId}`)
    console.log(`  ${dim("DEPENDENCIES")} ${selected.dependencies.join(", ") || "none"}`)
    console.log(`\n  ${dim(selected.description || "No description.")}`)
    console.log(`\n  ${bold("PROGRESS")}`)
    for (const update of selected.progress) console.log(`  · ${update}`)
    if (!selected.progress.length) console.log(`  ${dim("No progress reported.")}`)
    console.log(`\n  ${bold("ARTIFACTS")}`)
    for (const artifact of selected.artifacts) console.log(`  · ${artifact}`)
    if (!selected.artifacts.length) console.log(`  ${dim("No artifacts published.")}`)
  } else {
    console.log(`\n  ${bold("TASK BOARD")}  ${dim(`${state.tasks.length} tasks · ${state.repositories.length} repositories`)}\n`)
    if (!state.tasks.length) console.log(`  ${dim("No tasks yet. Press n to create one.")}`)
    for (const [index, task] of state.tasks.entries()) {
      const marker = index === state.selected ? "›" : " "
      const status = task.status.toUpperCase().padEnd(11)
      const owner = task.assignee ? ` @${task.assignee}` : ""
      const title = task.title.length > width - 42 ? `${task.title.slice(0, width - 45)}…` : task.title
      console.log(`  ${marker} ${status} ${task.priority.padEnd(7)} ${title}${dim(owner)}`)
    }
  }
  console.log(`\n${dim(rule)}`)
  if (state.titleInput !== null) {
    console.log(`  New task title: ${state.titleInput}█`)
    console.log(dim("  Enter create   Esc cancel"))
  } else {
    console.log(`  ${state.message || (state.loading ? "Refreshing…" : "Connected")}`)
    console.log(dim("  ↑/↓ navigate   enter details   n new task   e events   r refresh   q quit"))
  }
}
