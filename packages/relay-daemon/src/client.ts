import { RpcClient, RpcSerialization } from "@effect/rpc"
import { NodeSocket } from "@effect/platform-node"
import { Context, Layer } from "effect"
import type { FromGroup } from "@effect/rpc/RpcClient"
import type { RpcClientError } from "@effect/rpc/RpcClientError"
import { RelayRpc } from "./rpc.js"

export type RelayRpcClientService = FromGroup<typeof RelayRpc, RpcClientError>

export class RelayRpcClient extends Context.Tag("relay/RpcClient")<
  RelayRpcClient,
  RelayRpcClientService
>() {}

export const RelayRpcClientLive = (socketPath: string) =>
  Layer.scoped(RelayRpcClient, RpcClient.make(RelayRpc)).pipe(
    Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocket.layerNet({ path: socketPath }))
  )
