# AGENTS.md

## Project Overview

CLI that walks a solo creator through producing a short animated episode: idea → project
and episode preparation → screenplay → character → shot list → prompt package → reference
images → opening frame → clips → final cut. ESM-only modules with strict TypeScript,
Biome for linting/formatting, Vitest for testing, semantic-release for releases.

Generated artifacts live **outside the repo**, under `AIMATOR_WORKSPACE`, grouped per
project and per image model. The stage contract — directory layout, the `*.stage.json`
shape and the cross-cutting invariants — is in [docs/pipeline.md](docs/pipeline.md).
Read it before touching anything that writes an artifact.

Stage 0 is implemented. Stages 1–8 are a declared contract, not working code.

## Project Structure

```
src/
├── index.ts          # Package API — re-exports what consumers need
├── bin.ts            # Executable — shebang, streams, exit code
├── cli.ts            # Single-file form — run(argv): Promise<Result<string>>
├── cli.test.ts
├── config/
│   └── index.ts      # App-level config (imports env, exports typed config)
└── lib/
    ├── env.ts        # Single-file form — loads .env files, validates with Zod
    ├── env.test.ts   # Co-located test for env validation
    ├── workspace.ts  # Single-file form — the ONLY module that knows the layout
    ├── workspace.test.ts
    ├── project/      # Folder form — index.ts is the only entry (stage 0)
    │   ├── index.ts      # Public: initProject, addEpisode, setEpisodeSettings,
    │   │                 #         addCharacterSources, setCharacterBasis,
    │   │                 #         checkStage0, approveStage0
    │   ├── schema.ts     # Internal — Zod schemas for the artifacts
    │   ├── template.ts   # Internal — the project.md scaffold
    │   ├── store.ts      # Internal — bytes, digests, the single dry-run gate
    │   ├── review.ts     # Internal — digest verification and creative approval
    │   └── index.test.ts # Tests through the entry
    ├── result.ts     # Result<T> — the recoverable-error contract
    └── result.test.ts
```

## Pipeline rules

Seven rules that stop an agent from re-creating the mess this tool was built to replace.
Full contract in [docs/pipeline.md](docs/pipeline.md).

1. **One state filename: `<stage>.stage.json`.** One shape for every stage. Never invent
   `screenplay-state.json`, `references-state.json` or `downstream-status.json`.
2. **The image-model track is a directory level** (`gpt-image/`, `seedream/`), never a
   filename prefix and never a parallel tree.
3. **Paths come from `src/lib/workspace.ts` only.** No other module joins path segments.
4. **A run archive never copies an input.** Inputs are referenced by path + sha256.
5. **No document in this repo records project state or progress.** State is a file read
   in the workspace; history is `git log`. `docs/pipeline.md` describes the current
   contract in the present tense and is edited in place, never appended to.
6. **Validation is not approval.** A `check` command verifies and writes nothing; only an
   explicit `approve` records acceptance, only over artifacts that already validate, and
   only bound to their current digests. Never let a passing check imply a human said yes.
7. **A decision with no default is stored, never inferred.** An absent file, an empty
   directory or a missing flag means undecided, and the gate blocks — it never stands in
   for an answer the user did not give.

## Deep Modules

Small interface, large implementation (Ousterhout). A module absorbs complexity behind a narrow entry point instead of spreading it across many tiny files. **Every implementation in this repo follows this.**

### Decision checks

- Before creating a file: does this **deepen** an existing module, or only **widen** its interface?
- Before adding an `export`: does a caller actually need this, or is it internal?
- Every export from an `index.ts` declares an explicit return type — the interface is the contract
- Many small files that each do very little are shallow modules — they add system complexity instead of hiding it

### Module boundaries

| Layer | Boundary | Interface (narrow) | Hides |
|-------|----------|--------------------|-------|
| Package API | `src/index.ts` | Only what consumers import | Everything else under `src/` |
| Domain | `src/lib/{domain}/index.ts` | Exported functions + types | Helpers, adapters, I/O, third-party types |
| Config | `src/config/index.ts` | Typed `config` object | Env wiring, defaults, coercion |
| Env | `src/lib/env.ts` | `env` | Zod schemas, `.env` loading, `process.env` access |
| Layout | `src/lib/workspace.ts` | Path builders + id rules | Every directory and file name in the workspace |
| CLI | `src/cli.ts` | `run(argv): Promise<Result<string>>` | Argument parsing, usage text, command dispatch |
| Executable | `src/bin.ts` | none — a process entry | `process.argv`, stdout/stderr, exit code |

`bin.ts` stays a shim on purpose: keeping streams and exit codes out of `run()` is what lets the CLI be tested by calling a function instead of spawning a process. `run` is async because stages write files and later stages call HTTP — but it still never touches `process`, a stream or an exit code, which is the invariant that matters.

### Growth path

A domain starts as **one file**: `src/lib/{domain}.ts`. When it grows internal parts, promote it to a folder — `src/lib/{domain}/index.ts` becomes its only entry, and siblings (`client.ts`, `schema.ts`, `queries.ts`) stay internal.

Never reach into another domain's internals — import from its `index.ts`, or promote the shared piece into a module of its own.

Don't split on file size alone. Past ~500 lines, split by **subdomain**, not by function count.

### Enforcement

- `pnpm unused` (Knip) fails on unused exports — an export no caller needs is a widened interface. Runs in CI.
- `performance/noBarrelFile` is deliberately `off` in `biome.jsonc`: an `index.ts` barrel *is* the module interface here
- Tests import the module entry only (see Testing Conventions)

## Type & Error Design

Biome and `tsconfig` already enforce the mechanical rules — `noExplicitAny`, `noUncheckedIndexedAccess`, `useForOf`, kebab-case filenames, `noParameterProperties`. Those are not repeated here. What tooling cannot check:

- Prefer discriminated unions over boolean flags — never `{ success: boolean; data?: T; error?: E }`
- Return `Result<T>` (`src/lib/result.ts`) for recoverable errors; let unexpected errors propagate to the caller
- Throw typed error classes extending `Error`, never a bare `new Error(string)`

```ts
class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

function parsePort(raw: string): Result<number> {
  const port = Number(raw);
  return Number.isInteger(port) ? ok(port) : err(new ValidationError("port", raw));
}
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build with tsup (ESM + declarations) |
| `pnpm dev` | Run the CLI from source with tsx (no build step) |
| `pnpm lint` | Check code with Biome |
| `pnpm lint:fix` | Auto-fix lint/format issues |
| `pnpm types` | Type-check with tsc --noEmit |
| `pnpm test` | Run tests with Vitest |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm unused` | Detect unused code with Knip |
| `pnpm update` | Interactive dependency updates with Taze |

## Testing Conventions

- Tests are **co-located** next to source files: `foo.ts` → `foo.test.ts`
- Use **TDD** with vertical slices (red → green → refactor, one test at a time)
- Test **behavior through public interfaces**, not implementation details
- If a test needs to import an internal file, the module boundary is wrong — test through its `index.ts`
- Run tests: `pnpm test`

## Commit Format

Conventional Commits enforced via commitlint:

```
<type>(<scope>): <description>

Types: feat, fix, refactor, test, docs, chore, ci, perf
```

Pre-commit hook runs `pnpm lint && pnpm test` automatically.

## Environment Variables

- Define schemas in `src/lib/env.ts` using `@t3-oss/env-core` + Zod
- `.env.example` is the committed reference — add every new variable to it
- `.env` and `.env.local` are both gitignored; `.env` holds your local values
- Access via: `import { env } from "./lib/env.js"`
- `env.ts` loads `.env.local` **before** `.env`, because `process.loadEnvFile` never
  overwrites a key that is already set — so the file read first wins. Precedence ends up
  shell > `.env.local` > `.env`. Do not "fix" the order.
- `AIMATOR_WORKSPACE` is optional in the schema on purpose: a missing workspace is a
  recoverable condition `run()` reports as a `Result`, not an exception at import time.

## Development Workflow

1. Plan the change, exploring the existing code first
2. Before creating a file or adding an `export`, run the Deep Modules decision checks above
3. Implement with TDD in vertical slices (red → green → refactor, one test at a time)
4. Use the `environment-variables` skill when adding or changing env vars
5. Use the `bugfix` skill when something is reported broken — failing test first, then the fix
6. Use the `develop-series` skill when a user has an idea but cannot yet answer stage 0,
   then `prepare-project` to run stage 0 itself — those two own every creative interview,
   and neither develops an episode's plot, which belongs to stage 1
7. Commit with a conventional commit message; the pre-commit hook runs lint + tests

## Formatting Rules

- Biome with the `ultracite/biome/core` preset
- Line width: 100 (overrides the preset's 80)
- Indentation: 2 spaces (from the preset)
- Unused imports: warned
