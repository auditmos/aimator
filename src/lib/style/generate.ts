import {
  nowIso,
  removeFile,
  type StageFile,
  serialize,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { type ImageVerdict, runImageStage } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";
import { type ImageTrack, styleImage } from "../workspace.js";
import {
  gate,
  readStyleInputs,
  STAGE,
  StyleBlockedError,
  type StyleInputs,
  type StyleScope,
} from "./plan.js";
import { buildPrompt, PROMPT_VERSION } from "./prompt.js";

/**
 * Internal to the style module: the command that spends money.
 *
 * One call buys one image, and a run buys every frame of the decided count that
 * does not exist yet on this track, in order, stopping at the first failure
 * with what came before kept. The number of calls is said before any is made,
 * in a preview that never reads a key and says so instead of claiming it is
 * missing.
 */

/** What happened to one style frame, in the words a person reads. */
export interface StyleOutcome {
  readonly id: string;
  readonly note: string;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly runId: string | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
  readonly verdict: ImageVerdict | null;
}

export interface StyleReport {
  /** Whether stage 0 is accepted for this project. */
  readonly approved: boolean;
  readonly artifacts: readonly StyleOutcome[];
  readonly created: readonly string[];
  readonly nextStep: string;
  /** How many billed image calls this invocation is about, said before paying. */
  readonly paidCalls: number;
  readonly problems: readonly string[];
  readonly ready: boolean;
  /** The film frame the style frames are drawn in. */
  readonly size: string;
  readonly track: ImageTrack;
}

type GenerateInput = StyleScope & {
  readonly apiKey: string | null;
  /** Narrows the run; empty means every frame not drawn yet. */
  readonly artifacts: readonly string[];
  readonly fetch: typeof fetch;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly regenerate: boolean;
};

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

/** Why a paid call may not happen at all. Empty means it may. */
function blockers(input: GenerateInput, inputs: StyleInputs): readonly string[] {
  const problems = [...gate(input, inputs)];

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

/** The exact prompt for one frame of the set. */
function promptOf(inputs: StyleInputs, id: string): string {
  const { aspectRatio, cast, rules } = inputs.stage0;

  return buildPrompt({
    aspectRatio: aspectRatio ?? "",
    cast: cast.map((member) => member.name),
    count: inputs.ids.length,
    index: inputs.ids.indexOf(id) + 1,
    rules,
    size: inputs.size,
  });
}

export async function generateStyle(input: GenerateInput): Promise<Result<StyleReport>> {
  // A new charge names its target: a bare `--regenerate` would hit whichever
  // image the tool picked, and a second payment needs an addressee.
  if (input.regenerate && input.artifacts.length === 0) {
    return err(
      new StyleBlockedError([
        "--regenerate wymaga jawnego celu: --artifact S01[,S02]",
        "nowa płatna próba zawsze dotyczy konkretnego obrazu",
      ])
    );
  }

  const inputs = await readStyleInputs(input);

  if (!inputs.ok) {
    return inputs;
  }

  const unknown = input.artifacts.filter((id) => !inputs.data.ids.includes(id));

  if (unknown.length > 0) {
    return err(
      new StyleBlockedError([
        `--artifact "${unknown.join(", ")}", projekt generuje: ${inputs.data.ids.join(", ")}`,
      ])
    );
  }

  const targets =
    input.artifacts.length > 0
      ? input.artifacts
      : inputs.data.ids.filter((id) => inputs.data.stage.artifacts[id]?.status !== "completed");
  const problems = blockers(input, inputs.data);

  if (input.mode === "dry-run") {
    return ok(preview(input, inputs.data, targets, problems));
  }

  if (problems.length > 0) {
    return err(new StyleBlockedError(problems));
  }

  if (targets.length === 0) {
    return ok(idle(input, inputs.data));
  }

  const { lock } = inputs.data.paths;
  const held = await writeNew(lock, serialize({ pid: process.pid, startedAt: nowIso() }));

  if (!held.ok) {
    return err(new LockError(lock));
  }

  try {
    return await runAll(input, inputs.data, targets);
  } finally {
    await removeFile(lock);
  }
}

/** The command that accepts what is waiting, or `null` when nothing is. */
function approveStep(input: StyleScope, waiting: readonly string[]): string | null {
  return waiting.length === 0
    ? null
    : `oceń i zatwierdź: aimator approve ${input.projectId} --stage style --track ${input.track} --artifact ${waiting.join(",")}`;
}

/** Nothing to draw: every frame exists, and what is left waits on a human. */
function idle(input: GenerateInput, inputs: StyleInputs): StyleReport {
  const waiting = inputs.ids.filter(
    (id) =>
      inputs.stage.artifacts[id]?.status === "completed" &&
      inputs.stage.artifacts[id]?.review.status !== "approved"
  );

  return {
    approved: inputs.stage0.approved,
    artifacts: [],
    created: [],
    nextStep:
      approveStep(input, waiting) ??
      `obrazy stylu projektu "${input.projectId}" na torze ${input.track} są kompletne`,
    paidCalls: 0,
    problems: waiting.length > 0 ? [`czekają na ocenę człowieka: ${waiting.join(", ")}`] : [],
    ready: waiting.length === 0,
    size: inputs.size,
    track: input.track,
  };
}

/**
 * `--dry-run`: every prompt in full, the number of paid calls, no network, no
 * secret and no write. An obstacle blocks every frame, so the bill is zero.
 */
function preview(
  input: GenerateInput,
  inputs: StyleInputs,
  targets: readonly string[],
  problems: readonly string[]
): StyleReport {
  const artifacts = targets.map((id): StyleOutcome => {
    const record = inputs.stage.artifacts[id];
    const finished = record?.status === "completed" && !input.regenerate;
    let state: StyleOutcome["state"] = "planned";
    let note = "gotowe do płatnego wywołania";

    if (finished) {
      state = "skipped";
      note = "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate";
    } else if (problems.length > 0) {
      state = "blocked";
      note = "zablokowany przez przeszkody poniżej";
    }

    return {
      id,
      note,
      prompt: promptOf(inputs, id),
      runId: finished ? (record?.runId ?? null) : null,
      state,
      verdict: null,
    };
  });
  const runnable = artifacts.filter((one) => one.state === "planned");

  return {
    approved: inputs.stage0.approved,
    artifacts,
    created: [],
    nextStep:
      runnable.length > 0
        ? `aimator style generate ${input.projectId} --track ${input.track}`
        : "usuń przeszkody przed płatnym wywołaniem",
    paidCalls: runnable.length,
    problems: [
      ...problems,
      `${KEY_NAME[input.track]} nie był czytany, próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga`,
    ],
    ready: runnable.length > 0,
    size: inputs.size,
    track: input.track,
  };
}

async function runAll(
  input: GenerateInput,
  inputs: StyleInputs,
  targets: readonly string[]
): Promise<Result<StyleReport>> {
  const artifacts: StyleOutcome[] = [];
  const created: string[] = [];
  let { stage } = inputs;

  for (const id of targets) {
    // Sequential on purpose: each frame is its own charge and its own record,
    // and a series that failed halfway has to stay legible.
    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time
    const outcome = await runOne(input, { ...inputs, stage }, id);

    if (!outcome.ok) {
      // Whatever already succeeded stays written and reported; the series stops.
      return artifacts.length === 0
        ? outcome
        : err(
            new StyleBlockedError([
              ...artifacts.map((earlier) => `${earlier.id}: ${earlier.note}`),
              `${id}: ${outcome.error.message}`,
              "seria zatrzymana; wcześniejsze wyniki zachowane",
            ])
          );
    }

    artifacts.push(outcome.data.outcome);
    created.push(...outcome.data.created);
    ({ stage } = outcome.data);
  }

  const drawn = artifacts.filter((one) => one.state === "published" || one.state === "resumed");

  return ok({
    approved: inputs.stage0.approved,
    artifacts,
    created,
    nextStep:
      approveStep(
        input,
        drawn.map((one) => one.id)
      ) ?? `aimator style generate ${input.projectId} --track ${input.track}`,
    paidCalls: artifacts.filter((one) => one.state === "published").length,
    problems: [],
    ready: drawn.length > 0,
    size: inputs.size,
    track: input.track,
  });
}

interface OneResult {
  readonly created: readonly string[];
  readonly outcome: StyleOutcome;
  readonly stage: StageFile;
}

async function runOne(
  input: GenerateInput,
  inputs: StyleInputs,
  id: string
): Promise<Result<OneResult>> {
  const record = inputs.stage.artifacts[id];

  if (record?.status === "completed" && !input.regenerate) {
    return ok({
      created: [],
      outcome: {
        id,
        note: "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
        prompt: null,
        runId: record.runId,
        state: "skipped",
        verdict: null,
      },
      stage: inputs.stage,
    });
  }

  const target = styleImage(inputs.paths, id);

  if (!target.ok) {
    return target;
  }

  const attempt = await runImageStage(
    {
      apiKey: input.apiKey ?? "",
      fetch: input.fetch,
      instruction: null,
      model: input.model ?? "",
      regenerate: input.regenerate,
      runs: inputs.paths.runs,
      track: input.track,
      workspace: input.workspace,
    },
    {
      // Drawn from the rules alone: a style frame has nothing to edit, and an
      // attachment would be content, which is the one thing it must not carry.
      attachments: [],
      background: "opaque",
      blocked: (problems) => new StyleBlockedError(problems),
      inputs: inputs.stage0.inputs,
      key: id,
      prompt: promptOf(inputs, id),
      promptVersion: PROMPT_VERSION,
      size: inputs.size,
      stage: STAGE,
      stagePath: inputs.paths.stage,
      target: target.data,
    }
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    created: attempt.data.created,
    outcome: {
      id,
      note: attempt.data.note,
      prompt: null,
      runId: attempt.data.runId,
      state: attempt.data.state,
      verdict: attempt.data.verdict,
    },
    stage: attempt.data.stage,
  });
}
