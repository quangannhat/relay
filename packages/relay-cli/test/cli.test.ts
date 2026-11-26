import { afterAll, beforeAll, expect, it } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const directory = join(process.cwd(), `.relay-cli-test-${crypto.randomUUID()}`)
const socketPath = join(directory, "relay.sock")
const env = { ...process.env, RELAY_DB: join(directory, "relay.db"), RELAY_SOCKET: socketPath, RELAY_ACTOR: "tester" } as Record<string, string>
let daemon: ChildProcess

const cli = async (args: string[], extraEnv: Record<string, string> = {}, stdin?: string) => {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, "packages/relay-cli/src/main.ts", ...args], {
    cwd: process.cwd(), env: { ...env, ...extraEnv }, stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe", stderr: "pipe"
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
  ])
  return { stdout, stderr, code, ms: Date.now() - started }
}

beforeAll(async () => {
  mkdirSync(directory, { recursive: true })
  daemon = spawn(process.execPath, ["packages/relay-daemon/src/main.ts"], { cwd: process.cwd(), env, stdio: "ignore" })
  for (let i = 0; i < 200 && !existsSync(socketPath); i++) await new Promise(r => setTimeout(r, 25))
  if (!existsSync(socketPath)) throw new Error("daemon socket did not appear")
  const registry = Bun.spawn([process.execPath, "-e", `
    import { Effect } from "effect"
    import { RelayRpcClient, RelayRpcClientLive } from "relay-daemon/client"
    await Effect.runPromise(Effect.gen(function* () {
      const relay = yield* RelayRpcClient
      yield* relay.RegisterRepository({ name: "cli-test", paths: [${JSON.stringify(process.cwd())}] })
    }).pipe(Effect.provide(RelayRpcClientLive(process.env.RELAY_SOCKET!)), Effect.scoped))
    process.exit(0)`], { cwd: join(process.cwd(), "packages/relay-cli"), env, stdout: "ignore", stderr: "inherit" })
  await registry.exited
})

afterAll(async () => {
  daemon.kill()
  await new Promise(r => daemon.once("exit", r))
  rmSync(directory, { recursive: true, force: true })
})

it("round-trips new, claim, done -f and show --result", async () => {
  const created = await cli(["new", "Write thing", "-d", "the brief"])
  expect(created.code).toBe(0)
  const id = created.stdout.trim()
  expect(id).toMatch(/^T-/)

  const claimed = await cli(["claim", id, "--as", "worker"])
  expect(claimed.stdout).toBe("Write thing\n\nthe brief\n")

  const file = join(directory, "result.md")
  writeFileSync(file, "# result\nall good")
  const done = await cli(["done", id, "-f", file], { RELAY_ACTOR: "worker" })
  expect(done.stdout.trim()).toBe(`${id} completed`)

  expect((await cli(["show", id, "--result"])).stdout).toBe("# result\nall good")
  expect((await cli(["show", id])).stdout).toContain("status: completed")
  expect((await cli(["ls", "--status", "completed"])).stdout).toContain(`${id} completed worker Write thing`)

  const viaStdin = (await cli(["new", "Stdin task", "-"], {}, "from stdin")).stdout.trim()
  const done2 = await cli(["done", viaStdin, "inline result"])
  expect(done2.stdout.trim()).toBe(`${viaStdin} completed`)
  expect((await cli(["show", viaStdin, "--result"])).stdout).toBe("inline result")
  expect((await cli(["show", viaStdin])).stdout).toContain("from stdin")
})

it("exits 1 on claim conflict and on missing result", async () => {
  const id = (await cli(["new", "Contested"])).stdout.trim()
  expect((await cli(["claim", id, "--as", "a"])).code).toBe(0)
  const second = await cli(["claim", id, "--as", "b"])
  expect(second.code).toBe(1)
  expect(second.stderr.trim().split("\n")).toHaveLength(1)
  expect((await cli(["show", id, "--result"])).code).toBe(1)
  const cancelled = await cli(["cancel", id])
  expect(cancelled.code).toBe(0)
  expect((await cli(["wait", id])).code).toBe(1)
})

it("wait returns immediately for completed tasks and times out with 124", async () => {
  const id = (await cli(["new", "Waitable"])).stdout.trim()
  const pending = await cli(["wait", id, "--timeout", "300ms"])
  expect(pending.code).toBe(124)
  await cli(["done", id, "finished"])
  const waited = await cli(["wait", id])
  expect(waited.code).toBe(0)
  expect(waited.stdout).toBe("finished\n")
})

it("exits 3 quickly when the daemon is not running", async () => {
  const result = await cli(["ls"], { RELAY_SOCKET: join(directory, "missing.sock") })
  expect(result.code).toBe(3)
  expect(result.stderr).toContain("daemon not running")
  expect(result.ms).toBeLessThan(2000)
})

it("done --new creates and completes a task in one call", async () => {
  const done = await cli(["done", "--new", "Catalog", "-"], {}, "catalog body")
  expect(done.code).toBe(0)
  const id = done.stdout.trim().split(" ")[0]!
  expect(done.stdout.trim()).toBe(`${id} completed`)
  expect((await cli(["show", id, "--result"])).stdout).toBe("catalog body")
  expect((await cli(["show", id])).stdout).toContain("assignee: tester")
})

it("finds the default daemon from any working directory", async () => {
  const home = join(directory, "default-home")
  const runtime = join(directory, "runtime")
  mkdirSync(join(home, "elsewhere"), { recursive: true })
  mkdirSync(runtime, { recursive: true })
  const { RELAY_DB: _db, RELAY_SOCKET: _socket, ...base } = env
  const defaults = { ...base, XDG_DATA_HOME: home, XDG_RUNTIME_DIR: runtime }
  const started = spawn(process.execPath, [join(process.cwd(), "packages/relay-daemon/src/main.ts")], {
    cwd: directory, env: defaults, stdio: "ignore"
  })
  try {
    for (let i = 0; i < 200 && !existsSync(join(home, "relay", "relay.db")); i++) await new Promise(r => setTimeout(r, 25))
    const ls = Bun.spawn([process.execPath, join(process.cwd(), "packages/relay-cli/src/main.ts"), "ls"], {
      cwd: join(home, "elsewhere"), env: defaults, stdout: "pipe", stderr: "pipe"
    })
    expect(await ls.exited).toBe(0)
  } finally {
    started.kill()
    await new Promise(r => started.once("exit", r))
  }
})
