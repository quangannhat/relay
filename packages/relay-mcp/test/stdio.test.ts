import { expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

it("interoperates with the official MCP TypeScript client over stdio", async () => {
  const client = new Client({ name: "relay-mcp-integration-test", version: "0.1.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["packages/relay-mcp/src/main.ts"],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), RELAY_DB: ":memory:" },
    stderr: "inherit"
  })

  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toContain("wait_for_event")

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

    const failedClaim = await call("claim_task", { taskId: "T-missing", actor: "agent-x" })
    expect(failedClaim.isError).toBe(true)
  } finally {
    await client.close()
  }
}, 15_000)
