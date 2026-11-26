import { RpcSerialization, RpcServer } from "@effect/rpc"
import { NodeSocketServer } from "@effect/platform-node"
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { Coordination, CoordinationLive } from "relay-core/engine"
import { StoreLive } from "relay-core"
import { Conflict, InvalidTransition, NotFound } from "relay-core/errors"
import type { TaskId } from "relay-core/domain"
import { RelayRpc, type RelayRpcError } from "./rpc.js"

const encodeError = (error: NotFound | Conflict | InvalidTransition): Schema.Schema.Type<typeof RelayRpcError> => {
  switch (error._tag) {
    case "NotFound": return { _tag: "NotFound", entity: error.entity, id: error.id }
    case "Conflict": return { _tag: "Conflict", message: error.message }
    case "InvalidTransition": return { _tag: "InvalidTransition", from: error.from, to: error.to }
    default: return { _tag: "Conflict", message: String(error) }
  }
}

const handlers = RelayRpc.toLayer(Effect.gen(function* () {
  const relay = yield* Coordination
  const mapError = <A>(effect: Effect.Effect<A, NotFound | Conflict | InvalidTransition>) =>
    Effect.mapError(effect, encodeError)

  return {
    RegisterRepository: ({ name, paths }) => relay.registerRepository(name, paths),
    ListRepositories: () => relay.listRepositories(),
    CreateTask: input => mapError(relay.createTask(input, input.actor)),
    ListTasks: () => relay.listTasks(),
    GetTask: ({ taskId }) => mapError(relay.getTask(taskId)),
    ClaimTask: ({ taskId, actor }) => mapError(relay.claimTask(taskId, actor)),
    UpdateTask: ({ taskId, status, title, description, actor }) =>
      mapError(relay.updateTask(taskId, { status, title, description }, actor)),
    ReportProgress: ({ taskId, message, actor }) => mapError(relay.reportProgress(taskId, message, actor)),
    PublishArtifact: ({ taskId, artifact, actor }) => mapError(relay.publishArtifact(taskId, artifact, actor)),
    CompleteTask: ({ taskId, actor }) => mapError(relay.completeTask(taskId, actor)),
    GetEvents: ({ afterId }) => relay.getEvents(afterId),
    SubscribeEvents: ({ afterId }) => Stream.unwrapScoped(Effect.gen(function* () {
      const queue = yield* relay.subscribe()
      const history = yield* relay.getEvents(afterId)
      let cursor = afterId ?? 0
      return Stream.concat(Stream.fromIterable(history), Stream.fromQueue(queue)).pipe(
        Stream.filter(event => event.id > cursor),
        Stream.tap(event => Effect.sync(() => { cursor = event.id }))
      )
    })),
    RecordMcpToolCall: ({ tool, requestCharacters, responseCharacters }) =>
      relay.recordMcpToolCall(tool, requestCharacters, responseCharacters),
    GetMcpMetrics: () => relay.getMcpMetrics(),
    WaitForEvent: ({ taskId, types, timeoutMs }) => Effect.scoped(Effect.gen(function* () {
      const queue = yield* relay.subscribe(taskId as TaskId, types)
      return Option.getOrNull(yield* Effect.timeoutOption(Queue.take(queue), timeoutMs))
    }))
  }
}))

export const RelayRpcServerLive = (socketPath: string, database = "relay.db") =>
  RpcServer.layer(RelayRpc).pipe(
    Layer.provide(handlers),
    Layer.provide(CoordinationLive),
    Layer.provide(StoreLive(database)),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path: socketPath }))
  )
