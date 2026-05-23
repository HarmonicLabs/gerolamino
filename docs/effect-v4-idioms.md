# Effect v4 idioms (Gerolamino)

Authoritative upstream index: [Effect llms.txt](https://effect-ts-effect-smol-1.mintlify.app/llms.txt).

This repo targets **Effect `4.0.0-beta.*`** with **`Context.Service`** (the installed beta API; Mintlify may say `ServiceMap.Service` — same pattern, different export name in this beta).

## Core rules (all `packages/*` + `apps/*`)

| Topic | Do | Don't |
|-------|-----|--------|
| Errors | `Schema.TaggedErrorClass` | `Data.TaggedError`, untyped `throw` |
| Recovery | `Effect.catch`, `Effect.catchCause` | `Effect.catchAll`, `Effect.catchAllCause` |
| Outcomes | `Effect.exit` + `Exit.isFailure` | `Effect.either` |
| Fibers | `Effect.forkChild`, `Effect.forkScoped` | `Effect.fork` |
| Config | `Config.string()` / `.number()` / `.duration()` + `withDefault` / `option` / `orElse` | `process.env` in library/runtime code |
| Logging | `Effect.log*` | `console.*` in `src/**` (benches/e2e scripts exempt) |
| Casts | `as const` only | `as SomeType`, `any` |
| Composition | `Effect.gen` + `yield*`, `x.pipe(a, b)` | nested `flatMap` chains, `x.pipe(a).pipe(b)` |
| Tests | `@effect/vitest` `it.effect` / `it.layer` | `Effect.runPromise` inside test bodies |
| Streams | `Stream.runCollect` → `Effect<Array<A>>` | `Chunk.toArray` after collect |
| FS / paths | `FileSystem` + `Path` (+ `Path.fromFileUrl` / `toFileUrl` with `URL`) | `node:fs`, `node:path`, `node:url` in package logic |
| HTTP / RPC | `effect/unstable/http*`, `effect/unstable/rpc/*` | legacy `@effect/platform` import paths |
| Unstable | `effect/unstable/*` for beta modules | assuming top-level stable exports exist |

## Services (`Context.Service`)

```typescript
export class Database extends Context.Service<
  Database,
  { readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>, DbError> }
>()("myapp/Database") {}

export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const query = Effect.fn("Database.query")(function* (sql: string) {
      yield* Effect.log(sql);
      return [];
    });
    return Database.of({ query });
  }),
);
```

Prefer **`Effect.fn("Service.method")`** on service methods for stack traces.

## Layers & entrypoints

- Compose with `Layer.mergeAll` / `Layer.provide`.
- Run at the edge only: `Effect.runPromise`, `BunRuntime.runMain`, Playwright `runE`.
- Use `Effect.scoped` when acquiring `Socket`, workers, or OPFS handles.

## Config

```typescript
const port = Config.number("PORT").pipe(Config.withDefault(3040));
const host = Config.string("HOST").pipe(
  Config.orElse(() => Config.succeed("localhost")),
);
```

Configs are **yieldable** inside `Effect.gen`.

## Error handling

```typescript
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  message: Schema.String,
}) {}

yield* effect.pipe(
  Effect.catch((e: ParseError) => Effect.succeed(fallback)),
);
```

## Testing (`@effect/vitest`)

```typescript
import { assert, describe, it } from "@effect/vitest";
import { Effect, TestClock } from "effect";

describe("feature", () => {
  it.effect("works", () =>
    Effect.gen(function* () {
      assert.strictEqual(1, 1);
    }),
  );
});
```

Use `TestClock.adjust` for time-dependent code.

## Cause (v4 shape)

`Cause` is a flat list of `reasons` — iterate `cause.reasons`, don't match nested `Sequential` / `Parallel` trees.

## Package notes

| Package | Platform layer |
|---------|----------------|
| `apps/tui`, `bootstrap` tests | `BunFileSystem.layer`, `Path.layer`, `BunRuntime` |
| `chrome-ext` offscreen | Browser APIs + injected layers; E2E may use `BunFileSystem` on host |
| `wasm-utils` native tests | `BunFileSystem.layer` when touching disk |
| `consensus`, `storage`, `miniprotocols` | `Context.Service` + `Layer.effect` |

## References

- [v3 → v4 migration](https://mintlify.wiki/effect-TS/effect-smol/migration/v3-to-v4.md)
- [Services](https://mintlify.wiki/effect-TS/effect-smol/concepts/services.md)
- [Config](https://mintlify.wiki/effect-TS/effect-smol/api/config.md)
- [Testing](https://mintlify.wiki/effect-TS/effect-smol/guides/testing.md)
- [FileSystem](https://mintlify.wiki/effect-TS/effect-smol/api/filesystem.md)
