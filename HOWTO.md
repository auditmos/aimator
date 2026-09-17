# How to Use Claude Code Skills

This repo ships Claude Code skills in `.claude/skills/` for the parts of the workflow with rules worth encoding.

## Available Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| Prepare Project | `/prepare-project` | Run stage 0 — collect the creative decisions and save the artifacts stage 1 consumes |
| Environment Variables | `/environment-variables` | Add and validate environment variables |
| Bugfix | `/bugfix` | Reproduce a reported bug in a failing test before fixing it |

## Prepare Project

```
/prepare-project
```

Stage 0 of the pipeline is a conversation, not a generation step, and it is the one place
creative decisions enter the system. The skill owns that interview: it summarises what is
already approved, asks only about what is missing, labels its own ideas as proposals, and
refuses to write a decision the user never made.

The split it enforces is the point. You author exactly one file by hand — `project.md`,
the shared creative rules. Everything mechanical is a CLI call: directories, the byte-exact
copy of your episode source, the digests, the schema, the uniqueness of the episode number,
and the readiness gate. That is why `aimator check` can be trusted: nothing it verifies was
typed by hand.

No command in stage 0 calls a paid API.

## Environment Variables

```
/environment-variables
```

When you need a new env var at any point, this skill walks you through:

1. Adding the Zod schema to `src/lib/env.ts` — `client`, `server`, or `shared`
2. Placing the value in `.env` (defaults) or `.env.local` (secrets)
3. Adding a validation test to `src/lib/env.test.ts`

It also sets up `@t3-oss/env-core` + Zod from scratch if `src/lib/env.ts` does not exist yet.

### Example

```
/environment-variables
> "I need a WEATHER_API_KEY for the forecast client"
> Claude adds the schema, puts the secret in .env.local, and writes the test
```

## Bugfix

```
/bugfix
```

Triggers on its own whenever you report something broken. It enforces one ordering:

1. Reproduce the bug in a failing test — no implementation changes yet
2. Show you the failing test and the proposed fix, then wait for approval
3. Fix it so the test passes
4. Run the full suite to confirm nothing else broke

The point of step 1 is falsifiability. A test written *after* a fix proves the code does
what was just written; a test written *before* proves the bug was actually reproduced. If
that first test passes immediately, the bug was not reproduced and the diagnosis is wrong —
the skill stops there rather than letting you fix the wrong thing.

## Everything Else

The rest of the workflow is plain Claude Code — no skill required:

- **Planning** — describe what you want to build and ask Claude Code to explore the codebase first
- **Implementation** — TDD with vertical slices: one failing test, minimal code to pass, refactor, repeat
- **Committing** — say `commit this`, or use the built-in `/commit`

See [README.md](README.md) for the full development workflow.
