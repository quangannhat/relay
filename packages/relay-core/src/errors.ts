import { Data } from "effect"

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly entity: string
  readonly id: string
}> {}
export class Conflict extends Data.TaggedError("Conflict")<{
  readonly message: string
}> {}
export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly from: string
  readonly to: string
}> {}
export type RelayError = NotFound | Conflict | InvalidTransition
