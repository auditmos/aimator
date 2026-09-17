# aimator

TypeScript template for building tool and service projects with modern tooling, strict type-checking, and automated releases.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/)

## Setup

```bash
pnpm install
```

This installs dependencies and configures git hooks automatically via the `prepare` script.

## After generating from this template

Nothing is broken on arrival — `pnpm install` is enough to lint, type-check, test, build, and run the CLI. What follows is the part that is still the template's rather than yours.

**Rename** — one command covers everything that is genuinely wrong until you change it:

```bash
pnpm rename my-project
```

It rewrites `name` and the `bin` command in `package.json`, the CLI usage text, and this README's title, then reports what it changed. A scoped name like `@acme/my-project` still gets a plain `my-project` command on the PATH.

**Replace the demo code.** It is working reference material for the deep-module folder form, `Result<T>`, and the CLI wiring, so keep it until the example stops being useful:

- [ ] `src/lib/example/` — the `greet` / `normalize` module
- [ ] the `greet` command in `src/cli.ts` (the usage text is handled by `pnpm rename`)
- [ ] the `greet` export in `src/index.ts`
- [ ] the matching `*.test.ts` files

**Rewrite the docs** — these still describe the template itself:

- [ ] this README
- [ ] the project overview and structure tree in `AGENTS.md` (`CLAUDE.md` is a symlink to it)

**Decide:**

- [ ] `private: true` stays unless you publish. To publish, drop it and add `@semantic-release/npm` plus a `files` field — the current config only creates GitHub Releases, with no artifact attached.

### Two things that surprise people

**Your first commit must be conventional.** commitlint is active the moment `pnpm install` finishes:

```bash
$ git commit -m "my first commit"
✖ type may not be empty [type-empty]
```

Use something like `chore: initial commit`.

**Releases turn themselves on.** Your repo is not a GitHub template, so the release job that is skipped upstream runs here: the first push to `main` containing a `feat:` commit cuts v1.0.0. There is no setup step, and equally no opt-in.

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

## CLI

During development, run the CLI straight from source — no build step:

```bash
pnpm dev greet Ada          # Hello, Ada!
pnpm dev --help             # usage
```

The build produces the same thing as a standalone executable:

```bash
pnpm build

./dist/bin.js greet Ada     # Hello, Ada!
./dist/bin.js nope          # stderr + exit 1
```

`pnpm dev` uses `tsx` rather than Node's native type stripping, because TypeScript's `Node16` resolution writes `.js` specifiers that Node will not map back to `.ts` files.

`bin` maps the command `ts-template` to `dist/bin.js`, so installing the package exposes it on the PATH. Note the package is `private: true`, so that happens via a local install or `pnpm link`, not from a registry.

`src/bin.ts` is a deliberately thin shim owning the shebang, streams, and exit code. All behaviour lives in `src/cli.ts` as `run(argv): Result<string>`, which is why the CLI is tested by calling a function rather than spawning a process.

## Architecture

Code here follows **deep modules** (Ousterhout): a small interface over a large implementation. A module hides complexity behind one entry point rather than scattering it across many tiny files.

- A domain starts as a single file — `src/lib/{domain}.ts`
- Once it grows internals, it becomes `src/lib/{domain}/` with `index.ts` as its only entry
- Export only what a caller needs; `pnpm unused` fails CI on exports nobody imports

Full rules — boundaries, growth path, enforcement — are in [AGENTS.md](AGENTS.md).

## Development Workflow

1. Write tests co-located with source files (`*.test.ts`)
2. Use TDD: write a failing test, make it pass, refactor
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.)
4. Pre-commit hooks automatically run linting and tests
5. Push to `main` triggers CI checks (and semantic-release, in projects generated from this template)

### Skills

The template ships two Claude Code skills — `/environment-variables` for adding a validated env var, and `/bugfix` for the failing-test-first bug fix workflow. See **[HOWTO.md](HOWTO.md)**.

### Committing

When you're done implementing, just ask Claude Code to commit:

```
commit this
```

Claude Code will stage the relevant files, write a conventional commit message based on the changes, and run the pre-commit hook (lint + tests) automatically. If the hook fails, it will fix the issues and retry.

You can also use the built-in shortcut:

```
/commit
```

## Environment Variables

Environment configuration uses `@t3-oss/env-core` with Zod validation:

- `.env` — Development defaults (committed)
- `.env.local` — Secrets and overrides (gitignored)

Define schemas in `src/lib/env.ts`.

## CI/CD

GitHub Actions runs on push to `main`:

1. Lint, type-check, test, and unused code detection
2. If all checks pass, semantic-release creates a GitHub Release with tag

The release job is skipped on this repository because it is a GitHub template — a template has no consumers, so tagging it would version an artifact nobody fetches. Repos generated from it are not templates, so releases run there automatically with no setup step.

## Contributing

1. Create a feature branch
2. Make changes following the existing patterns
3. Ensure `pnpm lint && pnpm types && pnpm test && pnpm unused` all pass
4. Open a PR against `main`
