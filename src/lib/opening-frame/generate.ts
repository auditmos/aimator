import {
  nowIso,
  type RecordedFile,
  removeFile,
  serialize,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { attach, type ImageVerdict, runImageStage } from "../image-model/index.js";
import type { PlannedArtifact } from "../media-prompt/index.js";
import { err, ok, type Result } from "../result.js";
import type { ImageTrack, Workspace } from "../workspace.js";
import {
  isDrawable,
  OPENING_FRAME,
  readStage6Inputs,
  STAGE,
  Stage6BlockedError,
  type Stage6Inputs,
} from "./plan.js";

/**
 * Internal to the opening-frame module: the command that spends money.
 *
 * It is stage 5's command with the set taken out. One artifact means no target
 * list, no count of runnable roots and no series that has to stay legible after
 * failing halfway, so what stage 5 needed a hundred lines to say carefully,
 * this says once.
 *
 * The number of paid calls is still reported, and still before the POST rather
 * than after it. It is always zero or one, which is exactly why stating it
 * costs nothing and reading it is worth something: a person who ran
 * `--dry-run` wants to know whether this command is about to buy an image or
 * tell them it cannot.
 */

/** Film frames are opaque: nothing downstream composites the opening frame. */
const BACKGROUND = "opaque";

const KEY_NAME: Record<ImageTrack, string> = {
  "gpt-image": "OPENAI_API_KEY",
  seedream: "BYTEPLUS_MODELARK",
};

const MODEL_NAME: Record<ImageTrack, string> = {
  "gpt-image": "AIMATOR_IMAGE_MODEL_GPT_IMAGE",
  seedream: "AIMATOR_IMAGE_MODEL_SEEDREAM",
};

/** What happened to the frame, in the words a person reads. */
export interface OpeningFrameOutcome {
  /** The images this call carried, by path and digest, never the bytes. */
  readonly attachments: readonly RecordedFile[];
  readonly id: string;
  readonly note: string;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly runId: string | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
  readonly verdict: ImageVerdict | null;
}

export interface OpeningFrameReport {
  /** Whether the package this frame is planned by is accepted. */
  readonly approved: boolean;
  readonly artifact: OpeningFrameOutcome;
  readonly created: readonly string[];
  readonly nextStep: string;
  /**
   * How many billed image calls this invocation is about, zero or one. A
   * preview states what it would spend; a real run states what it spent.
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
  /**
   * Accepted for symmetry with every other stage's command, and refused unless
   * it names this stage's one artifact. It narrows nothing; there is nothing
   * to narrow, so leaving it out is the normal way to call this.
   */
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
function blockers(input: GenerateInput, stage6: Stage6Inputs): readonly string[] {
  const problems = [...stage6.gate];

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

/** What one call carried, by path and digest, never the bytes. */
function attachmentsOf(artifact: PlannedArtifact): readonly RecordedFile[] {
  return artifact.attachments
    .filter((one) => one.sha256 !== null)
    .map((one) => ({ path: one.path, sha256: one.sha256 as string }));
}

export async function generateOpeningFrame(
  input: GenerateInput
): Promise<Result<OpeningFrameReport>> {
  const named = input.artifacts.filter((id) => id !== OPENING_FRAME);

  if (named.length > 0) {
    return err(
      new Stage6BlockedError([
        `--artifact "${named.join(", ")}", etap 6 rysuje wyłącznie klatkę otwarcia, czyli ${OPENING_FRAME}`,
        "referencje należą do etapu 5, a klipy i klatki wejściowe do etapu 7",
      ])
    );
  }

  // Unlike stage 5, `--regenerate` needs no target: there is exactly one image
  // it could mean, so demanding that it be named would be asking a question
  // with a single possible answer.
  const stage6 = await readStage6Inputs(input, true);

  if (!stage6.ok) {
    return stage6;
  }

  const problems = blockers(input, stage6.data);

  if (input.mode === "dry-run") {
    return ok(preview(input, stage6.data, problems));
  }

  if (problems.length > 0) {
    return err(new Stage6BlockedError(problems));
  }

  if (stage6.data.opening.blockers.length > 0) {
    return err(new Stage6BlockedError(stage6.data.opening.blockers));
  }

  if (!isDrawable(stage6.data, input.regenerate)) {
    return ok(idle(input, stage6.data));
  }

  const lock = await writeNew(
    stage6.data.paths.track.openingFrameLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(stage6.data.paths.track.openingFrameLock));
  }

  try {
    return await runOne(input, stage6.data);
  } finally {
    await removeFile(stage6.data.paths.track.openingFrameLock);
  }
}

/** The frame is already drawn and this invocation is not allowed to redraw it. */
function idle(input: GenerateInput, stage6: Stage6Inputs): OpeningFrameReport {
  const record = stage6.stage.artifacts[OPENING_FRAME];
  const waiting = record?.review.status !== "approved";

  return {
    approved: stage6.gate.length === 0,
    artifact: {
      attachments: attachmentsOf(stage6.opening),
      id: OPENING_FRAME,
      note: "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
      prompt: null,
      runId: record?.runId ?? null,
      state: "skipped",
      verdict: null,
    },
    created: [],
    nextStep: waiting
      ? `oceń i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`
      : `etap 6 dla odcinka "${input.episodeId}" na torze ${input.track} jest kompletny, dalej etap 7, klipy`,
    paidCalls: 0,
    problems: waiting ? ["klatka czeka na ocenę człowieka"] : [],
    ready: !waiting,
    size: stage6.plan.size,
    track: input.track,
  };
}

/**
 * What a preview says about the one artifact, in the order that matters.
 *
 * A finished result outranks a shut gate: the question a preview answers is
 * "what would this command do", and what it would do to an image it is not
 * allowed to redraw is nothing, regardless of what the gate says about an
 * image it would not be drawing anyway.
 */
function verdictOf(
  stage6: Stage6Inputs,
  finished: boolean,
  blocked: boolean
): { note: string; state: OpeningFrameOutcome["state"] } {
  if (finished) {
    return {
      note: "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
      state: "skipped",
    };
  }

  return blocked
    ? { note: stage6.opening.blockers.join("; "), state: "blocked" }
    : { note: "gotowe do płatnego wywołania", state: "planned" };
}

/**
 * `--dry-run`: the full plan, with no network, no secret and no write.
 *
 * It shows the prompt in full even when the gate is shut, because that is what
 * a preview is for, and it counts the call it would actually make, which is
 * zero when the frame is already drawn. Stage 5 got this wrong once, counting
 * finished results as purchases and overstating the bill on the one command a
 * person runs to find out what something costs.
 */
function preview(
  input: GenerateInput,
  stage6: Stage6Inputs,
  problems: readonly string[]
): OpeningFrameReport {
  const record = stage6.stage.artifacts[OPENING_FRAME];
  const finished = record?.status === "completed" && !input.regenerate;
  const blocked = stage6.opening.blockers.length > 0;
  const { note, state } = verdictOf(stage6, finished, blocked);
  const runnable = state === "planned" && problems.length === 0;

  return {
    approved: stage6.gate.length === 0,
    artifact: {
      attachments: attachmentsOf(stage6.opening),
      id: OPENING_FRAME,
      note,
      prompt: stage6.opening.text,
      runId: finished ? (record?.runId ?? null) : null,
      state,
      verdict: null,
    },
    created: [],
    nextStep: runnable
      ? `aimator opening-frame generate ${input.projectId} ${input.episodeId} --track ${input.track}`
      : "usuń powyższe przeszkody przed płatnym wywołaniem",
    paidCalls: runnable ? 1 : 0,
    problems: [
      ...problems,
      ...(blocked ? stage6.opening.blockers : []),
      `${KEY_NAME[input.track]} nie był czytany, próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga`,
    ],
    ready: runnable,
    size: stage6.plan.size,
    track: input.track,
  };
}

async function runOne(
  input: GenerateInput,
  stage6: Stage6Inputs
): Promise<Result<OpeningFrameReport>> {
  const target = stage6.opening;

  if (target.text === null) {
    return err(
      new Stage6BlockedError([
        "nie ma czego wysłać, etap 4 nie opublikował promptu klatki otwarcia",
      ])
    );
  }

  const attempt = await runImageStage(
    {
      apiKey: input.apiKey ?? "",
      fetch: input.fetch,
      model: input.model ?? "",
      regenerate: input.regenerate,
      runs: stage6.paths.track.runs,
      track: input.track,
      workspace: input.workspace,
    },
    {
      attachments: target.attachments
        .filter((one) => one.bytes !== null)
        .map((one) => attach(one.id, one.bytes as Buffer)),
      background: BACKGROUND,
      blocked: (problems) => new Stage6BlockedError(problems),
      inputs: target.inputs,
      key: OPENING_FRAME,
      prompt: target.text,
      promptVersion: stage6.plan.promptVersion,
      size: stage6.plan.size,
      stage: STAGE,
      stagePath: stage6.paths.track.openingFrameStage,
      target: stage6.paths.track.openingFrameImage,
    }
  );

  if (!attempt.ok) {
    return attempt;
  }

  const drawn = attempt.data.state === "published" || attempt.data.state === "resumed";

  return ok({
    approved: stage6.gate.length === 0,
    artifact: {
      attachments: attachmentsOf(target),
      id: OPENING_FRAME,
      note: attempt.data.note,
      prompt: null,
      runId: attempt.data.runId,
      state: attempt.data.state,
      verdict: attempt.data.verdict,
    },
    created: attempt.data.created,
    nextStep: drawn
      ? `oceń wynik, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`
      : `usuń przeszkody i powtórz: aimator opening-frame generate ${input.projectId} ${input.episodeId} --track ${input.track}`,
    paidCalls: attempt.data.state === "published" ? 1 : 0,
    problems: [],
    ready: drawn,
    size: stage6.plan.size,
    track: input.track,
  });
}
