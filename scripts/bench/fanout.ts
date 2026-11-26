import type { AgentDefinition, Mode, Scenario } from "./scenario.js"
import {
  CATALOG_TASK, generateServices, labelledJson, leafServices, portConflicts, relayTools, startupOrder, writeServices,
  type PortConflict
} from "./services.js"

// Fan-out: one investigator catalogs services, then three workers with no file access each answer
// a different question from that same catalog. In direct mode the orchestrator must copy the catalog
// into every worker's prompt; in relay-lean mode it is published once and each worker fetches it.

export interface FanoutAnswer {
  readonly order: ReadonlyArray<string>
  readonly conflicts: ReadonlyArray<PortConflict>
  readonly leaves: ReadonlyArray<string>
}

const WORKERS = {
  planner: {
    label: "ORDER",
    task: "From the service catalog, compute the startup order: a service starts only after everything it depends on, " +
      "and whenever several services are ready at once, start them in alphabetical order.",
    format: 'ORDER: ["svc",...]'
  },
  auditor: {
    label: "CONFLICTS",
    task: "From the service catalog, find every port shared by two or more services. List each port once with its " +
      "services in alphabetical order, sorted by port.",
    format: 'CONFLICTS: [{"port":1234,"services":["a","b"]}]'
  },
  reviewer: {
    label: "LEAVES",
    task: "From the service catalog, list the leaf services: services that no other service depends on, in " +
      "alphabetical order.",
    format: 'LEAVES: ["svc",...]'
  }
} as const

const ANSWER_FORMAT = 'ANSWER: {"order":[...],"conflicts":[...],"leaves":[...]}'

const workers = (mode: Mode): Record<string, AgentDefinition> => Object.fromEntries(
  Object.entries(WORKERS).map(([name, worker]) => [name, {
    description: `Answers one question from a service catalog (${worker.label.toLowerCase()}). Has no file access.`,
    prompt: `${worker.task} ${mode === "direct"
      ? "The catalog is in your instructions."
      : "You will be given a Relay task id: read the catalog from that task's artifact."} ` +
      `Your final reply must be one line: ${worker.format}`,
    tools: mode === "direct" ? [] : relayTools("get_task")
  }]))

const combine = `combine the three workers' results into a single line, exactly in the form ${ANSWER_FORMAT}, and output ` +
  "it as your last line"

export const fanout = (serviceCount: number): Scenario<FanoutAnswer> => ({
  name: serviceCount === 14 ? "fanout" : `fanout-${serviceCount}`,
  modes: ["relay-lean", "direct"],
  setup: (directory, seed) => {
    const services = generateServices(seed, serviceCount)
    writeServices(directory, services)
    return { order: startupOrder(services), conflicts: portConflicts(services), leaves: leafServices(services) }
  },
  agents: mode => ({
    investigator: mode === "direct"
      ? {
        description: "Reads the service files and returns a catalog of active services.",
        prompt: `${CATALOG_TASK} Your final reply must be the complete catalog and nothing else.`,
        tools: ["Read", "Grep", "Glob"]
      }
      : {
        description: "Reads the service files and submits a catalog of active services to a Relay task.",
        prompt: `${CATALOG_TASK} You will be given a Relay task id. Submit the complete catalog with one submit_result ` +
          "call on that task. Your final reply must be just the word done.",
        tools: ["Read", "Grep", "Glob", ...relayTools("submit_result")]
      },
    ...workers(mode)
  }),
  prompt: (mode, repositoryId) => mode === "direct"
    ? "Coordinate agents to analyse the services in this workspace. Do not read files or do the analysis yourself. " +
      "First run the investigator agent. Then run the planner, auditor and reviewer agents, all at once, and include " +
      `the investigator's complete catalog in each of their prompts. Finally ${combine}.`
    : "Coordinate agents to analyse the services in this workspace. Do not read files or do the analysis yourself. " +
      `Create one Relay task for the service catalog in repository ${repositoryId}. Run the investigator agent with its ` +
      "task id. Then run the planner, auditor and reviewer agents, all at once, each with the same task id. Finally " +
      `${combine}.`,
  grade: (result, answer) => {
    try {
      const actual = labelledJson(result, "ANSWER") as FanoutAnswer
      const wrong = (["order", "conflicts", "leaves"] as const)
        .filter(key => JSON.stringify(actual[key]) !== JSON.stringify(answer[key]))
      return wrong.length === 0
        ? { correct: true }
        : { correct: false, reason: wrong.map(key => `${key}: expected ${JSON.stringify(answer[key])}, got ${JSON.stringify(actual[key])}`).join("; ") }
    } catch (error) {
      return { correct: false, reason: `unusable ANSWER: ${String(error)}` }
    }
  }
})
