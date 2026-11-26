import { expect, it } from "bun:test"

it("accepts a quit key in an interactive Bun pseudo-terminal", async () => {
  const cwd = process.cwd()
  const directory = `/tmp/relay-tui-${crypto.randomUUID()}`
  const socketPath = `${directory}/relay.sock`
  const databasePath = `${directory}/relay.db`
  await Bun.$`mkdir -p ${directory}`.quiet()

  const daemon = Bun.spawn(["bun", "run", "packages/relay-daemon/src/main.ts"], {
    cwd,
    env: { ...Bun.env, RELAY_SOCKET: socketPath, RELAY_DB: databasePath },
    stdout: "ignore",
    stderr: "ignore"
  })

  let output = ""
  let terminal: Bun.Terminal | undefined
  let sentKey = false
  const tui = Bun.spawn(["bun", "run", "packages/relay-tui/src/main.ts"], {
    cwd,
    env: { ...Bun.env, RELAY_SOCKET: socketPath, RELAY_DB: databasePath },
    terminal: {
      cols: 100,
      rows: 30,
      data: (pty, data) => {
        output += new TextDecoder().decode(data)
        terminal = pty
        if (!sentKey && output.includes("\u001b[?25l")) {
          sentKey = true
          pty.write("q")
        }
      }
    }
  })
  terminal = tui.terminal

  try {
    await Promise.race([
      tui.exited,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`TUI did not exit after q; output: ${JSON.stringify(output)}`)),
        5000
      ))
    ])
    expect(tui.exitCode).toBe(0)
    expect(output).toContain("TASK BOARD")
    expect(output).toContain("Shutting down")
  } finally {
    if (tui.exitCode === null) tui.kill("SIGTERM")
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM")
      await daemon.exited
    }
    terminal?.close()
    await Bun.$`rm -rf ${directory}`.quiet()
  }
}, 10_000)
