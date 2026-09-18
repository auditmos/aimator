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

Stages 0 through 5 are implemented. Stages 6–8 are a declared contract, not working code.
Stage 1 is the first that spends money, and it refuses to call the API until stage 0 is
approved for that project and episode. Stage 2 is the first image stage and the first to
branch into two model tracks; it does not depend on stage 1 and may run alongside it.
Stage 3 is the first artifact both image tracks share, so it has no track directory level;
it refuses to spend until the screenplay is approved, and does not depend on stage 2.
Stage 4 is the first to join the text side to the image side: it is shared by both tracks
and names none of them, and it refuses to spend until the shot list is approved **and**
every character that list puts on screen has an accepted `hero.png` on both tracks.
Stage 5 is the first where the two tracks really part company — one package, two
independent sets of images, two separate reviews — and the first whose gate sits inside its
own results: R04 waits for an accepted R03 *on that track*. It is therefore also the first
where one command can buy several images, so it states how many before it sends any.

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
    ├── text-model/    # Folder form — one billed text call, shared by stages 1, 3 and 4
    │   ├── index.ts       # Public: runTextStage and what a stage brings to it
    │   ├── client.ts      # Internal — transport, redaction, refusal classification
    │   └── attempt.ts     # Internal — lock, submitted, archive, resume, publish
    ├── image-model/   # Folder form — one billed image call, shared by stages 2 and 5
    │   ├── index.ts       # Public: runImageStage, attach, frameSize, referenceLimit,
    │   │                  #         validateImage, readImageResponse
    │   ├── track.ts       # Internal — what a track accepts: the frame, the limit
    │   ├── client.ts      # Internal — both endpoints, redaction, the 24 h download
    │   ├── validate.ts    # Internal — the PNG and response verdicts, pure and offline
    │   └── attempt.ts     # Internal — submitted, archive, resume, publish
    ├── media-prompt/  # Folder form — the prompt a model receives: text + attachments
    │   ├── index.ts       # Public: readSendPlan — what a future paid call carries
    │   ├── prompt.ts      # Internal — the blocks around a published direction
    │   └── plan.ts        # Internal — ids resolved per track, and the gate that follows
    ├── artifact/     # Folder form — provenance shared by every stage
    │   ├── index.ts      # Public: the stage-file shape, digests, writes, review
    │   ├── schema.ts     # Internal — <stage>.stage.json, one shape for all stages
    │   ├── store.ts      # Internal — bytes, digests, the single dry-run gate
    │   └── review.ts     # Internal — digest verification and creative approval
    ├── project/      # Folder form — index.ts is the only entry (stage 0)
    │   ├── index.ts      # Public: initProject, addEpisode, setEpisodeSettings,
    │   │                 #         addCharacter, addCharacterSources, setCharacterBasis,
    │   │                 #         checkStage0, approveStage0,
    │   │                 #         readStage0Inputs, readStage0Character
    │   ├── schema.ts     # Internal — Zod schemas for the artifacts
    │   ├── template.ts   # Internal — the project.md scaffold
    │   └── index.test.ts # Tests through the entry
    ├── screenplay/   # Folder form — index.ts is the only entry (stage 1)
    │   ├── index.ts      # Public: generateScreenplay, checkScreenplay, approveScreenplay,
    │   │                 #         validateScreenplay, readScreenplayScenes, buildPrompt
    │   ├── prompt.ts     # Internal — the prompt constant and its declared version
    │   ├── validate.ts   # Internal — the structural verdict, pure and offline
    │   ├── review.ts     # Internal — verification and approval bound to digests
    │   ├── generate.ts   # Internal — order of operations around the paid call
    │   ├── index.test.ts    # Validator and prompt, through the entry
    │   └── generate.test.ts # Generate/check/approve, through the entry
    ├── character/    # Folder form — index.ts is the only entry (stage 2)
    │   ├── index.ts      # Public: generateCharacter, checkCharacter,
    │   │                 #         approveCharacter, buildPrompt, referencePlan
    │   ├── prompt.ts     # Internal — the three prompts, the view order, the
    │   │                 #            reference plan, the frame of each artifact,
    │   │                 #            and the declared version
    │   ├── plan.ts       # Internal — the gates, and what an artifact is drawn from
    │   ├── generate.ts   # Internal — the command: targets, lock, preview, series
    │   ├── review.ts     # Internal — per-image verification and approval
    │   ├── index.test.ts    # Prompts and the reference plan, through the entry
    │   └── generate.test.ts # Gates/resume/approve, through the entry
    ├── shot-list/    # Folder form — index.ts is the only entry (stage 3)
    │   ├── index.ts      # Public: generateShotList, checkShotList,
    │   │                 #         approveShotList, validateShotList, buildPrompt
    │   ├── prompt.ts     # Internal — the prompt constant and its declared version
    │   ├── validate.ts   # Internal — parses as it validates; returns the plan as data
    │   ├── plan.ts       # Internal — what stage 3 reads, and whether it may pay
    │   ├── review.ts     # Internal — verification and approval bound to digests
    │   ├── generate.ts   # Internal — order of operations around the paid call
    │   ├── index.test.ts    # Validator and prompt, through the entry
    │   └── generate.test.ts # Gate/resume/approve, through the entry
    ├── prompt-package/ # Folder form — index.ts is the only entry (stage 4)
    │   ├── index.ts      # Public: generatePromptPackage, checkPromptPackage,
    │   │                 #         approvePromptPackage, validatePromptPackage, buildPrompt
    │   ├── prompt.ts     # Internal — the prompt, the answer schema, the declared version
    │   ├── validate.ts   # Internal — the wiring verdict; never reads a prompt
    │   ├── render.ts     # Internal — the answer split into manifest and prompt files
    │   ├── plan.ts       # Internal — the two gates, and what stage 4 reads
    │   ├── review.ts     # Internal — verification and approval bound to digests
    │   ├── generate.ts   # Internal — the command: publish, preserve, sweep
    │   ├── index.test.ts    # Wiring verdict and prompt, through the entry
    │   └── generate.test.ts # Gates/resume/approve, through the entry
    ├── references/   # Folder form — index.ts is the only entry (stage 5)
    │   ├── index.ts      # Public: generateReferences, checkReferences,
    │   │                 #         approveReferences
    │   ├── plan.ts       # Internal — which references are ready, and the three
    │   │                 #            obstacles that belong to the command
    │   ├── generate.ts   # Internal — the command: targets, lock, preview, series
    │   ├── review.ts     # Internal — per-image verification and approval
    │   └── index.test.ts    # Graph gate/series/resume/approve, through the entry
    ├── result.ts     # Result<T> — the recoverable-error contract
    └── result.test.ts
```

`lib/artifact` exists because five stages now write the same state file, and
`lib/text-model` because three stages make the same paid text call. A stage never reaches
into another stage's internals: shared pieces are promoted out instead. When stage 4 became
the third text stage, `lib/text-model` grew from transport alone to the whole lifecycle —
lock, `submitted` before the POST, archive, resume from a saved answer, publish only what
validates — because that order *is* the contract and three copies of it would have made an
invariant into a coincidence. A stage now brings its prompt, its verdict and its files;
the sequence is not its business. Do the same with the next thing two stages copy.

`lib/image-model` was promoted at the **second** caller, not the third, and the difference
is deliberate. With `text-model` the third stage was a discovery; here stage 6 is a
contracted certainty that draws one image exactly the way stage 5 does, so waiting would
have been choosing to repeat a mistake already paid for — the two copies of the text
lifecycle had drifted in their comments before anyone merged them. Stage 7 is **not** a
fourth caller: a video clip is an asynchronous job with an id to poll, which is a different
order of operations and earns its own module rather than a flag in this one. The promotion
also settled where a frame belongs: `1920x1920` is a fact about a character sheet, so it
stays in `lib/character`, while "which endpoint, and how the bytes travel" is true of any
image and moved out.

`lib/media-prompt` exists because a prompt to an image or video model is only half written
when stage 4 publishes it. It cannot live inside `lib/prompt-package`, which is the one
artifact forbidden to name a track, and it cannot live inside stage 5, which stages 6 and 7
would then have to reach into. Resolving `hero:ewa` to a file per track is also what answers
the gate — an attachment nobody accepted is not one this pipeline sends — so the list and
the verdict on it are one question asked once. Stage 2 keeps its own numbering: rule 8 fixes
the *position*, and what follows the equals sign is each stage's vocabulary, which for stage
2 is file names because its references never had manifest ids.

## Pipeline rules

Nine rules that stop an agent from re-creating the mess this tool was built to replace.
Full contract in [docs/pipeline.md](docs/pipeline.md).

1. **One state filename: `<stage>.stage.json`.** One shape for every stage. Never invent
   `screenplay-state.json`, `references-state.json` or `downstream-status.json`.
2. **The image-model track is a directory level** (`gpt-image/`, `seedream/`), never a
   filename prefix and never a parallel tree. **A character is a directory level too**
   (`characters/ewa/`, `characters/tata/`), for the same reason.
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
8. **A prompt to an image or video model is text *plus* ordered attachments, and the text
   addresses them by position.** The sending stage prints `Image N = <id> — <role>` ahead
   of the task, generated at call time and never stored; a planning stage may write an id
   into prose only because that list is guaranteed. Never a filename, a path or a track
   name — the id resolves to a file at the sender, per track, which is what lets one prompt
   package serve both. `character/prompt.ts` shows the shape; stages 5–7 owe the same.
9. **An instruction to a model is written in English; material the model works from stays
   in the language it was authored in.** Role decides, not readership. Every stage's task
   text and every artifact that is itself a prompt — `prompts/**`, including its `subject`
   labels, which reach the model in the attachment list — are English. `project.md`,
   `source.md`, `screenplay.md` and `shot-list.md` travel verbatim and are never translated:
   their digests are recorded, and a translation is a second version of the same truth. A
   request is therefore often bilingual, by design. `language` is the film's language — what
   is spoken and captioned on screen — and never the language of a prompt.

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
- One model variable **per image track** (`AIMATOR_IMAGE_MODEL_GPT_IMAGE`,
  `AIMATOR_IMAGE_MODEL_SEEDREAM`), because the two tracks are drawn side by side and a
  single shared variable would make running both from one shell an edit between commands.
  Neither has a default, for the same reason `AIMATOR_SCREENPLAY_MODEL` does not.
- One model variable **per paid call site**, so `AIMATOR_SHOTLIST_MODEL` is stage 3's own
  and `AIMATOR_PROMPTS_MODEL` is stage 4's, rather than a reuse of stage 1's: sharing one
  would mean that choosing a model for the screenplay quietly chose one for the shot list
  and for the prompt package, which nobody decided.

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
