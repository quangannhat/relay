import { createHash } from "node:crypto"
import { lstatSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

// The default database is per user, not per working directory, so every client finds the same daemon wherever it starts.
export const relayDatabasePath = () =>
  process.env.RELAY_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "relay", "relay.db")

export const relaySocketPath = (databasePath = relayDatabasePath()) =>
  process.env.RELAY_SOCKET ??
  join(
    process.env.XDG_RUNTIME_DIR ?? tmpdir(),
    `relay-${process.getuid?.() ?? "user"}-${createHash("sha256")
      .update(resolve(databasePath))
      .digest("hex")
      .slice(0, 16)}.sock`
  )

export const isRelayDaemonRunning = async (socketPath: string): Promise<boolean> => {
  try {
    const socket = await Bun.connect({
      unix: socketPath,
      socket: { data() {} }
    })
    socket.end()
    return true
  } catch {
    return false
  }
}

// A daemon killed without cleanup leaves its socket file behind, which makes the next listen fail with EADDRINUSE.
// Only call this after isRelayDaemonRunning has returned false.
export const removeStaleRelaySocket = (socketPath: string) => {
  try {
    if (lstatSync(socketPath).isSocket()) rmSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
