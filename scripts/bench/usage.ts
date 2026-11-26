import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface TokenUsage {
  readonly input: number
  readonly cacheWrite: number
  readonly cacheRead: number
  readonly output: number
}

export const emptyUsage: TokenUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output
})

export const totalTokens = (usage: TokenUsage) => usage.input + usage.cacheWrite + usage.cacheRead + usage.output

// Claude Code may write one transcript line per content block of the same API message, each carrying
// that message's usage, so usage is counted once per message id.
const transcriptUsage = (path: string): TokenUsage => {
  const byMessage = new Map<string, TokenUsage>()
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    const usage = record.type === "assistant" ? record.message?.usage : undefined
    if (!usage || !record.message?.id) continue
    byMessage.set(record.message.id, {
      input: usage.input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? 0
    })
  }
  return [...byMessage.values()].reduce(addUsage, emptyUsage)
}

const toolCalls = (path: string): Record<string, number> => {
  const counts: Record<string, number> = {}
  const seen = new Set<string>()
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue
    for (const block of record.message.content) {
      if (block.type !== "tool_use" || seen.has(block.id)) continue
      seen.add(block.id)
      counts[block.name] = (counts[block.name] ?? 0) + 1
    }
  }
  return counts
}

export interface SessionUsage {
  readonly orchestrator: TokenUsage
  readonly orchestratorToolCalls: Record<string, number>
  readonly subagents: ReadonlyArray<{ readonly agent: string; readonly usage: TokenUsage }>
  readonly total: TokenUsage
}

// Session transcripts live at ~/.claude/projects/<cwd slug>/<session id>.jsonl, with subagent
// transcripts in <session id>/subagents/agent-<id>.jsonl next to it.
export const sessionUsage = (projectsDirectory: string, sessionId: string): SessionUsage => {
  const project = readdirSync(projectsDirectory)
    .map(name => join(projectsDirectory, name))
    .find(directory => existsSync(join(directory, `${sessionId}.jsonl`)))
  if (!project) throw new Error(`no transcript found for session ${sessionId}`)
  const orchestrator = transcriptUsage(join(project, `${sessionId}.jsonl`))
  const subagentDirectory = join(project, sessionId, "subagents")
  const subagents = existsSync(subagentDirectory)
    ? readdirSync(subagentDirectory)
      .filter(name => name.endsWith(".jsonl"))
      .map(name => {
        const meta = join(subagentDirectory, name.replace(/\.jsonl$/, ".meta.json"))
        const agent = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")).agentType ?? name : name
        return { agent, usage: transcriptUsage(join(subagentDirectory, name)) }
      })
    : []
  return {
    orchestrator,
    orchestratorToolCalls: toolCalls(join(project, `${sessionId}.jsonl`)),
    subagents,
    total: subagents.map(s => s.usage).reduce(addUsage, orchestrator)
  }
}
