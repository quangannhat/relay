// relay: every payload goes through Relay tasks. relay-lean: only the bulky intermediate payload goes
// through Relay, with submit_result, and small final answers come back in agent replies.
export type Mode = "relay" | "relay-lean" | "direct"

export interface AgentDefinition {
  readonly description: string
  readonly prompt: string
  readonly tools: ReadonlyArray<string>
}

// A benchmark scenario runs the same coordination job in both modes. Its agents' tool lists enforce
// the communication path, so in direct mode nothing can reach another agent except through prompts
// and replies, and in relay mode the payloads are expected to travel through Relay.
export interface Scenario<Answer> {
  readonly name: string
  readonly modes: ReadonlyArray<Mode>
  readonly setup: (directory: string, seed: number) => Answer
  readonly agents: (mode: Mode) => Record<string, AgentDefinition>
  readonly prompt: (mode: Mode, repositoryId: string) => string
  readonly grade: (result: string, answer: Answer) => { readonly correct: boolean; readonly reason?: string }
}
