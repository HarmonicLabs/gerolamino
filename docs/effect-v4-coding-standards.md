# Effect v4 coding standards (canonical)

**Read before any Effect v4 polish wave.** This file distills
[`cursor-handoff.md`](cursor-handoff.md) §4 + §6, [`AGENTS.md`](../AGENTS.md),
[`memory-synthesis.md`](memory-synthesis.md), and load-bearing entries under
`~/.claude/projects/-home-hariamoor-code-HarmonicLabs-gerolamino/memory/`.

## Source-of-truth order

1. **Landed code** + `docs/cursor-handoff.md` (architecture beats historical brief)
2. **`~/code/reference/effect-smol/`** — grep APIs before changing imports
3. **Memory bank** — `reference_effect_v4_api_changes.md`, `feedback_*`, `project_*`
4. Package `CLAUDE.md` / `AGENTS.md`

## Type safety

| Rule | Detail |
|------|--------|
| No `as Type` | Only `as const`. Narrow with Schema / structural types. |
| Domain types | `Schema.TaggedClass` (methods on class body) |
| Errors | `Schema.TaggedErrorClass`; `operation` via `Schema.Literals([...])` |
| Unions | `Schema.Literals`, `Schema.Enum` + `Schema.Enum`, or tagged unions with `.match()` / `.isAnyOf()` |
| Recursive schema | `Schema.suspend((): Schema.Codec<T> => Ref)` — **not** `Schema.Schema<T>` on suspend thunk |

## Effect v4 API (removed → replacement)

| Removed | Use |
|---------|-----|
| `Context.Tag` | `Context.Service<S,T>()("id")` |
| `Effect.either` | `Effect.exit` + `Exit.isSuccess` / `Exit.isFailure` |
| `Effect.catchAll` | `Effect.catch` / `Effect.catchCause` / `Effect.catchTag` |
| `Effect.zipRight` | `Effect.andThen` |
| `Effect.tapErrorCause` | `Effect.tapCause` |
| `Predicate.isRecord` | `Predicate.isObject` |
| `Schedule.upTo` | `Schedule.recurs(n)` + retry `times` |
| `Schedule.intersect` | `Schedule.both` |
| `Metric.trackDuration` | `Effect.timed` + `Metric.update` |
| `Effect.timeoutFail` | `Effect.timeoutOrElse` |
| `Schema.parseJson` | `Schema.fromJsonString` |
| `Layer.provide([a,b])` | Pre-compose deps; `layer.pipe(Layer.provide(x), Layer.merge(y))` |

## Style

- **`Effect.gen` + `yield*`** at boundaries; hoist inner flows to named `Effect.fn` / module-level gens — no nested gens.
- **Single `.pipe(a, b, c)`** — no `x.pipe(a).pipe(b)` or deep `Effect.provide(Effect.scoped(...))` nesting.
- **`Effect.run*` only at entrypoints** (apps, popup/offscreen/SW `main`, worker boot). Tests: `@effect/vitest` `it.effect` + `layer()` — not `Effect.runPromise` in helpers (e2e `runE` bridge is the one exception).
- **`Config.string` / `number` / `duration`** — never `process.env` in `packages/*` or `apps/*/src` (test-only env gates OK in `__tests__`).
- **Runtime**: `Clock`, `Ref`, `Schedule`, `FileSystem`/`Path` from Effect — not `Date.now`, raw `setTimeout`, `node:fs`.
- **Logging**: `Effect.log*` in app code; `console.*` forbidden in `packages/*/src` and `apps/*/src` except benches/integration scripts explicitly allowed.
- **Dispatch**: `.match()` on tagged unions — not long `_tag ===` chains.
- **No `*Unsafe`** except documented exceptions (`Atom.batch`, `Latch.openUnsafe` in worker protocol where Effect source does).

## Module hygiene

- Imports at top of file — no dynamic `import()`.
- Barrel `index.ts` per directory; cross-package via tsconfig aliases (`ledger/...`, `codecs`).
- No lodash; **es-toolkit** + native ES2025 (`Iterator.from`, `Set` ops, `ArrayBuffer.transfer`, `getFloat16`, etc.).
- **Platform imports** (`@effect/platform-bun` / `-browser`) only in apps + chrome-ext entrypoints/workers — not in shared `packages/*` except tests behind clear gates.

## Error-handling discipline

Prefer `Effect.promise`, `Effect.sync`, `Effect.orDie`, `Effect.catch` with purpose — avoid no-op `catchAll`, identity `map`, redundant `tryPromise` wrappers. See `feedback_no_unnecessary_control_flow.md`.

## Verification (every package)

```sh
nix run github:0xbigboss/bun-overlay#bun -- x --bun tsgo --noEmit -p <package>/tsconfig.json
nix run github:0xbigboss/bun-overlay#bun -- x --bun vitest run <package>
```

Chrome-ext additionally:

```sh
cd packages/chrome-ext
nix run github:0xbigboss/bun-overlay#bun -- x --bun wxt build --mode development
nix run github:0xbigboss/bun-overlay#bun -- x --bun playwright test
```
