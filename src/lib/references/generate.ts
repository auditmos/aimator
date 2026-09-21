import {
  nowIso,
  type RecordedFile,
  removeFile,
  type StageFile,
  serialize,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { attach, type ImageVerdict, runImageStage } from "../image-model/index.js";
import type { PlannedArtifact } from "../media-prompt/index.js";
import { err, ok, type Result } from "../result.js";
import { type ImageTrack, referenceImage, type Workspace } from "../workspace.js";
import {
  REFERENCE_ID,
  readStage5Inputs,
  readyReferences,
  STAGE,
  Stage5BlockedError,
  type Stage5Inputs,
} from "./plan.js";

/**
 * Internal to the references module: the command that spends money.
 *
 * The order of operations around a billed call lives in `lib/image-model`;
 * what an identifier resolves to and whether it was accepted lives in
 * `lib/media-prompt`. What is left here is the part a person experiences:
 * which references this invocation is about, the lock around them, the preview
 * that spends nothing, and how loudly the command says what it is about to buy.
 *
 * That last part is new. Stage 2 could only ever buy one image per invocation,
 * because its gates left exactly one runnable; here several references become
 * drawable at once, so the report carries the number of paid calls and the
 * command prints it before the first POST rather than after the last.
 */

/** Images are opaque from stage 5 on: nothing downstream composites a reference. */
const BACKGROUND = "opaque";

const KEY_NAME: Record<ImageTrack, string> = {
  "gpt-image": "OPENAI_API_KEY",
  seedream: "BYTEPLUS_MODELARK",
};

const MODEL_NAME: Record<ImageTrack, string> = {
  "gpt-image": "AIMATOR_IMAGE_MODEL_GPT_IMAGE",
  seedream: "AIMATOR_IMAGE_MODEL_SEEDREAM",
};

/** What happened to one reference, in the words a person reads. */
export interface ReferenceOutcome {
  /** The images this call carried, by path and digest. */
  readonly attachments: readonly RecordedFile[];
  readonly id: string;
  readonly note: string;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly runId: string | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
  readonly verdict: ImageVerdict | null;
}

export interface ReferencesReport {
  /** Whether the package these references are planned by is accepted. */
  readonly approved: boolean;
  readonly artifacts: readonly ReferenceOutcome[];
  readonly created: readonly string[];
  readonly nextStep: string;
  /**
   * How many billed image calls this invocation is about. A preview states what
   * it would spend; a real run states what it spent.
   */
  readonly paidCalls: number;
  readonly problems: readonly string[];
  readonly ready: boolean;
  /** The film frame both tracks draw this episode in. */
  readonly size: string;
  readonly track: ImageTrack;
}

interface GenerateInput {
  readonly apiKey: string | null;
  /** Narrows the run; empty means "every reference the gates allow". */
  readonly artifacts: readonly string[];
  readonly episodeId: string;
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

/**
 * Why a paid call may not happen at all. Empty means it may.
 *
 * A dry run never reads the key, so it must not claim the key is missing, it
 * says what it did not check instead. Claiming to have found an absence you
 * never looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateInput, stage5: Stage5Inputs): readonly string[] {
  const problems = [...stage5.gate];

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

export async function generateReferences(input: GenerateInput): Promise<Result<ReferencesReport>> {
  const named = input.artifacts.filter((id) => !REFERENCE_ID.test(id));

  if (named.length > 0) {
    return err(
      new Stage5BlockedError([
        `--artifact "${named.join(", ")}", etap 5 rysuje wyłącznie referencje, w formie R01`,
        "klatka otwarcia należy do etapu 6, a klipy i klatki wejściowe do etapu 7",
      ])
    );
  }

  // A new charge names its target. Without a flag the gates decide what runs,
  // and what runs is never something already finished, so a bare
  // `--regenerate` would silently do nothing or, worse, hit the wrong image.
  if (input.regenerate && input.artifacts.length === 0) {
    return err(
      new Stage5BlockedError([
        "--regenerate wymaga jawnego celu: --artifact R01[,R02]",
        "nowa płatna próba zawsze dotyczy konkretnego obrazu",
      ])
    );
  }

  const survey = await readStage5Inputs(input);

  if (!survey.ok) {
    return survey;
  }

  const wanted =
    input.artifacts.length > 0
      ? input.artifacts
      : readyReferences(survey.data).map((one) => one.id);
  // Read again with the targets named, so the prompts are composed, and the
  // attachments hashed, in the same pass that is about to send them.
  const stage5 = await readStage5Inputs(input, wanted);

  if (!stage5.ok) {
    return stage5;
  }

  const targets = stage5.data.references.filter((one) => wanted.includes(one.id));
  const problems = blockers(input, stage5.data);

  if (input.mode === "dry-run") {
    return ok(preview(input, stage5.data, targets, problems));
  }

  if (problems.length > 0) {
    return err(new Stage5BlockedError(problems));
  }

  if (targets.length === 0) {
    return ok(idle(input, stage5.data));
  }

  const lock = await writeNew(
    stage5.data.paths.track.referencesLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(stage5.data.paths.track.referencesLock));
  }

  try {
    return await runAll(input, stage5.data, targets);
  } finally {
    await removeFile(stage5.data.paths.track.referencesLock);
  }
}

/** Nothing to draw: every runnable reference is done and the rest waits. */
function idle(input: GenerateInput, stage5: Stage5Inputs): ReferencesReport {
  const waiting = stage5.references.filter(
    (one) =>
      stage5.stage.artifacts[one.id]?.status === "completed" &&
      stage5.stage.artifacts[one.id]?.review.status !== "approved"
  );

  return {
    approved: stage5.gate.length === 0,
    artifacts: [],
    created: [],
    nextStep:
      waiting.length > 0
        ? `oceń i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage references --track ${input.track} --artifact ${waiting.map((one) => one.id).join(",")}`
        : `etap 5 dla odcinka "${input.episodeId}" na torze ${input.track} jest kompletny`,
    paidCalls: 0,
    problems:
      waiting.length > 0
        ? [`czekają na ocenę człowieka: ${waiting.map((one) => one.id).join(", ")}`]
        : [],
    ready: waiting.length === 0,
    size: stage5.plan.size,
    track: input.track,
  };
}

/**
 * `--dry-run`: the full plan, with no network, no secret and no write.
 *
 * It shows every prompt in full and states the number of paid calls it would
 * make, because on a stage where one command buys several images the preview's
 * job is to let a person read both the text and the bill.
 */
function preview(
  input: GenerateInput,
  stage5: Stage5Inputs,
  targets: readonly PlannedArtifact[],
  problems: readonly string[]
): ReferencesReport {
  const artifacts = targets.map((one): ReferenceOutcome => {
    const record = stage5.stage.artifacts[one.id];
    // A preview answers the question "what would this command do", so a result
    // the real run would leave alone must not be counted as a purchase here.
    const finished = record?.status === "completed" && !input.regenerate;

    if (finished) {
      return {
        attachments: attachmentsOf(one),
        id: one.id,
        note: "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
        prompt: one.text,
        runId: record?.runId ?? null,
        state: "skipped",
        verdict: null,
      };
    }

    const blocked = one.blockers.length > 0;

    return {
      attachments: attachmentsOf(one),
      id: one.id,
      note: blocked ? one.blockers.join("; ") : "gotowe do płatnego wywołania",
      prompt: one.text,
      runId: null,
      state: blocked ? "blocked" : "planned",
      verdict: null,
    };
  });
  const runnable = artifacts.filter((one) => one.state === "planned");

  return {
    approved: stage5.gate.length === 0,
    artifacts,
    created: [],
    nextStep:
      problems.length === 0 && runnable.length > 0
        ? `aimator reference generate ${input.projectId} ${input.episodeId} --track ${input.track}`
        : "usuń powyższe przeszkody przed płatnym wywołaniem",
    paidCalls: runnable.length,
    problems: [
      ...problems,
      `${KEY_NAME[input.track]} nie był czytany, próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga`,
    ],
    ready: problems.length === 0 && runnable.length > 0,
    size: stage5.plan.size,
    track: input.track,
  };
}

/** What one call carried, by path and digest, never the bytes. */
function attachmentsOf(artifact: PlannedArtifact): readonly RecordedFile[] {
  return artifact.attachments
    .filter((one) => one.sha256 !== null)
    .map((one) => ({ path: one.path, sha256: one.sha256 as string }));
}

async function runAll(
  input: GenerateInput,
  stage5: Stage5Inputs,
  targets: readonly PlannedArtifact[]
): Promise<Result<ReferencesReport>> {
  const artifacts: ReferenceOutcome[] = [];
  const created: string[] = [];

  for (const target of targets) {
    // Sequential on purpose: each reference is its own charge and its own
    // record, and a series that failed halfway has to stay legible.
    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time
    const outcome = await runOne(input, stage5, target);

    if (!outcome.ok) {
      // Whatever already succeeded stays written and reported; the series stops.
      return artifacts.length === 0
        ? outcome
        : err(
            new Stage5BlockedError([
              ...artifacts.map((earlier) => `${earlier.id}: ${earlier.note}`),
              `${target.id}: ${outcome.error.message}`,
              "seria zatrzymana; wcześniejsze wyniki zachowane",
            ])
          );
    }

    artifacts.push(outcome.data.outcome);
    created.push(...outcome.data.created);
  }

  const drawn = artifacts.filter((one) => one.state === "published" || one.state === "resumed");

  return ok({
    approved: stage5.gate.length === 0,
    artifacts,
    created,
    nextStep:
      drawn.length > 0
        ? `oceń wyniki, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage references --track ${input.track} --artifact ${drawn.map((one) => one.id).join(",")}`
        : `usuń przeszkody i powtórz: aimator reference generate ${input.projectId} ${input.episodeId} --track ${input.track}`,
    paidCalls: artifacts.filter((one) => one.state === "published").length,
    problems: artifacts
      .filter((one) => one.state === "blocked")
      .map((one) => `${one.id}: ${one.note}`),
    ready: drawn.length > 0,
    size: stage5.plan.size,
    track: input.track,
  });
}

interface OneResult {
  readonly created: readonly string[];
  readonly outcome: ReferenceOutcome;
  readonly stage: StageFile;
}

async function runOne(
  input: GenerateInput,
  stage5: Stage5Inputs,
  target: PlannedArtifact
): Promise<Result<OneResult>> {
  if (target.blockers.length > 0) {
    return ok(idleOne(stage5, target, target.blockers.join("; "), "blocked", null));
  }

  const record = stage5.stage.artifacts[target.id];

  if (record?.status === "completed" && !input.regenerate) {
    return ok(
      idleOne(
        stage5,
        target,
        "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
        "skipped",
        record.runId
      )
    );
  }

  if (target.text === null) {
    return err(
      new Stage5BlockedError([`${target.id}: nie ma czego wysłać, brak promptu z etapu 4`])
    );
  }

  const path = referencePathOf(stage5, target.id);

  if (!path.ok) {
    return path;
  }

  const attempt = await runImageStage(
    {
      apiKey: input.apiKey ?? "",
      fetch: input.fetch,
      model: input.model ?? "",
      regenerate: input.regenerate,
      runs: stage5.paths.track.runs,
      track: input.track,
      workspace: input.workspace,
    },
    {
      attachments: target.attachments
        .filter((one) => one.bytes !== null)
        .map((one) => attach(one.id, one.bytes as Buffer)),
      background: BACKGROUND,
      blocked: (problems) => new Stage5BlockedError(problems),
      inputs: target.inputs,
      key: target.id,
      prompt: target.text,
      promptVersion: stage5.plan.promptVersion,
      size: stage5.plan.size,
      stage: STAGE,
      stagePath: stage5.paths.track.referencesStage,
      target: path.data,
    }
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    created: attempt.data.created,
    outcome: {
      attachments: attachmentsOf(target),
      id: target.id,
      note: attempt.data.note,
      prompt: null,
      runId: attempt.data.runId,
      state: attempt.data.state,
      verdict: attempt.data.verdict,
    },
    stage: attempt.data.stage,
  });
}

/** A reference this invocation did not draw, and why. Nothing was written. */
function idleOne(
  stage5: Stage5Inputs,
  target: PlannedArtifact,
  note: string,
  state: ReferenceOutcome["state"],
  runId: string | null
): OneResult {
  return {
    created: [],
    outcome: {
      attachments: attachmentsOf(target),
      id: target.id,
      note,
      prompt: null,
      runId,
      state,
      verdict: null,
    },
    stage: stage5.stage,
  };
}

function referencePathOf(stage5: Stage5Inputs, id: string): Result<string> {
  return referenceImage(stage5.paths.track, id);
}
