import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Mode, Scenario } from "./scenario.js"

// Handoff: an investigator catalogs services from files, then a planner with no file access
// turns that catalog into a startup plan. The catalog must cross from one agent to the other,
// either through Relay or through the orchestrator's prompts.

const SERVICE_NAMES = [
  "auth", "billing", "catalog", "checkout", "email", "gateway", "inventory",
  "ledger", "notify", "orders", "payments", "search", "shipping", "users"
]
const RETIRED_COUNT = 2
const OVERRIDE_COUNT = 4

interface Service {
  readonly name: string
  readonly port: number
  readonly override: number | undefined
  readonly dependsOn: ReadonlyArray<string>
  readonly retired: boolean
}

export interface HandoffAnswer {
  readonly order: ReadonlyArray<string>
  readonly conflicts: ReadonlyArray<{ readonly port: number; readonly services: ReadonlyArray<string> }>
}

// mulberry32: small deterministic PRNG so every run of a seed sees the same fixture.
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const shuffle = <A>(items: ReadonlyArray<A>, next: () => number) => {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

const generate = (seed: number): ReadonlyArray<Service> => {
  const next = random(seed)
  const ordered = shuffle(SERVICE_NAMES, next)
  const retired = new Set(ordered.slice(-RETIRED_COUNT))
  const active = ordered.filter(name => !retired.has(name))
  const ports = new Map(ordered.map((name, index) => [name, 7100 + index * 10]))
  // Overrides move some active services onto another service's base port, which creates conflicts.
  const overrides = new Map<string, number>()
  for (const name of shuffle(active, next).slice(0, OVERRIDE_COUNT)) {
    const target = active[Math.floor(next() * active.length)]!
    overrides.set(name, target === name ? ports.get(name)! + 1 : ports.get(target)!)
  }
  return ordered.map((name, index) => {
    const earlier = active.slice(0, Math.max(0, active.indexOf(name)))
    const dependsOn = retired.has(name) || index === 0
      ? []
      : shuffle(earlier, next).slice(0, Math.floor(next() * Math.min(3, earlier.length + 1)))
    return {
      name, port: ports.get(name)!, override: overrides.get(name), dependsOn: [...dependsOn].sort(),
      retired: retired.has(name)
    }
  })
}

const expected = (services: ReadonlyArray<Service>): HandoffAnswer => {
  const active = services.filter(service => !service.retired)
  const remaining = new Map(active.map(service => [service.name, new Set(service.dependsOn)]))
  const order: Array<string> = []
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort()
    const name = ready[0]
    if (!name) throw new Error("fixture has a dependency cycle")
    order.push(name)
    remaining.delete(name)
    for (const deps of remaining.values()) deps.delete(name)
  }
  const byPort = new Map<number, Array<string>>()
  for (const service of active) {
    const port = service.override ?? service.port
    byPort.set(port, [...(byPort.get(port) ?? []), service.name])
  }
  const conflicts = [...byPort]
    .filter(([, names]) => names.length > 1)
    .map(([port, names]) => ({ port, services: names.sort() }))
    .sort((a, b) => a.port - b.port)
  return { order, conflicts }
}

const writeFixture = (directory: string, services: ReadonlyArray<Service>) => {
  const envName = (name: string) => `PORT_${name.toUpperCase()}`
  mkdirSync(join(directory, "config"), { recursive: true })
  writeFileSync(join(directory, "config", "ports.env"), [
    "# Base port assignments. Overrides in ports.override.env take precedence.",
    ...services.map(service => `${envName(service.name)}=${service.port}`)
  ].join("\n") + "\n")
  writeFileSync(join(directory, "config", "ports.override.env"), [
    "# Environment-specific port overrides.",
    ...services.filter(service => service.override).map(service => `${envName(service.name)}=${service.override}`)
  ].join("\n") + "\n")
  for (const service of services) {
    const serviceDirectory = join(directory, "services", service.name)
    mkdirSync(serviceDirectory, { recursive: true })
    writeFileSync(join(serviceDirectory, "manifest.yaml"), [
      `name: ${service.name}`,
      `status: ${service.retired ? "retired" : "active"}`,
      "depends_on:",
      ...(service.dependsOn.length ? service.dependsOn.map(dep => `  - ${dep}`) : ["  []"]),
      "# Historical dependencies, kept for reference only:",
      `# legacy_depends_on: [${SERVICE_NAMES.filter(name => name !== service.name).slice(0, 2).join(", ")}]`
    ].join("\n") + "\n")
    writeFileSync(join(serviceDirectory, "README.md"),
      `# ${service.name}\n\nOwns the ${service.name} domain. Port comes from ${envName(service.name)}.\n`)
  }
}

const ANSWER_FORMAT = 'ANSWER: {"order":["svc",...],"conflicts":[{"port":1234,"services":["a","b"]}]}'
const CATALOG_TASK = "List every service whose manifest status is active (skip retired services). For each one give its name, " +
  "its effective port (a value in config/ports.override.env replaces the one in config/ports.env), and its depends_on " +
  "list. Ignore commented-out legacy dependencies."
const PLAN_TASK = "From the service catalog, compute (1) the startup order: a service starts only after everything it depends on, " +
  "and whenever several services are ready at once, start them in alphabetical order; and (2) port conflicts: every port " +
  "shared by two or more services, with those services in alphabetical order, sorted by port."

const relayTools = (...names: ReadonlyArray<string>) => names.map(name => `mcp__relay__${name}`)

export const handoff: Scenario<HandoffAnswer> = {
  name: "handoff",
  setup: (directory, seed) => {
    const services = generate(seed)
    writeFixture(directory, services)
    return expected(services)
  },
  agents: (mode: Mode) => ({
    direct: {
      investigator: {
        description: "Reads the service files and returns a catalog of active services.",
        prompt: `${CATALOG_TASK} Your final reply must be the complete catalog and nothing else.`,
        tools: ["Read", "Grep", "Glob"]
      },
      planner: {
        description: "Turns a service catalog into a startup order and a list of port conflicts. Has no file access.",
        prompt: `${PLAN_TASK} The catalog is in your instructions. Your final reply must be one line: ${ANSWER_FORMAT}`,
        tools: []
      }
    },
    relay: {
      investigator: {
        description: "Reads the service files and publishes a catalog of active services to a Relay task.",
        prompt: `${CATALOG_TASK} You will be given a Relay task id. Claim it, publish the complete catalog as a single ` +
          "artifact on it, then complete it. Your final reply must be just the word done.",
        tools: ["Read", "Grep", "Glob", ...relayTools("claim_task", "publish_artifact", "complete_task")]
      },
      planner: {
        description: "Reads a catalog from Relay and publishes a startup order and port conflicts. Has no file access.",
        prompt: `${PLAN_TASK} You will be given two Relay task ids: read the catalog artifact from the catalog task, then ` +
          `claim the plan task, publish one artifact containing exactly one line ${ANSWER_FORMAT}, and complete it. ` +
          "Your final reply must be just the word done.",
        tools: relayTools("get_task", "claim_task", "publish_artifact", "complete_task")
      }
    },
    "relay-lean": {
      investigator: {
        description: "Reads the service files and submits a catalog of active services to a Relay task.",
        prompt: `${CATALOG_TASK} You will be given a Relay task id. Submit the complete catalog with one submit_result ` +
          "call on that task. Your final reply must be just the word done.",
        tools: ["Read", "Grep", "Glob", ...relayTools("submit_result")]
      },
      planner: {
        description: "Reads a catalog from a Relay task and returns a startup order and port conflicts. Has no file access.",
        prompt: `${PLAN_TASK} You will be given a Relay task id: read the catalog from that task's artifact. Your final ` +
          `reply must be one line: ${ANSWER_FORMAT}`,
        tools: relayTools("get_task")
      }
    }
  })[mode],
  prompt: (mode: Mode, repositoryId: string) => ({
    direct: "Coordinate two agents to plan service startup for this workspace. Do not read files or do the analysis yourself. " +
      "First run the investigator agent. Then run the planner agent and include the investigator's complete catalog in " +
      `its prompt. Finally output the planner's result as your last line, exactly in the form ${ANSWER_FORMAT}`,
    relay: "Coordinate two agents through Relay to plan service startup for this workspace. Do not read files or do the " +
      `analysis yourself. Create two Relay tasks in repository ${repositoryId}: a catalog task and a plan task. Run the ` +
      "investigator agent with the catalog task id. Then run the planner agent with both task ids. Finally read the " +
      `plan task's artifact and output its ANSWER line as your last line, exactly in the form ${ANSWER_FORMAT}`,
    "relay-lean": "Coordinate two agents to plan service startup for this workspace. Do not read files or do the analysis yourself. " +
      `Create one Relay task for the service catalog in repository ${repositoryId}. Run the investigator agent with its ` +
      "task id, then run the planner agent with the same task id. Finally output the planner's result as your last " +
      `line, exactly in the form ${ANSWER_FORMAT}`
  })[mode],
  grade: (result, answer) => {
    const line = result.split("\n").reverse().find(text => text.includes("ANSWER:"))
    if (!line) return { correct: false, reason: "no ANSWER line" }
    try {
      const actual = JSON.parse(line.slice(line.indexOf("ANSWER:") + "ANSWER:".length).trim().replace(/`+$/, ""))
      const correct = JSON.stringify(actual.order) === JSON.stringify(answer.order) &&
        JSON.stringify(actual.conflicts) === JSON.stringify(answer.conflicts)
      return correct ? { correct } : { correct, reason: `expected ${JSON.stringify(answer)}, got ${JSON.stringify(actual)}` }
    } catch (error) {
      return { correct: false, reason: `unparseable ANSWER: ${String(error)}` }
    }
  }
}
