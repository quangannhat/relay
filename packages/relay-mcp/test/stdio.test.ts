import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

type RpcMessage = {
  readonly id?: number
  readonly result?: {
    readonly tools?: ReadonlyArray<{ name: string }>
    readonly content?: ReadonlyArray<{ text?: string }>
    readonly structuredContent?: any
    readonly isError?: boolean
  }
}

it("serves the coordination workflow over MCP stdio", async () => {
  const child = spawn(process.execPath, ["packages/relay-mcp/src/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_DB: ":memory:" },
    stdio: ["pipe", "pipe", "pipe"]
  })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<number, (message: RpcMessage) => void>()

  lines.on("line", line => {
    const message = JSON.parse(line) as RpcMessage
    if (message.id === undefined) return
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  const response = (id: number): Promise<RpcMessage> =>
    new Promise(resolve => pending.set(id, resolve))
  const call = async (id: number, name: string, args: Record<string, unknown>) => {
    const result = response(id)
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args }
    })}\n`)
    return (await result).result!
  }

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "relay-mcp-test", version: "0.1.0" }
      }
    })}\n`)
    const initialized = await response(1)
    expect(initialized.result).toBeDefined()
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')

    const registered = await call(2, "register_repository", {
      name: "mcp-integration", paths: ["/tmp/mcp-integration"]
    })
    const repositoryId = registered.structuredContent.id as string
    expect(repositoryId).toMatch(/^R-/)

    const first = await call(3, "create_task", {
      repositoryId, title: "Database interface", actor: "agent-a"
    })
    const taskId = first.structuredContent.id as string
    const second = await call(4, "create_task", {
      repositoryId, title: "API integration", dependencies: [taskId], actor: "agent-b"
    })
    const dependentId = second.structuredContent.id as string
    expect(second.structuredContent.status).toBe("blocked")

    await call(5, "claim_task", { taskId, actor: "agent-a" })

    // Hold a filtered wait open while progress and completion arrive.
    const waiting = call(6, "wait_for_event", {
      taskId, types: ["TaskCompleted"], timeoutMs: 5000
    })
    await call(7, "report_progress", {
      taskId, message: "Repository interface is ready", actor: "agent-a"
    })
    await call(8, "complete_task", { taskId, actor: "agent-a" })

    const completion = await waiting
    expect(completion.isError).toBe(false)
    expect(completion.structuredContent.type).toBe("TaskCompleted")

    const dependent = await call(9, "get_task", { taskId: dependentId })
    expect(dependent.structuredContent.status).toBe("pending")

    const history = await call(10, "get_events", { afterId: 0 })
    expect(history.structuredContent.map((event: { type: string }) => event.type))
      .toContain("ProgressReported")

    const failedClaim = await call(11, "claim_task", { taskId: "T-missing", actor: "agent-x" })
    expect(failedClaim.isError).toBe(true)
  } finally {
    lines.close()
    child.kill()
  }
}, 15_000)
