import { Data } from "effect"

export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly message: string
}> {}
