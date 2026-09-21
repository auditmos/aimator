import {
  nowIso,
  type RecordedFile,
  removeFile,
  serialize,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { attach, runImageStage } from "../image-model/index.js";
import type { PlannedArtifact } from "../media-prompt/index.js";
import { err, ok, type Result } from "../result.js";
import { runVideoStage } from "../video-model/index.js";
import { clipFrame, clipVideo, type ImageTrack, type Workspace } from "../workspace.js";
import {
  CLIP_ID,
  isClipArtifact,
  readStage7Inputs,
  readyTargets,
  STAGE,
  Stage7BlockedError,
  type Stage7Inputs,
  type Stage7Target,
} from "./plan.js";

/**
 * Internal to the clips module: the command that spends money, in two
 * currencies.
 *
 * It is stage 5's command with a second medium in it. The order of operations
 * around a billed call lives in `lib/image-model` and `lib/video-model`; what
 * an identifier resolves to and whether a human accepted it lives in
 * `lib/media-prompt`. What is left here is the part a person experiences: which
 * targets this invocation is about, the lock around them, the preview that
 * spends nothing, and how loudly the command says what it is about to buy.
 *
 * That last part matters more here than anywhere before it. A clip is the most
 * expensive thing this pipeline buys, and one command can buy an image and a
 * clip in the same run, so the report counts the two **separately**, before
 * the first request rather than after the last.
 */

/** Film frames are opaque: nothing downstream composites an entry frame. */
const BACKGROUND = "opaque";

const IMAGE_KEY_NAME: Record<ImageTrack, string> = {
  "gpt-image": "OPENAI_API_KEY",
  seedream: "BYTEPLUS_MODELARK",
};

const IMAGE_MODEL_NAME: Record<ImageTrack, string> = {
  "gpt-image": "AIMATOR_IMAGE_MODEL_GPT_IMAGE",
  seedream: "AIMATOR_IMAGE_MODEL_SEEDREAM",
};

/**
 * The video key and the video model are the same on both tracks, because the
 * model is: a track says what a clip is drawn from, not who renders it.
 */
const VIDEO_KEY_NAME = "BYTEPLUS_MODELARK";
const VIDEO_MODEL_NAME = "AIMATOR_VIDEO_MODEL";

/** What happened to one clip or entry frame, in the words a person reads. */
export interface ClipOutcome {
  /** The images this call carried, by path and digest, never the bytes. */
  readonly attachments: readonly RecordedFile[];
  readonly id: string;
  readonly kind: "clip" | "entry-frame";
  readonly note: string;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly runId: string | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
}

export interface ClipsReport {
  /** Whether the package these clips are planned by is accepted. */
  readonly approved: boolean;
  readonly artifacts: readonly ClipOutcome[];
  readonly created: readonly string[];
  readonly nextStep: string;
  /**
   * How many billed calls this invocation is about, per medium. They are
   * counted apart because they cost differently by an order of magnitude, and
   * a person reading a preview is deciding whether to run it.
   */
  readonly paidImages: number;
  readonly paidVideos: number;
  readonly problems: readonly string[];
  readonly ready: boolean;
  /** The film frame both tracks draw this episode in. */
  readonly size: string;
  readonly track: ImageTrack;
}

interface GenerateInput {
  /** Narrows the run; empty means "everything the gates allow". */
  readonly artifacts: readonly string[];
  readonly episodeId: string;
  readonly fetch: typeof fetch;
  readonly imageKey: string | null;
  readonly imageModel: string | null;
  readonly mode: WriteMode;
  readonly projectId: string;
  readonly regenerate: boolean;
  /**
   * Publishes a clip again from its archive, sending nothing and paying
   * nothing. It names the clips it republishes, because it rewrites a record a
   * human may already have accepted, and it covers clips only: an entry frame
   * is published exactly as the provider drew it, so there is no renderer there
   * whose mistake would need undoing.
   */
  readonly republish: boolean;
  readonly track: ImageTrack;
  readonly videoKey: string | null;
  readonly videoModel: string | null;
  /** Injected so a test never sleeps between polls; the default is a real wait. */
  readonly wait?: (ms: number) => Promise<void>;
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
 * It asks only about the media this run would actually use: a command that only
 * draws entry frames has no business demanding a video model, and one that only
 * renders clips has none demanding an image model. A dry run never reads a key,
 * so it must not claim one is missing, it says what it did not check instead.
 */
function blockers(
  input: GenerateInput,
  stage7: Stage7Inputs,
  targets: readonly Stage7Target[]
): readonly string[] {
  const problems = [...stage7.gate];

  // A republication sends nothing, so it needs neither a model nor a key. It
  // still answers to the package gate: what it writes into the workspace is a
  // result of a plan, and an unapproved plan is a loud problem either way.
  if (input.republish) {
    return problems;
  }

  const images = targets.some((one) => one.kind === "entry-frame");
  const videos = targets.some((one) => one.kind === "clip");

  if (images && (input.imageModel === null || input.imageModel === "")) {
    problems.push(
      `brak modelu obrazowego dla toru ${input.track}, wskaż go przez --image-model <id> albo ${IMAGE_MODEL_NAME[input.track]}`
    );
  }

  if (videos && (input.videoModel === null || input.videoModel === "")) {
    problems.push(
      `brak modelu wideo, wskaż go przez --video-model <id> albo ${VIDEO_MODEL_NAME}; jest jeden dla obu torów`
    );
  }

  if (input.mode !== "dry-run") {
    if (images && (input.imageKey === null || input.imageKey === "")) {
      problems.push(`brak ${IMAGE_KEY_NAME[input.track]} w środowisku lub .env`);
    }

    if (videos && (input.videoKey === null || input.videoKey === "")) {
      problems.push(`brak ${VIDEO_KEY_NAME} w środowisku lub .env, model wideo idzie na BytePlus`);
    }
  }

  return problems;
}

/**
 * Why a republication may not happen, or `null` when it may.
 *
 * It costs nothing, which is exactly why it still has to be aimed: it rewrites
 * a record and sends its review back to pending, so a bare `--republish` would
 * quietly withdraw approvals nobody meant to withdraw.
 */
function republishProblem(input: GenerateInput): string | null {
  if (input.regenerate) {
    return "--republish i --regenerate wykluczają się: jedno publikuje zapisaną odpowiedź, drugie kupuje nową";
  }

  if (input.artifacts.length === 0) {
    return "--republish wymaga jawnego celu: --artifact C01[,C02]";
  }

  const frames = input.artifacts.filter((id) => !CLIP_ID.test(id));

  return frames.length === 0
    ? null
    : `--republish "${frames.join(", ")}", dotyczy wyłącznie klipów; klatka wejściowa jest publikowana dokładnie tak, jak narysował ją model, więc nie ma tam czego naprawiać po stronie publikacji`;
}

export async function generateClips(input: GenerateInput): Promise<Result<ClipsReport>> {
  const named = input.artifacts.filter((id) => !isClipArtifact(id));

  if (named.length > 0) {
    return err(
      new Stage7BlockedError([
        `--artifact "${named.join(", ")}", etap 7 kupuje klipy (C01) i klatki wejściowe (entry:C02)`,
        "referencje należą do etapu 5, a klatka otwarcia do etapu 6",
      ])
    );
  }

  if (input.republish) {
    const problem = republishProblem(input);

    if (problem !== null) {
      return err(new Stage7BlockedError([problem]));
    }
  }

  // A new charge names its target. Without a flag the gates decide what runs,
  // and what runs is never something already finished, so a bare
  // `--regenerate` would silently do nothing or, worse, buy the wrong clip.
  if (input.regenerate && input.artifacts.length === 0) {
    return err(
      new Stage7BlockedError([
        "--regenerate wymaga jawnego celu: --artifact C02 albo --artifact entry:C02",
        "nowa płatna próba zawsze dotyczy konkretnego klipu albo konkretnej klatki",
      ])
    );
  }

  const survey = await readStage7Inputs(input);

  if (!survey.ok) {
    return survey;
  }

  const wanted =
    input.artifacts.length > 0 ? input.artifacts : readyTargets(survey.data).map((one) => one.name);
  // Read again with the targets named, so the prompts are composed, and the
  // attachments hashed, in the same pass that is about to send them.
  const stage7 = await readStage7Inputs(input, wanted);

  if (!stage7.ok) {
    return stage7;
  }

  const targets = stage7.data.targets.filter((one) => wanted.includes(one.name));
  const problems = blockers(input, stage7.data, targets);

  if (input.mode === "dry-run") {
    return ok(preview(input, stage7.data, targets, problems));
  }

  if (problems.length > 0) {
    return err(new Stage7BlockedError(problems));
  }

  if (targets.length === 0) {
    return ok(idle(input, stage7.data));
  }

  const lock = await writeNew(
    stage7.data.paths.track.clipsLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(stage7.data.paths.track.clipsLock));
  }

  try {
    return await runAll(input, stage7.data, targets);
  } finally {
    await removeFile(stage7.data.paths.track.clipsLock);
  }
}

/** What one call carried, by path and digest, never the bytes. */
function attachmentsOf(artifact: PlannedArtifact): readonly RecordedFile[] {
  return artifact.attachments
    .filter((one) => one.sha256 !== null)
    .map((one) => ({ path: one.path, sha256: one.sha256 as string }));
}

/** Nothing to buy: everything runnable is done and the rest waits on a human. */
function idle(input: GenerateInput, stage7: Stage7Inputs): ClipsReport {
  const waiting = stage7.targets.filter(
    (one) =>
      stage7.stage.artifacts[one.name]?.status === "completed" &&
      stage7.stage.artifacts[one.name]?.review.status !== "approved"
  );
  const blocked = stage7.targets.filter(
    (one) => one.blockers.length > 0 && stage7.stage.artifacts[one.name] === undefined
  );

  return {
    approved: stage7.gate.length === 0,
    artifacts: [],
    created: [],
    nextStep:
      waiting.length > 0
        ? `oceń i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track} --artifact ${waiting.map((one) => one.name).join(",")}`
        : `etap 7 dla odcinka "${input.episodeId}" na torze ${input.track} jest kompletny, dalej etap 8, montaż`,
    paidImages: 0,
    paidVideos: 0,
    problems: [
      ...(waiting.length > 0
        ? [`czekają na ocenę człowieka: ${waiting.map((one) => one.name).join(", ")}`]
        : []),
      ...blocked.flatMap((one) => one.blockers.map((problem) => `${one.name}: ${problem}`)),
    ],
    ready: waiting.length === 0 && blocked.length === 0,
    size: stage7.plan.size,
    track: input.track,
  };
}

/**
 * `--dry-run`: the full plan, with no network, no secret and no write.
 *
 * It shows every prompt in full and states the bill in both currencies,
 * because on a stage where one command can buy a video the preview's job is to
 * let a person read the text and the price before they agree to either.
 */
function preview(
  input: GenerateInput,
  stage7: Stage7Inputs,
  targets: readonly Stage7Target[],
  problems: readonly string[]
): ClipsReport {
  const artifacts = targets.map((target): ClipOutcome => {
    const record = stage7.stage.artifacts[target.name];
    // A preview answers "what would this command do", so a result the real run
    // would leave alone must not be counted as a purchase here.
    const finished = record?.status === "completed" && !input.regenerate;

    if (finished) {
      return {
        ...base(target),
        note: "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
        prompt: target.artifact.text,
        runId: record?.runId ?? null,
        state: "skipped",
      };
    }

    const blocked = target.blockers.length > 0;

    return {
      ...base(target),
      note: blocked ? target.blockers.join("; ") : "gotowe do płatnego wywołania",
      prompt: target.artifact.text,
      runId: null,
      state: blocked ? "blocked" : "planned",
    };
  });
  const runnable = artifacts.filter((one) => one.state === "planned");

  return {
    approved: stage7.gate.length === 0,
    artifacts,
    created: [],
    nextStep:
      problems.length === 0 && runnable.length > 0
        ? `aimator clip generate ${input.projectId} ${input.episodeId} --track ${input.track}`
        : "usuń powyższe przeszkody przed płatnym wywołaniem",
    paidImages: runnable.filter((one) => one.kind === "entry-frame").length,
    paidVideos: runnable.filter((one) => one.kind === "clip").length,
    problems: [
      ...problems,
      ...artifacts.filter((one) => one.state === "blocked").map((one) => `${one.id}: ${one.note}`),
      "klucze nie były czytane, próba na sucho nie sięga po sekrety; płatne wywołanie ich wymaga",
    ],
    ready: problems.length === 0 && runnable.length > 0,
    size: stage7.plan.size,
    track: input.track,
  };
}

function base(target: Stage7Target): {
  attachments: readonly RecordedFile[];
  id: string;
  kind: "clip" | "entry-frame";
} {
  return {
    attachments: attachmentsOf(target.artifact),
    id: target.name,
    kind: target.kind,
  };
}

async function runAll(
  input: GenerateInput,
  stage7: Stage7Inputs,
  targets: readonly Stage7Target[]
): Promise<Result<ClipsReport>> {
  const artifacts: ClipOutcome[] = [];
  const created: string[] = [];

  for (const target of targets) {
    // Sequential on purpose: each target is its own charge and its own record,
    // and a series that failed halfway has to stay legible.
    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time
    const outcome = await runOne(input, stage7, target);

    if (!outcome.ok) {
      // Whatever already succeeded stays written and reported; the series stops.
      return artifacts.length === 0
        ? outcome
        : err(
            new Stage7BlockedError([
              ...artifacts.map((earlier) => `${earlier.id}: ${earlier.note}`),
              `${target.name}: ${outcome.error.message}`,
              "seria zatrzymana; wcześniejsze wyniki zachowane",
            ])
          );
    }

    artifacts.push(outcome.data.outcome);
    created.push(...outcome.data.created);
  }

  const bought = artifacts.filter((one) => one.state === "published" || one.state === "resumed");
  // What this run did not touch and why. A chain means most of the episode is
  // waiting at any moment, and a report that only spoke about what it bought
  // would leave the next link unexplained.
  const stalled = stage7.targets.filter(
    (one) =>
      one.blockers.length > 0 &&
      !targets.includes(one) &&
      stage7.stage.artifacts[one.name] === undefined
  );

  return ok({
    approved: stage7.gate.length === 0,
    artifacts,
    created,
    nextStep:
      bought.length > 0
        ? `oceń wyniki, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track} --artifact ${bought.map((one) => one.id).join(",")}`
        : `usuń przeszkody i powtórz: aimator clip generate ${input.projectId} ${input.episodeId} --track ${input.track}`,
    paidImages: artifacts.filter((one) => one.state === "published" && one.kind === "entry-frame")
      .length,
    paidVideos: artifacts.filter((one) => one.state === "published" && one.kind === "clip").length,
    problems: [
      ...artifacts.filter((one) => one.state === "blocked").map((one) => `${one.id}: ${one.note}`),
      ...stalled.map((one) => `${one.name}: ${one.blockers.join("; ")}`),
    ],
    ready: bought.length > 0,
    size: stage7.plan.size,
    track: input.track,
  });
}

interface OneResult {
  readonly created: readonly string[];
  readonly outcome: ClipOutcome;
}

async function runOne(
  input: GenerateInput,
  stage7: Stage7Inputs,
  target: Stage7Target
): Promise<Result<OneResult>> {
  if (target.blockers.length > 0) {
    return ok(idleOne(target, target.blockers.join("; "), "blocked", null));
  }

  const record = stage7.stage.artifacts[target.name];

  if (record?.status === "completed" && !(input.regenerate || input.republish)) {
    return ok(
      idleOne(
        target,
        "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
        "skipped",
        record.runId
      )
    );
  }

  if (target.artifact.text === null) {
    return err(
      new Stage7BlockedError([`${target.name}: nie ma czego wysłać, brak promptu z etapu 4`])
    );
  }

  return target.kind === "clip"
    ? await runClip(input, stage7, target, target.artifact.text)
    : await runEntryFrame(input, stage7, target, target.artifact.text);
}

/** The clip itself: one video job, one entry frame in, one clip and its end out. */
async function runClip(
  input: GenerateInput,
  stage7: Stage7Inputs,
  target: Stage7Target,
  prompt: string
): Promise<Result<OneResult>> {
  const video = clipVideo(stage7.paths.track, target.name);
  const [first] = target.artifact.attachments;

  if (!video.ok) {
    return video;
  }

  if (first === undefined || first.bytes === null) {
    return err(
      new Stage7BlockedError([`${target.name}: nie ma klatki, od której klip miałby się zacząć`])
    );
  }

  const attempt = await runVideoStage(
    {
      apiKey: input.videoKey ?? "",
      fetch: input.fetch,
      model: input.videoModel ?? "",
      regenerate: input.regenerate,
      republish: input.republish,
      runs: stage7.paths.track.runs,
      // Passed only when it was given: an absent wait means the real one, and
      // an explicit `undefined` is not the same thing under this tsconfig.
      ...(input.wait === undefined ? {} : { wait: input.wait }),
      workspace: input.workspace,
    },
    {
      aspectRatio: stage7.plan.aspectRatio,
      blocked: (problems) => new Stage7BlockedError(problems),
      endFrameTarget: (format) => clipFrame(stage7.paths.track, target.name, "end", format),
      firstFrame: attach(first.id, first.bytes),
      inputs: target.artifact.inputs,
      key: target.name,
      prompt,
      promptVersion: stage7.plan.promptVersion,
      seconds: target.seconds ?? 0,
      stage: STAGE,
      stagePath: stage7.paths.track.clipsStage,
      target: video.data,
    }
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    created: attempt.data.created,
    outcome: {
      ...base(target),
      note: attempt.data.note,
      prompt: null,
      runId: attempt.data.runId,
      state: attempt.data.state,
    },
  });
}

/** An entry frame is an image, drawn exactly as the opening frame was. */
async function runEntryFrame(
  input: GenerateInput,
  stage7: Stage7Inputs,
  target: Stage7Target,
  prompt: string
): Promise<Result<OneResult>> {
  const file = clipFrame(stage7.paths.track, target.artifact.id, "entry");

  if (!file.ok) {
    return file;
  }

  const attempt = await runImageStage(
    {
      apiKey: input.imageKey ?? "",
      fetch: input.fetch,
      model: input.imageModel ?? "",
      regenerate: input.regenerate,
      runs: stage7.paths.track.runs,
      track: input.track,
      workspace: input.workspace,
    },
    {
      attachments: target.artifact.attachments
        .filter((one) => one.bytes !== null)
        .map((one) => attach(one.id, one.bytes as Buffer)),
      background: BACKGROUND,
      blocked: (problems) => new Stage7BlockedError(problems),
      inputs: target.artifact.inputs,
      key: target.name,
      prompt,
      promptVersion: stage7.plan.promptVersion,
      size: stage7.plan.size,
      stage: STAGE,
      stagePath: stage7.paths.track.clipsStage,
      target: file.data,
    }
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    created: attempt.data.created,
    outcome: {
      ...base(target),
      note: attempt.data.note,
      prompt: null,
      runId: attempt.data.runId,
      state: attempt.data.state,
    },
  });
}

/** A target this invocation did not buy, and why. Nothing was written. */
function idleOne(
  target: Stage7Target,
  note: string,
  state: ClipOutcome["state"],
  runId: string | null
): OneResult {
  return {
    created: [],
    outcome: { ...base(target), note, prompt: null, runId, state },
  };
}
