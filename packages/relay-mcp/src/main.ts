import { McpServer } from "@effect/ai"
import { NodeRuntime, NodeSink, NodeStream } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import { RelayMcpLayer } from "./server.js"

const ServerLayer = RelayMcpLayer.pipe(
  Layer.provide(McpServer.layerStdio({
    name: "Relay",
    version: "0.1.0",
    stdin: NodeStream.stdin,
    stdout: NodeSink.stdout
  })),
  Layer.provide(Logger.add(Logger.prettyLogger({ stderr: true })))
)

Effect.scoped(Layer.launch(ServerLayer)).pipe(
  Effect.provide(Layer.empty),
  NodeRuntime.runMain
)
