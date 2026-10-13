import {
  applyWrites,
  approveArtifacts,
  type RecordedFile,
  readDigest,
  serialize,
  type WriteMode,
  withInputs,
} from "../artifact/index.js";
import { type ImageVerdict, validateImage } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";
import { type ImageTrack, styleImage, workspacePath } from "../workspace.js";
import { readStyleInputs, type StyleInputs, type StyleScope } from "./plan.js";
import { STYLE_FRAME_ID } from "./prompt.js";

/**
 * Internal to the style module: verification, and the approval that sits on
 * top of it but is never implied by it.
 *
 * Each style frame is its own judgement, because every film frame on this
 * track will carry it: an approval that spilled across the set would put an
 * image nobody looked at into every request that follows.
 */

export interface StyleState {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this run used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
  readonly verdict: ImageVerdict | null;
}

export interface StyleStatus {
  /** True once every frame of the decided count carries a still-valid approval. */
  readonly approved: boolean;
  readonly artifacts: readonly StyleState[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

type ApproveScope = StyleScope & {
  /** Which frames to accept. Empty is refused rather than read as "all". */
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class StyleStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "StyleStateError";
    this.problems = problems;
  }
}

interface Inspection {
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  readonly inputs: StyleInputs;
  readonly status: StyleStatus;
}

/** Which recorded inputs no longer match the bytes on disk, each read once. */
async function changedInputs(
  input: StyleScope,
  recorded: readonly RecordedFile[],
  seen: Map<string, string | null>
): Promise<readonly string[]> {
  const changed: string[] = [];

  for (const entry of recorded) {
    if (!seen.has(entry.path)) {
      // biome-ignore lint/performance/noAwaitInLoops: each input read once per check
      const digest = await readDigest(workspacePath(input.workspace, entry.path));

      seen.set(entry.path, digest.ok ? digest.data.sha256 : null);
    }

    if (seen.get(entry.path) !== entry.sha256) {
      changed.push(entry.path);
    }
  }

  return changed;
}

async function inspectOne(
  input: StyleScope,
  inputs: StyleInputs,
  id: string,
  seen: Map<string, string | null>
): Promise<{ blocking: readonly string[]; status: StyleState }> {
  const record = inputs.stage.artifacts[id];
  const label = `${id} (${input.track})`;
  const absent = { approved: false, id, inputsChanged: [], verdict: null } as const;

  if (record === undefined) {
    return { blocking: [], status: { ...absent, note: "jeszcze nie powstał", state: "absent" } };
  }

  if (record.status === "submitted") {
    return {
      blocking: [
        `${label}: próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca, mogła zostać rozliczona; powtórz polecenie, żeby dokończyć ją z zapisanej odpowiedzi, albo użyj --regenerate`,
      ],
      status: { ...absent, note: `próba ${record.runId} nieukończona`, state: "submitted" },
    };
  }

  const blocking: string[] = [];
  const path = styleImage(inputs.paths, id);
  const [output] = record.outputs;
  const digest = path.ok ? await readDigest(path.data) : null;
  let verdict: ImageVerdict | null = null;

  if (output === undefined) {
    blocking.push(`${label}: rekord ukończony, ale nie wskazuje żadnego pliku`);
  } else if (digest === null || !digest.ok) {
    blocking.push(`${label}: brakuje ${output.path}`);
  } else if (digest.data.sha256 === output.sha256) {
    const checked = validateImage(digest.data.bytes, inputs.size);

    if (checked.ok) {
      verdict = checked.data;
    } else {
      blocking.push(`${label}: ${checked.error.message}`);
    }
  } else {
    blocking.push(
      `${label}: ${output.path} nie zgadza się z zapisanym hashem, wynik został zmieniony poza narzędziem`
    );
  }

  const inputsChanged = await changedInputs(input, record.inputs, seen);

  return {
    blocking,
    status: {
      // Approval is bound to bytes: a recorded "approved" that no longer
      // verifies is not an approval; it is a stale claim.
      approved:
        record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0,
      id,
      inputsChanged,
      note:
        verdict === null ? "nie udało się odczytać obrazu" : `${verdict.width}x${verdict.height}`,
      state: "completed",
      verdict,
    },
  };
}

async function inspect(input: StyleScope): Promise<Result<Inspection>> {
  const inputs = await readStyleInputs(input);

  if (!inputs.ok) {
    return inputs;
  }

  const blocking: string[] = [];
  const problems: string[] = [];
  const artifacts: StyleState[] = [];
  const seen = new Map<string, string | null>();

  for (const id of inputs.data.ids) {
    // biome-ignore lint/performance/noAwaitInLoops: one frame at a time, in order
    const one = await inspectOne(input, inputs.data, id, seen);

    artifacts.push(one.status);
    blocking.push(...one.blocking);
    problems.push(...one.blocking);

    // Drift revokes the approval as loudly as a broken image, but it is not
    // one: the frame is intact, it was drawn from rules that have changed since,
    // and looking at it again beside them is exactly what an approval is.
    for (const path of one.status.inputsChanged) {
      problems.push(
        `${path}: zmienił się od czasu narysowania ${id}, obejrzyj obraz jeszcze raz i zatwierdź ponownie albo kup go ponownie: aimator style generate ${input.projectId} --track ${input.track} --regenerate --artifact ${id}`
      );
    }
  }

  return ok({
    blocking,
    inputs: inputs.data,
    status: {
      approved: artifacts.every((one) => one.approved),
      artifacts,
      nextStep: nextStepOf(input, artifacts),
      problems,
      track: input.track,
    },
  });
}

function nextStepOf(input: StyleScope, artifacts: readonly StyleState[]): string {
  const waiting = artifacts.filter((one) => one.state === "completed" && !one.approved);

  if (waiting.length > 0) {
    return `oceń i zatwierdź: aimator approve ${input.projectId} --stage style --track ${input.track} --artifact ${waiting.map((one) => one.id).join(",")}`;
  }

  return artifacts.some((one) => one.state === "absent")
    ? `aimator style generate ${input.projectId} --track ${input.track}`
    : `obrazy stylu projektu "${input.projectId}" na torze ${input.track} są kompletne`;
}

/** Reads and reports. Writes nothing; that is what makes it safe to run. */
export async function checkStyle(input: StyleScope): Promise<Result<StyleStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted these frames, bound to their current bytes and
 * to the inputs as they stand now. It names the frames explicitly and refuses
 * without them, and it refuses over anything that does not verify.
 */
export async function approveStyle(input: ApproveScope): Promise<Result<StyleStatus>> {
  if (input.artifacts.length === 0) {
    return err(new StyleStateError("wskaż, co zatwierdzasz: --artifact S01[,S02]"));
  }

  const malformed = input.artifacts.filter((id) => !STYLE_FRAME_ID.test(id));

  if (malformed.length > 0) {
    return err(new StyleStateError(`--artifact "${malformed.join(", ")}", oczekiwano formy S01`));
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, status } = inspection.data;
  const problems: string[] = [];

  for (const id of input.artifacts) {
    const entry = status.artifacts.find((one) => one.id === id);

    if (entry === undefined || entry.state !== "completed") {
      problems.push(`${id}: nie ma czego zatwierdzić (${entry?.state ?? "brak"})`);
    }
  }

  problems.push(
    ...blocking.filter((problem) => input.artifacts.some((id) => problem.startsWith(`${id} (`)))
  );

  if (problems.length > 0) {
    return err(
      new StyleStateError("nie akceptuje się tego, co nie przechodzi walidacji", problems)
    );
  }

  let rebound = inputs.stage;

  for (const id of input.artifacts) {
    rebound = withInputs(rebound, id, inputs.stage0.inputs);
  }

  const approved = approveArtifacts(rebound, input.artifacts, {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: inputs.paths.stage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  const settled = status.artifacts.map((one) =>
    input.artifacts.includes(one.id) ? { ...one, approved: true, inputsChanged: [] } : one
  );

  return ok({
    ...status,
    approved: settled.every((one) => one.approved),
    artifacts: settled,
    nextStep: nextStepOf(input, settled),
    problems: status.problems.filter(
      (problem) => !input.artifacts.some((id) => problem.includes(`narysowania ${id},`))
    ),
  });
}
