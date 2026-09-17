# AGENTS.md

## Project Overview

TypeScript template for building tool/service projects. Uses ESM-only modules with strict TypeScript, Biome for linting/formatting, Vitest for testing, and semantic-release for automated releases.

## Project Structure

```
src/
├── index.ts          # Package API — re-exports what consumers need
├── bin.ts            # Executable — shebang, streams, exit code
├── cli.ts            # Single-file form — run(argv): Result<string>
├── cli.test.ts
├── config/
│   └── index.ts      # App-level config (imports env, exports typed config)
└── lib/
    ├── env.ts        # Single-file form — no internals to hide yet
    ├── env.test.ts   # Co-located test for env validation
    ├── example/      # Folder form — index.ts is the only entry
    │   ├── index.ts      # Public: greet()
    │   ├── normalize.ts  # Internal — never re-exported
    │   └── index.test.ts # Tests through the entry
    ├── result.ts     # Result<T> — the recoverable-error contract
    └── result.test.ts
```

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
| Env | `src/lib/env.ts` | `env` | Zod schemas, `process.env` access |
| CLI | `src/cli.ts` | `run(argv): Result<string>` | Argument parsing, usage text, command dispatch |
| Executable | `src/bin.ts` | none — a process entry | `process.argv`, stdout/stderr, exit code |

`bin.ts` stays a shim on purpose: keeping streams and exit codes out of `run()` is what lets the CLI be tested by calling a function instead of spawning a process.

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
| `pnpm rename <name>` | Rename the package, CLI command, usage text, and README title |

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
- Non-sensitive defaults go in `.env` (committed)
- Secrets go in `.env.local` (gitignored)
- Access via: `import { env } from "./lib/env.js"`

## Development Workflow

1. Plan the change, exploring the existing code first
2. Before creating a file or adding an `export`, run the Deep Modules decision checks above
3. Implement with TDD in vertical slices (red → green → refactor, one test at a time)
4. Use the `environment-variables` skill when adding or changing env vars
5. Use the `bugfix` skill when something is reported broken — failing test first, then the fix
6. Commit with a conventional commit message; the pre-commit hook runs lint + tests

## Formatting Rules

- Biome with the `ultracite/biome/core` preset
- Line width: 100 (overrides the preset's 80)
- Indentation: 2 spaces (from the preset)
- Unused imports: warned
