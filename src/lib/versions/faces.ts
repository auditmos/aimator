import {
  applyWrites,
  modelProducer,
  newRecord,
  type RecordedFile,
  serialize,
  sha256Of,
  toWorkspacePath,
  type WriteMode,
  type WriteOp,
} from "../artifact/index.js";
import type { HostingVariables } from "../hosting.js";
import { err, ok, type Result } from "../result.js";
import { identifyFaces } from "../video-model/index.js";
import { faceImage, versionFaces } from "../workspace.js";
import {
  bindCommand,
  facesKey,
  holdingLock,
  readClipFaces,
  readSourceClip,
  readStage12,
  type Stage12,
  Stage12BlockedError,
  type Stage12Scope,
  untargeted,
} from "./plan.js";

/**
 * Internal to the versions module: the faces in one clip, and who they are.
 *
 * Finding them is paid; saying who they are is a person's decision, written
 * down per clip and never inferred, even when the clip shows a single face.
 */

type FindInput = Stage12Scope & {
  readonly apiKey: string | null;
  /** The clip, `C01`: one paid call finds the faces in exactly one. */
  readonly artifact: string;
  readonly fetch: typeof fetch;
  readonly hosting: HostingVariables;
  readonly mode: WriteMode;
  /** Injected so a test can cross Kling's thirty days; the default is now. */
  readonly now?: () => Date;
  readonly regenerate: boolean;
};

/** One face as a person sees it before binding it: when it is on screen, and its picture. */
interface FaceOutcome {
  readonly end: number;
  readonly id: string;
  /** The picture, workspace-relative, or null when the provider's did not arrive. */
  readonly image: string | null;
  readonly start: number;
}

export interface FacesReport {
  readonly clip: string;
  readonly created: readonly string[];
  readonly faces: readonly FaceOutcome[];
  readonly nextStep: string;
  readonly notices: readonly string[];
  /** Face calls made, or in a dry run the ones the command would make. */
  readonly paidCalls: number;
  readonly problems: readonly string[];
}

/** Why this clip's faces may not be bought, beyond the stage's own gate. */
function obstacles(input: FindInput, stage12: Stage12, clip: readonly string[]): string[] {
  const { artifact } = input;
  const existing = stage12.stage.artifacts[facesKey(artifact)];
  const problems = [...stage12.gate, ...untargeted(stage12, artifact), ...clip];

  if (existing !== undefined && !input.regenerate) {
    problems.push(
      `${artifact}: twarze są już rozpoznane (próba ${existing.runId}), nowe płatne rozpoznanie zaczyna wyłącznie --regenerate`
    );
  }

  if (input.mode === "apply" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak klucza KLING_API_KEY, rozpoznanie twarzy jest płatnym wywołaniem Kling");
  }

  return problems;
}

/**
 * Finds the faces in one accepted clip, for one paid call, and keeps the
 * answer: the session a lip-sync job is addressed by, each face's interval,
 * and each face's picture, which is what a person binds by.
 */
export async function findFaces(input: FindInput): Promise<Result<FacesReport>> {
  const stage12 = await readStage12(input);

  if (!stage12.ok) {
    return stage12;
  }

  const source = await readSourceClip(input, stage12.data, input.artifact);

  if (!source.ok) {
    return source;
  }

  const target = stage12.data.targets.find((one) => one.id === input.artifact);
  const problems = obstacles(input, stage12.data, source.data.problems);
  const speakers = target?.speakers ?? [];
  const report = {
    clip: input.artifact,
    created: [],
    faces: [],
    nextStep:
      problems[0] ??
      `aimator versions faces ${input.projectId} ${input.episodeId} --track ${input.track} --artifact ${input.artifact}`,
    notices: stage12.data.notices,
    problems,
  };

  if (input.mode === "dry-run") {
    return ok({ ...report, paidCalls: problems.length === 0 ? 1 : 0 });
  }

  if (problems.length > 0 || source.data.recorded === null) {
    return err(new Stage12BlockedError(problems));
  }

  const { track } = stage12.data.paths;
  const clip = source.data.recorded;

  return await holdingLock(track.versionsLock, async () => {
    const found = await identifyFaces(
      {
        apiKey: input.apiKey ?? "",
        fetch: input.fetch,
        hosting: input.hosting,
        ...(input.now === undefined ? {} : { now: input.now }),
        runs: track.runs,
        workspace: input.workspace,
      },
      {
        blocked: (blocked) => new Stage12BlockedError(blocked),
        path: source.data.path,
        record: source.data.record,
      }
    );

    if (!found.ok) {
      return found;
    }

    const written = await publish(input, stage12.data, clip, found.data);

    return written.ok
      ? ok({
          ...report,
          created: written.data.created,
          faces: written.data.faces,
          nextStep: bindCommand(input, input.artifact, speakers),
          notices: [...report.notices, ...found.data.notices],
          paidCalls: 1,
        })
      : written;
  });
}

type Identified = Extract<Awaited<ReturnType<typeof identifyFaces>>, { ok: true }>["data"];

/** The answer, kept: each picture, `faces.json`, and the record that says what made them. */
async function publish(
  input: FindInput,
  stage12: Stage12,
  clip: RecordedFile,
  found: Identified
): Promise<
  Result<{ readonly created: readonly string[]; readonly faces: readonly FaceOutcome[] }>
> {
  const { track } = stage12.paths;
  const paths = versionFaces(track, input.artifact);

  if (!paths.ok) {
    return paths;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const writes: WriteOp[] = [];
  const outputs: RecordedFile[] = [];
  const faces: { end: number; id: string; image: RecordedFile | null; start: number }[] = [];

  for (const face of found.faces) {
    const target =
      face.picture === null ? null : faceImage(track, input.artifact, face.id, face.picture.format);

    if (target !== null && !target.ok) {
      return target;
    }

    const image =
      target === null || face.picture === null
        ? null
        : { path: relative(target.data), sha256: sha256Of(face.picture.bytes) };

    if (image !== null && target !== null && face.picture !== null) {
      writes.push({ bytes: face.picture.bytes, kind: "bytes", to: target.data });
      outputs.push(image);
    }

    faces.push({ end: face.end, id: face.id, image, start: face.start });
  }

  const json = serialize({
    clip,
    faces,
    runId: found.runId,
    sessionId: found.sessionId,
    source: found.source,
  });

  writes.push({ kind: "text", text: json, to: paths.data.faces });
  outputs.unshift({ path: relative(paths.data.faces), sha256: sha256Of(Buffer.from(json)) });

  const stage = {
    ...stage12.stage,
    artifacts: {
      ...stage12.stage.artifacts,
      [facesKey(input.artifact)]: newRecord({
        inputs: [clip],
        outputs,
        producer: modelProducer({
          endpoint: found.endpoint,
          model: found.model,
          promptVersion: null,
        }),
        runId: found.runId,
      }),
    },
  };

  writes.push({ kind: "text", text: serialize(stage), to: track.versionsStage });

  const applied = await applyWrites(writes, "apply");

  return applied.ok
    ? ok({
        created: outputs.map((one) => one.path),
        faces: faces.map((one) => ({ ...one, image: one.image?.path ?? null })),
      })
    : applied;
}

type BindInput = Stage12Scope & {
  readonly artifact: string;
  /** Face id → cast id, exactly as the person typed it. */
  readonly faces: Readonly<Record<string, string>>;
  readonly mode: WriteMode;
};

export interface BindingReport {
  readonly clip: string;
  readonly created: readonly string[];
  readonly faces: Readonly<Record<string, string>>;
  readonly nextStep: string;
  /** What the binding does not cover yet: a speaker with no face. */
  readonly notices: readonly string[];
}

/** Why this binding may not be written: a face nobody found, a character nobody cast. */
function bindingProblems(
  input: BindInput,
  stage12: Stage12,
  found: readonly { readonly id: string }[]
): readonly string[] {
  const entries = Object.entries(input.faces);
  const ids = found.map((face) => face.id);
  const problems: string[] = [];

  if (entries.length === 0) {
    problems.push(
      "--face jest wymagane: <twarz>=<postać>[,<twarz>=<postać>], przypisanie zawsze jest jawne, także przy jednej twarzy"
    );
  }

  for (const [face, cast] of entries) {
    if (!ids.includes(face)) {
      problems.push(
        `${input.artifact}: rozpoznanie nie znalazło twarzy ${face}, są: ${ids.join(", ") || "żadne"}`
      );
    }

    if (!stage12.cast.includes(cast)) {
      problems.push(`"${cast}" nie należy do obsady, obsada: ${stage12.cast.join(", ")}`);
    }
  }

  const casts = entries.map(([, cast]) => cast);
  const twice = casts.filter((cast, index) => casts.indexOf(cast) !== index);

  problems.push(
    ...[...new Set(twice)].map(
      (cast) => `${cast} ma przypisane dwie twarze, a lip-sync porusza jedną twarz postaci w klipie`
    )
  );

  return problems;
}

/**
 * Writes down who each face in one clip is, as a person said it, beside the
 * faces it was said of. Nothing is inferred, not even with a single face: the
 * stage refuses rather than guesses, which is rule 7.
 */
export async function bindFaces(input: BindInput): Promise<Result<BindingReport>> {
  const stage12 = await readStage12(input);

  if (!stage12.ok) {
    return stage12;
  }

  const target = stage12.data.targets.find((one) => one.id === input.artifact);

  if (target === undefined) {
    return err(
      new Stage12BlockedError([...stage12.data.gate, ...untargeted(stage12.data, input.artifact)])
    );
  }

  const faces = await readClipFaces(input, stage12.data, target, null);

  if (!faces.ok) {
    return faces;
  }

  const { found, foundFile } = faces.data;

  if (found === null || foundFile === null) {
    return err(new Stage12BlockedError(faces.data.problems));
  }

  const problems = bindingProblems(input, stage12.data, found.faces);

  if (problems.length > 0) {
    return err(new Stage12BlockedError(problems));
  }

  const paths = versionFaces(stage12.data.paths.track, input.artifact);

  if (!paths.ok) {
    return paths;
  }

  const written = await applyWrites(
    [
      {
        kind: "text",
        text: serialize({ faces: input.faces, found: foundFile }),
        to: paths.data.binding,
      },
    ],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  const bound = Object.values(input.faces);

  return ok({
    clip: input.artifact,
    created:
      input.mode === "apply" ? [toWorkspacePath(input.workspace.root, paths.data.binding)] : [],
    faces: input.faces,
    nextStep: `aimator versions lip-sync ${input.projectId} ${input.episodeId} --track ${input.track} --artifact ${input.artifact} --dry-run`,
    notices: target.speakers
      .filter((cast) => !bound.includes(cast))
      .map(
        (cast) => `${cast} mówi w kadrze ${input.artifact}, a żadna twarz nie jest mu przypisana`
      ),
  });
}
