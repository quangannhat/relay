import type { Mode, Scenario } from "./scenario.js"
import {
  CATALOG_TASK, CLI_READ, CLI_SUBMIT, generateServices, labelledJson, portConflicts, relayTools, startupOrder, writeServices,
  type PortConflict
} from "./services.js"

// Handoff: an investigator catalogs services from files, then a planner with no file access
// turns that catalog into a startup plan. The catalog must cross from one agent to the other,
// either through Relay or through the orchestrator's prompts.

export interface HandoffAnswer {
  readonly order: ReadonlyArray<string>
  readonly conflicts: ReadonlyArray<PortConflict>
}

const ANSWER_FORMAT = 'ANSWER: {"order":["svc",...],"conflicts":[{"port":1234,"services":["a","b"]}]}'
const PLAN_TASK = "From the service catalog, compute (1) the startup order: a service starts only after everything it depends on, " +
  "and whenever several services are ready at once, start them in alphabetical order; and (2) port conflicts: every port " +
  "shared by two or more services, with those services in alphabetical order, sorted by port."

export const handoff: Scenario<HandoffAnswer> = {
  name: "handoff",
  modes: ["relay", "relay-lean", "relay-cli", "direct"],
  setup: (directory, seed) => {
    const services = generateServices(seed)
    writeServices(directory, services)
    return { order: startupOrder(services), conflicts: portConflicts(services) }
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
    },
    "relay-cli": {
      investigator: {
        description: "Reads the service files and creates a Relay task containing the catalog.",
        prompt: `${CATALOG_TASK} ${CLI_SUBMIT} Your final reply must be "done <taskId>".`,
        tools: ["Read", "Grep", "Glob", "Bash"]
      },
      planner: {
        description: "Reads a catalog from a Relay task and returns a startup order and port conflicts. Has no file access.",
        prompt: `${PLAN_TASK} ${CLI_READ} Your final reply must be one line: ${ANSWER_FORMAT}`,
        tools: ["Bash"]
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
      `line, exactly in the form ${ANSWER_FORMAT}`,
    "relay-cli": "Coordinate two agents to plan service startup for this workspace. Do not read files or do the analysis yourself. " +
      "Run the investigator agent. It creates the catalog task with the relay command; extract the task id from its final " +
      "reply, then run the planner agent with that task id. Finally output the planner's result as your last line, " +
      `exactly in the form ${ANSWER_FORMAT}`
  })[mode],
  grade: (result, answer) => {
    try {
      const actual = labelledJson(result, "ANSWER") as HandoffAnswer
      const correct = JSON.stringify(actual.order) === JSON.stringify(answer.order) &&
        JSON.stringify(actual.conflicts) === JSON.stringify(answer.conflicts)
      return correct ? { correct } : { correct, reason: `expected ${JSON.stringify(answer)}, got ${JSON.stringify(actual)}` }
    } catch (error) {
      return { correct: false, reason: `unusable ANSWER: ${String(error)}` }
    }
  }
}
