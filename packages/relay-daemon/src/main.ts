import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { relaySocketPath } from "./socket.js"
import { RelayRpcServerLive } from "./server.js"

const databasePath = process.env.RELAY_DB ?? "relay.db"
const socketPath = relaySocketPath(databasePath)

mkdirSync(dirname(socketPath), { recursive: true })
process.umask(process.umask() | 0o077)

Effect.gen(function* () {
  yield* Effect.logInfo(`Relay daemon listening at ${socketPath}`)
  yield* Layer.launch(RelayRpcServerLive(socketPath, databasePath))
}).pipe(
  Effect.scoped,
  NodeRuntime.runMain
)
