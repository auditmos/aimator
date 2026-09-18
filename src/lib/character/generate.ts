import { nowIso, removeFile, serialize, type WriteMode, writeNew } from "../artifact/index.js";
import { readStage0Character, type Stage0Character } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  characterPaths,
  characterTrackPaths,
  type ImageTrack,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { type ArtifactOutcome, attempt, type OneResult, resume } from "./attempt.js";
import {
  accepted,
  buildPlan,
  nextGroup,
  readStage,
  type Scope,
  Stage2BlockedError,
  sequenceGate,
} from "./plan.js";
import { CHARACTER_ARTIFACTS, type CharacterArtifact } from "./prompt.js";

/**
 * Internal to the character module: the command that spends money.
 *
 * It owns the shape of a run and nothing else. What an artifact is drawn from
 * and whether it may be drawn yet live in `plan.ts`; one billed attempt lives
 * in `attempt.ts`. What is left here is the part a person experiences: which
 * artifacts this invocation is about, the lock around them, the preview that
 * spends nothing, and the order the series stops in when one of them fails.
 *
 * Nothing is written in `--dry-run`, and the preview never reads a key — it
 * says what it did not check instead, because claiming to have found an
 * absence you never looked for is the same lie as claiming a success you
 * never had.
 */

export interface CharacterReport {
  /** Whether stage 0 is approved for this project. */
  readonly approved: boolean;
  readonly artifacts: readonly ArtifactOutcome[];
  readonly created: readonly string[];
  readonly name: string;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly ready: boolean;
  readonly track: ImageTrack;
}

interface GenerateCharacterInput {
  readonly apiKey: string | null;
  /** Narrows the run; empty means "whatever the gates allow next". */
  readonly artifacts: readonly CharacterArtifact[];
  readonly characterId: string;
  readonly fetch: typeof fetch;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

class LockError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `inna próba trzyma blokadę ${path} — po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`
    );
    this.name = "LockError";
    this.path = path;
  }
}

/** The secret's env var, named per track so an error can say which one is missing. */
const KEY_NAME: Record<ImageTrack, string> = {
  "gpt-image": "OPENAI_API_KEY",
  seedream: "BYTEPLUS_MODELARK",
};

const MODEL_NAME: Record<ImageTrack, string> = {
  "gpt-image": "AIMATOR_IMAGE_MODEL_GPT_IMAGE",
  seedream: "AIMATOR_IMAGE_MODEL_SEEDREAM",
};

/**
 * Why a paid call may not happen at all. Empty means it may.
 *
 * A dry run never reads the key, so it must not claim the key is missing — it
 * says what it did not check instead. Claiming to have found an absence you
 * never looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateCharacterInput, stage0: Stage0Character): readonly string[] {
  const problems = [...(stage0.approved ? [] : stage0.problems)];

  if (!stage0.approved) {
    problems.push(
      `etap 0 musi mieć review.status = "approved" zanim etap 2 wyda pieniądze: aimator approve ${input.projectId}`
    );
  }

  if (input.model === null || input.model === "") {
    problems.push(
      `brak modelu obrazowego dla toru ${input.track} — wskaż go przez --model <id> albo ${MODEL_NAME[input.track]}`
    );
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push(`brak ${KEY_NAME[input.track]} w środowisku lub .env`);
  }

  return problems;
}

export async function generateCharacter(
  input: GenerateCharacterInput
): Promise<Result<CharacterReport>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const character = characterPaths(project.data, input.characterId);

  if (!character.ok) {
    return character;
  }

  const stage0 = await readStage0Character(input);

  if (!stage0.ok) {
    return stage0;
  }

  const paths = characterTrackPaths(character.data, input.track);
  const stage = await readStage(paths.stage);

  // A new charge names its target. Without a flag the gates decide what runs
  // next, and what runs next is never something already finished — so a bare
  // `--regenerate` would silently do nothing or, worse, hit the wrong image.
  if (input.regenerate && input.artifacts.length === 0) {
    return err(
      new Stage2BlockedError([
        `--regenerate wymaga jawnego celu: --artifact ${CHARACTER_ARTIFACTS.join("|")}`,
        "nowa płatna próba zawsze dotyczy konkretnego obrazu",
      ])
    );
  }

  const problems = blockers(input, stage0.data);
  const targets = input.artifacts.length > 0 ? input.artifacts : nextGroup(stage);
  const scope: Scope = { paths, stage, stage0: stage0.data };

  if (input.mode === "dry-run") {
    return await preview(input, scope, targets, problems);
  }

  if (problems.length > 0) {
    return err(new Stage2BlockedError(problems));
  }

  if (targets.length === 0) {
    return ok(idle(input, scope));
  }

  const lock = await writeNew(paths.lock, serialize({ pid: process.pid, startedAt: nowIso() }));

  if (!lock.ok) {
    return err(new LockError(paths.lock));
  }

  try {
    return await runAll(input, scope, targets);
  } finally {
    await removeFile(paths.lock);
  }
}

/** Nothing to do: every runnable step is done and the rest waits on a human. */
function idle(input: GenerateCharacterInput, scope: Scope): CharacterReport {
  const waiting = CHARACTER_ARTIFACTS.filter(
    (artifact) =>
      scope.stage.artifacts[artifact]?.status === "completed" && !accepted(scope.stage, artifact)
  );

  return {
    approved: scope.stage0.approved,
    artifacts: [],
    created: [],
    name: scope.stage0.name,
    nextStep:
      waiting.length > 0
        ? `oceń i zatwierdź: aimator approve ${input.projectId} ${input.characterId} --stage character --track ${input.track} --artifact ${waiting.join(",")}`
        : `etap 2 dla "${input.characterId}" na torze ${input.track} jest kompletny`,
    problems: waiting.length > 0 ? [`czekają na ocenę człowieka: ${waiting.join(", ")}`] : [],
    ready: waiting.length === 0,
    track: input.track,
  };
}

/**
 * `--dry-run`: the full plan, with no network, no secret and no write.
 *
 * It shows every prompt in full, because the point of a preview on a stage this
 * expensive is to let a person read what would be sent before it is.
 */
async function preview(
  input: GenerateCharacterInput,
  scope: Scope,
  targets: readonly CharacterArtifact[],
  problems: readonly string[]
): Promise<Result<CharacterReport>> {
  const outcomes: ArtifactOutcome[] = [];

  for (const artifact of targets) {
    // biome-ignore lint/performance/noAwaitInLoops: one plan at a time, in order
    const planned = await planOne(input, scope, artifact);

    if (!planned.ok) {
      return planned;
    }

    outcomes.push(planned.data);
  }

  const gated = outcomes.filter((outcome) => outcome.state === "blocked");

  return ok({
    approved: scope.stage0.approved,
    artifacts: outcomes,
    created: [],
    name: scope.stage0.name,
    nextStep:
      problems.length === 0 && gated.length === 0
        ? `aimator character generate ${input.projectId} ${input.characterId} --track ${input.track}`
        : "usuń powyższe przeszkody przed płatnym wywołaniem",
    problems: [
      ...problems,
      `${KEY_NAME[input.track]} nie był czytany — próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga`,
    ],
    ready: problems.length === 0 && gated.length === 0,
    track: input.track,
  });
}

/**
 * What one artifact would be drawn from, and the exact prompt for it.
 *
 * The references are re-read and re-hashed here rather than trusted from the
 * stage file: a card edited outside the tool must not silently become the
 * authority for eight views drawn from it.
 */
async function planOne(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Result<ArtifactOutcome>> {
  const gate = sequenceGate(scope.stage, artifact);
  const plan = await buildPlan(input, scope, artifact);

  if (!plan.ok) {
    return gate.length > 0
      ? ok({
          artifact,
          note: gate.join("; "),
          prompt: null,
          references: [],
          runId: null,
          state: "blocked",
          verdict: null,
        })
      : plan;
  }

  return ok({
    artifact,
    note: gate.length > 0 ? gate.join("; ") : "gotowe do płatnego wywołania",
    prompt: plan.data.prompt,
    references: plan.data.references,
    runId: null,
    state: gate.length > 0 ? "blocked" : "planned",
    verdict: null,
  });
}

async function runAll(
  input: GenerateCharacterInput,
  scope: Scope,
  targets: readonly CharacterArtifact[]
): Promise<Result<CharacterReport>> {
  const outcomes: ArtifactOutcome[] = [];
  const created: string[] = [];
  let { stage } = scope;

  for (const artifact of targets) {
    // Sequential on purpose: a view is drawn from the card, and the eight of
    // them are eight separate charges that must stay individually legible.
    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time
    const outcome = await runOne(input, { ...scope, stage }, artifact);

    if (!outcome.ok) {
      // Whatever already succeeded stays written and reported; the series stops.
      return outcomes.length === 0
        ? outcome
        : err(
            new Stage2BlockedError([
              ...outcomes.map((earlier) => `${earlier.artifact}: ${earlier.note}`),
              `${artifact}: ${outcome.error.message}`,
              "seria zatrzymana; wcześniejsze wyniki zachowane",
            ])
          );
    }

    const done = outcome.data;

    outcomes.push(done.outcome);
    created.push(...done.created);
    ({ stage } = done);
  }

  const drawn = outcomes.filter((outcome) => outcome.state !== "blocked");

  return ok({
    approved: scope.stage0.approved,
    artifacts: outcomes,
    created,
    name: scope.stage0.name,
    nextStep:
      drawn.length > 0
        ? `oceń wyniki, a potem: aimator approve ${input.projectId} ${input.characterId} --stage character --track ${input.track} --artifact ${drawn.map((o) => o.artifact).join(",")}`
        : `usuń przeszkody i powtórz: aimator character generate ${input.projectId} ${input.characterId} --track ${input.track}`,
    problems: outcomes.filter((o) => o.state === "blocked").map((o) => `${o.artifact}: ${o.note}`),
    ready: drawn.length > 0,
    track: input.track,
  });
}

async function runOne(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Result<OneResult>> {
  const gate = sequenceGate(scope.stage, artifact);

  if (gate.length > 0) {
    return ok({
      created: [],
      outcome: {
        artifact,
        note: gate.join("; "),
        prompt: null,
        references: [],
        runId: null,
        state: "blocked",
        verdict: null,
      },
      stage: scope.stage,
    });
  }

  const record = scope.stage.artifacts[artifact];

  if (record !== undefined && !input.regenerate) {
    if (record.status === "completed") {
      return ok({
        created: [],
        outcome: {
          artifact,
          note: "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
          prompt: null,
          references: [],
          runId: record.runId,
          state: "skipped",
          verdict: null,
        },
        stage: scope.stage,
      });
    }

    return await resume(input, scope, artifact, record);
  }

  return await attempt(input, scope, artifact);
}
