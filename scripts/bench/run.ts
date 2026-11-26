import { Effect, Schedule } from "effect"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { RelayRpcClient, RelayRpcClientLive } from "../../packages/relay-daemon/src/client.js"
import { handoff } from "./handoff.js"
import type { Mode, Scenario } from "./scenario.js"
import { addUsage, emptyUsage, sessionUsage, totalTokens, type SessionUsage, type TokenUsage } from "./usage.js"

// Runs one scenario in relay and direct mode with headless Claude Code sessions and compares the
// tokens every session actually used, read from the transcripts of the orchestrator and its subagents.
//
//   bun run scripts/bench/run.ts --scenario handoff --runs 5 --model sonnet

const scenarios: Record<string, Scenario<any>> = { handoff }

const { values: options } = parseArgs({
  options: {
    scenario: { type: "string", default: "handoff" },
    runs: { type: "string", default: "5" },
    model: { type: "string", default: "sonnet" },
    modes: { type: "string", default: "relay,relay-lean,direct" },
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "bench-results" },
    "timeout-minutes": { type: "string", default: "10" }
  }
})

const scenario = scenarios[options.scenario!]
if (!scenario) throw new Error(`unknown scenario ${options.scenario}; known: ${Object.keys(scenarios).join(", ")}`)
const modes = options.modes!.split(",") as Array<Mode>
const runs = Number(options.runs)
const relayBin = Bun.env.RELAY_BIN ?? join(homedir(), ".local/bin/relay")
const projectsDirectory = join(homedir(), ".claude/projects")
const outDirectory = resolve(options.out!, `${scenario.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`)
mkdirSync(outDirectory, { recursive: true })

interface RunResult {
  readonly mode: Mode
  readonly run: number
  readonly seed: number
  readonly sessionId: string
  readonly correct: boolean
  readonly reason?: string
  readonly error?: string
  readonly costUsd: number
  readonly durationMs: number
  readonly turns: number
  readonly subagentsSpawned: number
  readonly permissionDenials: number
  readonly cliUsage: TokenUsage
  readonly usage?: SessionUsage
}

const registerRepository = (socketPath: string, path: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const relay = yield* RelayRpcClient
    const repository = yield* relay.RegisterRepository({ name: "bench", paths: [path] }).pipe(Effect.retry({
      schedule: Schedule.spaced("100 millis").pipe(Schedule.compose(Schedule.recurs(50)))
    }))
    return repository.id
  }).pipe(Effect.provide(RelayRpcClientLive(socketPath)))))

const runOnce = async (mode: Mode, run: number): Promise<RunResult> => {
  const seed = Number(options.seed) + run
  // Fixtures live outside the repository so no project CLAUDE.md or settings leak into the sessions.
  const workspace = mkdtempSync(join(tmpdir(), `relay-bench-${mode}-`))
  const control = join(workspace, ".bench")
  mkdirSync(control)
  const answer = scenario.setup(workspace, seed)
  const socketPath = join(control, "relay.sock")
  const databasePath = join(control, "relay.db")
  const daemon = mode !== "direct"
    ? Bun.spawn([relayBin, "daemon"], {
      env: { ...Bun.env, RELAY_SOCKET: socketPath, RELAY_DB: databasePath }, stdout: "ignore", stderr: "ignore"
    })
    : undefined
  try {
    const repositoryId = daemon ? await registerRepository(socketPath, workspace) : ""
    const mcpConfig = join(control, "mcp.json")
    writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: daemon
        ? { relay: { type: "stdio", command: relayBin, args: ["mcp"], env: { RELAY_SOCKET: socketPath, RELAY_DB: databasePath } } }
        : {}
    }))
    const agentsFile = join(control, "agents.json")
    writeFileSync(agentsFile, JSON.stringify(scenario.agents(mode)))
    const sessionId = crypto.randomUUID()
    // Subagents can only use built-in tools that the session has, so the orchestrator keeps the file
    // tools; whether it used them itself is recorded from its transcript instead.
    const builtinTools = ["Agent", "Read", "Grep", "Glob"]
    const allowed = [...builtinTools, ...(daemon ? ["mcp__relay"] : [])]
    const child = Bun.spawn([
      "claude", "-p", scenario.prompt(mode, repositoryId),
      "--model", options.model!, "--output-format", "json", "--session-id", sessionId,
      "--restricted", "--strict-mcp-config", "--mcp-config", mcpConfig, "--agents", agentsFile,
      "--tools", builtinTools.join(","), "--allowedTools", allowed.join(",")
    ], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill(), Number(options["timeout-minutes"]) * 60_000)
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    await child.exited
    clearTimeout(timer)
    let output: any
    try {
      output = JSON.parse(stdout)
    } catch {
      throw new Error(`claude exited ${child.exitCode} without JSON: ${(stderr || stdout).slice(0, 500)}`)
    }
    const cliUsage = Object.values(output.modelUsage ?? {}).reduce<TokenUsage>((total, model: any) => addUsage(total, {
      input: model.inputTokens ?? 0, cacheWrite: model.cacheCreationInputTokens ?? 0,
      cacheRead: model.cacheReadInputTokens ?? 0, output: model.outputTokens ?? 0
    }), emptyUsage)
    const grade = output.is_error
      ? { correct: false, reason: `session error: ${output.subtype}` }
      : scenario.grade(String(output.result ?? ""), answer)
    return {
      mode, run, seed, sessionId, ...grade,
      costUsd: output.total_cost_usd ?? 0,
      durationMs: output.duration_ms ?? 0,
      turns: output.num_turns ?? 0,
      subagentsSpawned: output.subagent_stats?.spawned ?? 0,
      permissionDenials: output.permission_denials?.length ?? 0,
      cliUsage,
      usage: sessionUsage(projectsDirectory, sessionId)
    }
  } finally {
    daemon?.kill()
    await daemon?.exited
    rmSync(workspace, { recursive: true, force: true })
  }
}

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const format = (value: number) => Number.isNaN(value) ? "-" : Math.round(value).toLocaleString("en-US")

const results: Array<RunResult> = []
// Interleave modes so drift in latency, caching or load over the session affects both equally.
for (let run = 0; run < runs; run++) {
  for (const mode of modes) {
    const label = `${mode} #${run + 1}`
    console.log(`▶ ${label}`)
    let result: RunResult
    try {
      result = await runOnce(mode, run)
    } catch (error) {
      result = {
        mode, run, seed: Number(options.seed) + run, sessionId: "", correct: false,
        error: error instanceof Error ? error.message : String(error),
        costUsd: 0, durationMs: 0, turns: 0, subagentsSpawned: 0, permissionDenials: 0, cliUsage: emptyUsage
      }
    }
    results.push(result)
    appendFileSync(join(outDirectory, "runs.jsonl"), JSON.stringify(result) + "\n")
    const tokens = result.usage ? totalTokens(result.usage.total) : 0
    console.log(`  ${result.correct ? "✓" : "✗"} ${format(tokens)} tokens, $${result.costUsd.toFixed(4)}, ` +
      `${(result.durationMs / 1000).toFixed(0)}s${result.reason ? ` — ${result.reason}` : ""}${result.error ? ` — ${result.error}` : ""}`)
  }
}

const summarize = (mode: Mode) => {
  const all = results.filter(result => result.mode === mode)
  const graded = all.filter(result => result.correct && result.usage)
  const pick = (f: (usage: TokenUsage) => number) => median(graded.map(result => f(result.usage!.total)))
  return {
    mode,
    runs: all.length,
    correct: graded.length,
    medianTotalTokens: pick(totalTokens),
    medianUncachedInput: pick(usage => usage.input + usage.cacheWrite),
    medianCacheRead: pick(usage => usage.cacheRead),
    medianOutput: pick(usage => usage.output),
    medianOrchestratorTokens: median(graded.map(result => totalTokens(result.usage!.orchestrator))),
    medianCostUsd: median(graded.map(result => result.costUsd)),
    minTotalTokens: Math.min(...graded.map(result => totalTokens(result.usage!.total))),
    maxTotalTokens: Math.max(...graded.map(result => totalTokens(result.usage!.total))),
    orchestratorUsedFileTools: all.filter(result =>
      ["Read", "Grep", "Glob"].some(tool => (result.usage?.orchestratorToolCalls[tool] ?? 0) > 0)).length,
    // If the CLI's own totals match the transcripts, modelUsage already includes subagents.
    cliMatchesTranscripts: all.filter(result => result.usage &&
      totalTokens(result.cliUsage) === totalTokens(result.usage.total)).length
  }
}

const summary = modes.map(summarize)
writeFileSync(join(outDirectory, "summary.json"), JSON.stringify({ options, summary }, null, 2))

const rows: Array<[string, (s: ReturnType<typeof summarize>) => string]> = [
  ["correct / runs", s => `${s.correct} / ${s.runs}`],
  ["median total tokens", s => format(s.medianTotalTokens)],
  ["  range", s => s.correct ? `${format(s.minTotalTokens)}–${format(s.maxTotalTokens)}` : "-"],
  ["  uncached input (input + cache write)", s => format(s.medianUncachedInput)],
  ["  cache read", s => format(s.medianCacheRead)],
  ["  output", s => format(s.medianOutput)],
  ["median orchestrator tokens", s => format(s.medianOrchestratorTokens)],
  ["median cost (USD)", s => Number.isNaN(s.medianCostUsd) ? "-" : `$${s.medianCostUsd.toFixed(4)}`],
  ["orchestrator read files itself", s => String(s.orchestratorUsedFileTools)],
  ["CLI totals match transcripts", s => `${s.cliMatchesTranscripts} / ${s.runs}`]
]
console.log(`\n${scenario.name} — model ${options.model}, ${runs} runs per mode (medians over correct runs)\n`)
console.log(`| metric | ${modes.join(" | ")} |\n|---|${modes.map(() => "---:").join("|")}|`)
for (const [label, cell] of rows) console.log(`| ${label} | ${summary.map(cell).join(" | ")} |`)
const direct = summary.find(s => s.mode === "direct")
console.log()
const delta = (a: number, b: number) => `${a < b ? "" : "+"}${(((a - b) / b) * 100).toFixed(1)}%`
for (const relay of summary.filter(s => s.mode !== "direct")) {
  if (!direct?.correct || !relay.correct) continue
  console.log(`${relay.mode} vs direct: tokens ${delta(relay.medianTotalTokens, direct.medianTotalTokens)}, ` +
    `cost ${delta(relay.medianCostUsd, direct.medianCostUsd)}`)
}
console.log(`\nResults: ${outDirectory}`)
