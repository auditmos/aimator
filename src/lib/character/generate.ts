import {
  nowIso,
  type RecordedFile,
  removeFile,
  type StageFile,
  serialize,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { type ImageVerdict, runImageStage } from "../image-model/index.js";
import { readStage0Character, type Stage0Character } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  characterPaths,
  characterTrackPaths,
  type ImageTrack,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import {
  accepted,
  buildPlan,
  nextGroup,
  outputPath,
  readStage,
  type Scope,
  Stage2BlockedError,
  sequenceGate,
} from "./plan.js";
import { CHARACTER_ARTIFACTS, type CharacterArtifact, PROMPT_VERSION, sizeOf } from "./prompt.js";

/** What happened to one of the ten, in the words a person reads. */
export interface ArtifactOutcome {
  readonly artifact: CharacterArtifact;
  readonly note: string;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly references: readonly RecordedFile[];
  readonly runId: string | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
  readonly verdict: ImageVerdict | null;
}

interface OneResult {
  readonly created: readonly string[];
  readonly outcome: ArtifactOutcome;
  readonly stage: StageFile;
}

/**
 * Internal to the character module: the command that spends money.
 *
 * It owns the shape of a run and nothing else. What an artifact is drawn from
 * and whether it may be drawn yet live in `plan.ts`; one billed attempt lives
 * in `attempt.ts`. What is left here is the part a person experiences: which
 * artifacts this invocation is about, the lock around them, the preview that
 * spends nothing, and the order the series stops in when one of them fails.
 *
 * Nothing is written in `--dry-run`, and the preview never reads a key, it
 * says what it did not check instead, because claiming to have found an
 * absence you never looked for is the same lie as claiming a success you
 * never had.
 */

/** The one stage name this module writes. */
const STAGE = "character";

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
      `inna próba trzyma blokadę ${path}, po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`
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
 * A dry run never reads the key, so it must not claim the key is missing, it
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
      `brak modelu obrazowego dla toru ${input.track}, wskaż go przez --model <id> albo ${MODEL_NAME[input.track]}`
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
  // next, and what runs next is never something already finished, so a bare
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
      `${KEY_NAME[input.track]} nie był czytany, próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga`,
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
    return ok(idleOutcome(scope, artifact, gate.join("; "), "blocked", null));
  }

  const record = scope.stage.artifacts[artifact];

  if (record?.status === "completed" && !input.regenerate) {
    return ok(
      idleOutcome(
        scope,
        artifact,
        "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
        "skipped",
        record.runId
      )
    );
  }

  // Built before the attempt rather than inside it: the references are re-read
  // and re-hashed here, so a card edited outside the tool cannot silently
  // become the authority for the eight views drawn from it, and the same list
  // is what a resume compares its recorded inputs against.
  const plan = await buildPlan(input, scope, artifact);

  if (!plan.ok) {
    return plan;
  }

  const target = outputPath(scope.paths, artifact);

  if (!target.ok) {
    return target;
  }

  const { background, size } = sizeOf(artifact);
  const attempt = await runImageStage(
    {
      apiKey: input.apiKey ?? "",
      fetch: input.fetch,
      model: input.model ?? "",
      regenerate: input.regenerate,
      runs: scope.paths.runs,
      track: input.track,
      workspace: input.workspace,
    },
    {
      attachments: plan.data.attachments,
      background,
      blocked: (problems) => new Stage2BlockedError(problems),
      inputs: plan.data.inputs,
      key: artifact,
      prompt: plan.data.prompt,
      promptVersion: PROMPT_VERSION,
      size,
      stage: STAGE,
      stagePath: scope.paths.stage,
      target: target.data,
    }
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    created: attempt.data.created,
    outcome: {
      artifact,
      note: attempt.data.note,
      prompt: null,
      references: plan.data.references,
      runId: attempt.data.runId,
      state: attempt.data.state,
      verdict: attempt.data.verdict,
    },
    stage: attempt.data.stage,
  });
}

/** An artifact this invocation did not draw, and why. Nothing was written. */
function idleOutcome(
  scope: Scope,
  artifact: CharacterArtifact,
  note: string,
  state: ArtifactOutcome["state"],
  runId: string | null
): OneResult {
  return {
    created: [],
    outcome: { artifact, note, prompt: null, references: [], runId, state, verdict: null },
    stage: scope.stage,
  };
}
