import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { isRelayDaemonRunning, relayDatabasePath, relaySocketPath, removeStaleRelaySocket } from "./socket.js"
import { RelayRpcServerLive } from "./server.js"

const databasePath = relayDatabasePath()
const socketPath = relaySocketPath(databasePath)

if (await isRelayDaemonRunning(socketPath)) {
  console.info(`Relay daemon is already running at ${socketPath}`)
  process.exit(0)
}

mkdirSync(dirname(socketPath), { recursive: true })
mkdirSync(dirname(databasePath), { recursive: true })
removeStaleRelaySocket(socketPath)
process.umask(process.umask() | 0o077)

Effect.gen(function* () {
  yield* Effect.logInfo(`Relay daemon listening at ${socketPath}`)
  yield* Layer.launch(RelayRpcServerLive(socketPath, databasePath))
}).pipe(
  Effect.scoped,
  NodeRuntime.runMain
)
