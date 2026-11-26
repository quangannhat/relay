import { expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

it("interoperates with the official MCP TypeScript client over stdio", async () => {
  const directory = join(process.cwd(), `.relay-mcp-daemon-${crypto.randomUUID()}`)
  const databasePath = join(directory, "relay.db")
  const socketPath = join(directory, "relay.sock")
  const daemon = spawn(process.execPath, ["packages/relay-daemon/src/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_DB: databasePath, RELAY_SOCKET: socketPath },
    stdio: ["ignore", "ignore", "ignore"]
  })
  const daemonStopped = new Promise<void>(resolve => daemon.once("exit", () => resolve()))
  const waitForSocket = async () => {
    for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (!existsSync(socketPath)) throw new Error("Relay daemon socket did not appear")
  }

  const client = new Client({ name: "relay-mcp-integration-test", version: "0.1.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["packages/relay-mcp/src/main.ts"],
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      RELAY_DB: databasePath,
      RELAY_SOCKET: socketPath
    },
    stderr: "inherit"
  })

  try {
    await waitForSocket()
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toContain("wait_for_event")
    expect(tools.map(tool => tool.name)).toContain("get_metrics")

    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args })
    const registered = await call("register_repository", {
      name: "mcp-integration", paths: ["/tmp/mcp-integration"]
    })
    const repositoryId = registered.structuredContent!.id as string
    expect(repositoryId).toMatch(/^R-/)
    const repositories = await call("list_repositories")
    expect((repositories.structuredContent!.repositories as Array<{ id: string }>)[0].id)
      .toBe(repositoryId)

    const first = await call("create_task", {
      repositoryId, title: "Database interface", actor: "agent-a"
    })
    const taskId = first.structuredContent!.id as string
    const second = await call("create_task", {
      repositoryId, title: "API integration", dependencies: [taskId], actor: "agent-b"
    })
    const dependentId = second.structuredContent!.id as string
    expect(second.structuredContent!.status).toBe("blocked")

    await call("claim_task", { taskId, actor: "agent-a" })

    // Keep the MCP request blocked while irrelevant progress is published.
    const waiting = call("wait_for_event", {
      taskId, types: ["TaskCompleted"], timeoutMs: 5000
    })
    await call("report_progress", {
      taskId, message: "Repository interface is ready", actor: "agent-a"
    })
    await call("complete_task", { taskId, actor: "agent-a" })

    const completion = await waiting
    expect(completion.isError).toBe(false)
    expect(completion.structuredContent!.event.type).toBe("TaskCompleted")

    const dependent = await call("get_task", { taskId: dependentId })
    expect(dependent.structuredContent!.status).toBe("pending")
    const history = await call("get_events", { afterId: 0 })
    expect((history.structuredContent!.events as Array<{ type: string }>).map(event => event.type))
      .toContain("ProgressReported")

    const handoff = await call("create_task", { repositoryId, title: "Catalog", actor: "agent-a" })
    const handoffId = handoff.structuredContent!.id as string
    const submitted = await call("submit_result", { taskId: handoffId, result: "catalog body", actor: "agent-a" })
    expect(submitted.structuredContent).toEqual({ taskId: handoffId, status: "completed" })
    const handedOff = await call("get_task", { taskId: handoffId })
    expect(handedOff.structuredContent!.artifacts).toEqual(["catalog body"])
    expect(handedOff.structuredContent!.assignee).toBe("agent-a")

    const failedClaim = await call("claim_task", { taskId: "T-missing", actor: "agent-x" })
    expect(failedClaim.isError).toBe(true)

    const metrics = await call("get_metrics")
    expect(metrics.isError).toBe(false)
    expect(metrics.structuredContent!.calls).toBeGreaterThan(0)
    expect(metrics.structuredContent!.estimatedTokensSaved).toBeGreaterThan(0)
    expect((metrics.structuredContent!.byTool as Array<{ tool: string }>).some(row => row.tool === "get_task"))
      .toBe(true)
  } finally {
    try { await client.close() } finally {
      daemon.kill("SIGTERM")
      await daemonStopped
      rmSync(databasePath, { force: true })
      rmSync(`${databasePath}-wal`, { force: true })
      rmSync(`${databasePath}-shm`, { force: true })
      rmSync(socketPath, { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  }
}, 15_000)
