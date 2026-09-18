import {
  applyWrites,
  approveArtifacts,
  type RecordedFile,
  readDigest,
  type StageFile,
  serialize,
  type WriteMode,
} from "../artifact/index.js";
import { readStage0Character, type Stage0Character } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type CharacterTrackPaths,
  characterPaths,
  characterTrackPaths,
  type ImageTrack,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { sizeOf } from "./client.js";
import { accepted, nextGroup, outputPath, readStage, sequenceGate } from "./generate.js";
import { CHARACTER_ARTIFACTS, type CharacterArtifact } from "./prompt.js";
import { type ImageVerdict, validateImage } from "./validate.js";

/**
 * Internal to the character module: verification, and the approval that sits on
 * top of it but is never implied by it.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance — bound to the digest of one
 * image at a time, because the ten results are ten separate judgements and the
 * next step's gate reads them separately.
 */

export interface ArtifactStatus {
  readonly approved: boolean;
  readonly artifact: CharacterArtifact;
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
  readonly verdict: ImageVerdict | null;
}

export interface CharacterStatus {
  /** True once every one of the ten carries an explicit, still-valid approval. */
  readonly approved: boolean;
  readonly artifacts: readonly ArtifactStatus[];
  /** Stage-0 artifacts whose bytes no longer match what a run consumed. */
  readonly inputsChanged: readonly string[];
  readonly name: string;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

interface TrackScope {
  readonly characterId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

type ApproveScope = TrackScope & {
  /** Which of the ten to accept. Empty is refused rather than read as "all". */
  readonly artifacts: readonly CharacterArtifact[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class CharacterStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "CharacterStateError";
    this.problems = problems;
  }
}

interface Inspection {
  readonly paths: CharacterTrackPaths;
  readonly stage: StageFile;
  readonly status: CharacterStatus;
}

function changedInputs(
  recorded: readonly RecordedFile[],
  current: readonly RecordedFile[]
): readonly string[] {
  return recorded
    .filter(
      (entry) => !current.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
    )
    .map((entry) => entry.path);
}

async function inspect(input: TrackScope): Promise<Result<Inspection>> {
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
  const problems: string[] = [];
  const changed = new Set<string>();
  const artifacts: ArtifactStatus[] = [];

  for (const artifact of CHARACTER_ARTIFACTS) {
    // biome-ignore lint/performance/noAwaitInLoops: ten reads, reported in order
    const status = await inspectOne(input, { paths, stage, stage0: stage0.data }, artifact);

    artifacts.push(status.status);
    problems.push(...status.problems);

    for (const path of status.changed) {
      changed.add(path);
    }
  }

  return ok({
    paths,
    stage,
    status: {
      approved: artifacts.every((entry) => entry.approved),
      artifacts,
      inputsChanged: [...changed],
      name: stage0.data.name,
      nextStep: nextStepOf(input, stage),
      problems,
      track: input.track,
    },
  });
}

function nextStepOf(input: TrackScope, stage: StageFile): string {
  const pending = CHARACTER_ARTIFACTS.filter(
    (artifact) => stage.artifacts[artifact]?.status === "completed" && !accepted(stage, artifact)
  );

  if (pending.length > 0) {
    return `oceń i zatwierdź: aimator approve ${input.projectId} ${input.characterId} --stage character --track ${input.track} --artifact ${pending.join(",")}`;
  }

  const next = nextGroup(stage);

  return next.length > 0
    ? `aimator character generate ${input.projectId} ${input.characterId} --track ${input.track}`
    : `etap 2 dla "${input.characterId}" na torze ${input.track} jest kompletny`;
}

interface OneStatus {
  readonly changed: readonly string[];
  readonly problems: readonly string[];
  readonly status: ArtifactStatus;
}

async function inspectOne(
  input: TrackScope,
  scope: { paths: CharacterTrackPaths; stage: StageFile; stage0: Stage0Character },
  artifact: CharacterArtifact
): Promise<OneStatus> {
  const record = scope.stage.artifacts[artifact];
  const label = `${artifact} (${input.track})`;

  if (record === undefined) {
    const gate = sequenceGate(scope.stage, artifact);

    return {
      changed: [],
      problems: [],
      status: {
        approved: false,
        artifact,
        note: gate.length > 0 ? gate.join("; ") : "jeszcze nie powstał",
        state: "absent",
        verdict: null,
      },
    };
  }

  if (record.status === "submitted") {
    return {
      changed: [],
      problems: [
        `${label}: próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca — mogła zostać rozliczona; powtórz polecenie, żeby dokończyć ją z zapisanej odpowiedzi, albo użyj --regenerate`,
      ],
      status: {
        approved: false,
        artifact,
        note: `próba ${record.runId} nieukończona`,
        state: "submitted",
        verdict: null,
      },
    };
  }

  const problems: string[] = [];
  const [output] = record.outputs;
  const digest = output === undefined ? null : await readDigest(imagePathOf(scope.paths, artifact));
  let verdict: ImageVerdict | null = null;

  if (output === undefined) {
    problems.push(`${label}: rekord ukończony, ale nie wskazuje żadnego pliku`);
  } else if (digest === null || !digest.ok) {
    problems.push(`${label}: brakuje ${output.path}`);
  } else if (digest.data.sha256 === output.sha256) {
    const checked = validateImage(digest.data.bytes, sizeOf(artifact).size);

    if (checked.ok) {
      verdict = checked.data;
    } else {
      problems.push(`${label}: ${checked.error.message}`);
    }
  } else {
    problems.push(
      `${label}: ${output.path} nie zgadza się z zapisanym hashem — wynik został zmieniony poza narzędziem`
    );
  }

  const changed = changedInputs(record.inputs, scope.stage0.inputs);

  for (const path of changed) {
    problems.push(
      `${path}: zmienił się od czasu narysowania ${artifact} — wynik opisuje inne wejście`
    );
  }

  return {
    changed,
    problems,
    status: {
      // Approval is bound to bytes: a recorded "approved" that no longer
      // verifies is not an approval, it is a stale claim.
      approved: record.review.status === "approved" && problems.length === 0,
      artifact,
      note: describeAlpha(artifact, verdict),
      state: "completed",
      verdict,
    },
  };
}

function describeAlpha(artifact: CharacterArtifact, verdict: ImageVerdict | null): string {
  if (verdict === null) {
    return "nie udało się odczytać obrazu";
  }

  const wantsAlpha = sizeOf(artifact).background === "transparent";

  return wantsAlpha && !verdict.alpha
    ? `${verdict.width}x${verdict.height}, bez kanału alfa — oceń, czy nadaje się do kompozytowania`
    : `${verdict.width}x${verdict.height}`;
}

/** Reads and reports. Writes nothing — that is what makes it safe to run. */
export async function checkCharacter(input: TrackScope): Promise<Result<CharacterStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted these images, bound to their current bytes.
 *
 * It refuses over anything that does not verify, and it names the artifacts
 * explicitly. There is no "approve everything" here on purpose: accepting the
 * card is what lets eight paid calls start, so it has to be a thing somebody
 * typed rather than a side effect of accepting something else.
 */
export async function approveCharacter(input: ApproveScope): Promise<Result<CharacterStatus>> {
  if (input.artifacts.length === 0) {
    return err(
      new CharacterStateError(`wskaż, co zatwierdzasz: --artifact ${CHARACTER_ARTIFACTS.join("|")}`)
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { paths, stage, status } = inspection.data;
  const problems: string[] = [];

  for (const artifact of input.artifacts) {
    const entry = status.artifacts.find((item) => item.artifact === artifact);

    if (entry === undefined || entry.state !== "completed") {
      problems.push(`${artifact}: nie ma czego zatwierdzić (${entry?.state ?? "brak"})`);
    }
  }

  problems.push(
    ...status.problems.filter((problem) =>
      input.artifacts.some((artifact) => problem.startsWith(`${artifact} (`))
    )
  );

  if (problems.length > 0) {
    return err(
      new CharacterStateError("nie akceptuje się tego, co nie przechodzi walidacji", problems)
    );
  }

  const approved = approveArtifacts(stage, input.artifacts, {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: paths.stage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  return ok({
    ...status,
    artifacts: status.artifacts.map((entry) =>
      input.artifacts.includes(entry.artifact) ? { ...entry, approved: true } : entry
    ),
    nextStep: nextStepOf(input, approved),
  });
}

/** Where one artifact's image lives. The path builder owns the shape; this
 * only chooses which of the three it is. */
function imagePathOf(paths: CharacterTrackPaths, artifact: CharacterArtifact): string {
  const path = outputPath(paths, artifact);

  return path.ok ? path.data : paths.root;
}
