import { z } from "zod";
import {
  emptyStage,
  nowIso,
  type RecordedFile,
  readDigest,
  readJson,
  removeFile,
  type StageFile,
  serialize,
  sha256Schema,
  stageFileSchema,
  toWorkspacePath,
  writeNew,
} from "../artifact/index.js";
import { checkClips } from "../clips/index.js";
import { checkDialogue, type DialogueStatus } from "../dialogue/index.js";
import { readLipSync, readStage0Inputs } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import { checkShotList, type ShotList } from "../shot-list/index.js";
import {
  clipVideo,
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  projectPaths,
  versionFaces,
  type Workspace,
} from "../workspace.js";

/** The one stage name this module writes and reads. */
export const STAGE = "versions";

/**
 * Internal to the versions module: what stage 12 reads, and whether it may pay.
 *
 * The whole stage hangs off one episode decision, the language the mouths move
 * in, so that is the first gate and every command answers it the same way:
 * with the command that records it.
 *
 * **Which clips is derived, never stored.** A clip is lip-synced when a line of
 * the translation is spoken in it by a character the shot shows; the shot list
 * says which clip a shot is in and who it shows, and the translation says who
 * speaks where. A file listing the clips would be a second copy of that, and it
 * would drift at the first corrected shot.
 */

export interface Stage12Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

export class Stage12BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`etap 12 nie może tego zrobić:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "Stage12BlockedError";
    this.problems = problems;
  }
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
 * Runs a paid command while this track's stage-12 lock is held, and lets it go
 * however the command ends: one paid command per track at a time, so two
 * shells never buy the same faces or the same job twice.
 */
export async function holdingLock<T>(
  lock: string,
  work: () => Promise<Result<T>>
): Promise<Result<T>> {
  const held = await writeNew(lock, serialize({ pid: process.pid, startedAt: nowIso() }));

  if (!held.ok) {
    return err(new LockError(lock));
  }

  try {
    return await work();
  } finally {
    await removeFile(lock);
  }
}

/** One translated line and where its recording stands, as stage 11 reports it. */
export type SpokenLine = NonNullable<DialogueStatus["translation"]>["lines"][number];

/** One clip whose mouths move: who speaks in it on screen, and the lines they say. */
export interface ClipTarget {
  readonly id: string;
  /** The translated lines spoken on screen in this clip, in the order they are spoken. */
  readonly lines: readonly SpokenLine[];
  /** Who speaks on screen, ordered by their first line: the order the jobs run in. */
  readonly speakers: readonly string[];
  /** Where the clip begins, in the seconds of the approved plan. */
  readonly start: number;
}

export interface Stage12 {
  /** The project's frame, which the plan's clock reads each clip against. */
  readonly aspectRatio: string;
  /** The roster's ids: who a face may be bound to. */
  readonly cast: readonly string[];
  /** The language the film was written in, which its own version speaks over the moved mouths. */
  readonly filmLanguage: string;
  /** Why nothing in this stage may happen yet. Empty means it may. */
  readonly gate: readonly string[];
  /** The language of the mouths, or null while the episode names none. */
  readonly language: string | null;
  /** What the stage says without refusing: a line spoken from off screen. */
  readonly notices: readonly string[];
  readonly paths: { readonly episode: EpisodePaths; readonly track: EpisodeTrackPaths };
  /** `versions.stage.json` as it stands, or an empty one. */
  readonly stage: StageFile;
  readonly targets: readonly ClipTarget[];
  /** Whether the translation the lines are read from holds its own yes. */
  readonly translationApproved: boolean;
  /** Clips nobody visible speaks in, which pass to the version as they are. */
  readonly untouched: readonly string[];
}

/** The record key of the faces found in one clip: `faces:C01`. */
export function facesKey(clip: string): string {
  return `faces:${clip}`;
}

function readPaths(input: Stage12Scope): Result<Stage12["paths"]> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  return episode.ok
    ? ok({ episode: episode.data, track: episodeTrackPaths(episode.data, input.track) })
    : episode;
}

export async function readStage12(input: Stage12Scope): Promise<Result<Stage12>> {
  const lipSync = await readLipSync(input);
  const stage0 = await readStage0Inputs(input);
  const paths = readPaths(input);

  if (!lipSync.ok) {
    return lipSync;
  }
  if (!stage0.ok) {
    return stage0;
  }
  if (!paths.ok) {
    return paths;
  }

  const read = await readJson(paths.data.track.versionsStage, stageFileSchema);
  const base = {
    aspectRatio: stage0.data.aspectRatio,
    cast: stage0.data.cast.map((member) => member.id),
    filmLanguage: stage0.data.settings.language,
    language: lipSync.data.kind === "language" ? lipSync.data.language : null,
    paths: paths.data,
    stage: read.ok ? read.data : emptyStage(STAGE),
  };

  const scope = `${input.projectId} ${input.episodeId}`;
  const { audio } = stage0.data.settings;
  const gate: string[] = [];

  if (lipSync.data.kind === "undecided") {
    gate.push(
      `odcinek nie ma decyzji, w jakim języku ruszają się usta, a wersja językowa powstaje właśnie w nim: aimator episode lip-sync ${scope} --language <kod> albo --none`
    );
  }

  if (lipSync.data.kind === "none") {
    gate.push(
      `lip-sync.json: none, odcinek nie dostaje drugiej wersji; drugi język wybiera: aimator episode lip-sync ${scope} --language <kod>`
    );
  }

  // The English version re-voices the cast and nobody else: a narrator would
  // stay in the film's language over English mouths, which is no version.
  if (audio === "dialogue-and-narration") {
    gate.push(
      "odcinek deklaruje audio: dialogue-and-narration, a narracja w drugim języku jest poza zakresem, więc wersji językowej nie będzie"
    );
  } else if (audio !== "dialogue") {
    gate.push(`odcinek deklaruje audio: ${audio}, postacie nie mówią, nie ma czyich ust poruszyć`);
  }

  if (gate.length > 0) {
    return ok({
      ...base,
      gate,
      notices: [],
      targets: [],
      translationApproved: false,
      untouched: [],
    });
  }

  const dialogue = await checkDialogue(input);
  const plan = await checkShotList(input);

  if (!dialogue.ok) {
    return dialogue;
  }
  if (!plan.ok) {
    return plan;
  }

  const { translation } = dialogue.data;

  if (translation === null || translation.state !== "completed") {
    gate.push(
      `nie ma przekładu skryptu dialogu, a wersja językowa mówi jego słowami: aimator dialogue translate ${scope}`
    );
  } else if (translation.lines.length === 0) {
    gate.push(
      `przekład skryptu dialogu nie przechodzi walidacji: aimator check ${scope} --stage dialogue`
    );
  }

  if (plan.data.verdict === null) {
    gate.push(`lista ujęć nie przechodzi walidacji: aimator check ${scope} --stage shot-list`);
  }

  return ok({
    ...base,
    gate,
    translationApproved: translation?.approved === true,
    ...derive(plan.data.verdict, translation?.lines ?? []),
  });
}

const recordedSchema = z.strictObject({ path: z.string().min(1), sha256: sha256Schema });

/** `faces.json`: the face call's answer for one clip, kept. */
const facesFileSchema = z.strictObject({
  /** The clip the faces were found in, as it was then. */
  clip: recordedSchema,
  faces: z.array(
    z.strictObject({
      end: z.number(),
      id: z.string().min(1),
      image: recordedSchema.nullable(),
      start: z.number(),
    })
  ),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  source: z.enum(["video_id", "video_url"]),
});

/** `binding.json`: which character each face is, and which `faces.json` that was said of. */
const bindingFileSchema = z.strictObject({
  faces: z.record(z.string(), z.string()),
  found: recordedSchema,
});

type FacesFile = z.infer<typeof facesFileSchema>;

/** One clip's faces as the lip-sync reads them, and what still stands in its way. */
export interface ClipFaces {
  /** Face id → cast id, while the binding speaks of the faces on disk; null otherwise. */
  readonly binding: Readonly<Record<string, string>> | null;
  readonly bindingFile: RecordedFile | null;
  readonly found: FacesFile | null;
  readonly foundFile: RecordedFile | null;
  /** Why this clip's lip-sync may not start on these faces yet. */
  readonly problems: readonly string[];
}

/** Why a named clip is not one this stage lip-syncs, once the stage's own gate holds. */
export function untargeted(stage12: Stage12, clip: string): readonly string[] {
  if (stage12.gate.length > 0 || stage12.targets.some((one) => one.id === clip)) {
    return [];
  }

  const needed = stage12.targets.map((one) => one.id).join(", ") || "żaden";

  return [
    `${clip}: nikt widoczny w kadrze nie mówi w tym klipie, wersja przejmie go bez zmian; lip-syncu potrzebują: ${needed}`,
  ];
}

export function bindCommand(
  input: Stage12Scope,
  clip: string,
  speakers: readonly string[]
): string {
  const faces = speakers.map((cast) => `<twarz>=${cast}`).join(",");

  return `aimator versions bind ${input.projectId} ${input.episodeId} --track ${input.track} --artifact ${clip} --face ${faces}`;
}

/**
 * The faces found in one clip and who a person said they are, each judged
 * against what it was said of: the faces against the clip as it is now, the
 * binding against the faces as they are now. A clip rendered again has other
 * faces in it, and a binding of faces found again names faces nobody looked at.
 */
export async function readClipFaces(
  input: Stage12Scope,
  stage12: Stage12,
  target: ClipTarget,
  clip: RecordedFile | null
): Promise<Result<ClipFaces>> {
  const paths = versionFaces(stage12.paths.track, target.id);

  if (!paths.ok) {
    return paths;
  }

  const scope = `${input.projectId} ${input.episodeId} --track ${input.track} --artifact ${target.id}`;
  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const found = await readJson(paths.data.faces, facesFileSchema);
  const foundBytes = await readDigest(paths.data.faces);
  const bound = await readJson(paths.data.binding, bindingFileSchema);
  const boundBytes = await readDigest(paths.data.binding);
  const foundFile = foundBytes.ok
    ? { path: relative(paths.data.faces), sha256: foundBytes.data.sha256 }
    : null;
  const bindingFile = boundBytes.ok
    ? { path: relative(paths.data.binding), sha256: boundBytes.data.sha256 }
    : null;

  if (!(found.ok && foundFile !== null)) {
    return ok({
      binding: null,
      bindingFile,
      found: null,
      foundFile: null,
      problems: [`${target.id}: twarze nie są rozpoznane: aimator versions faces ${scope}`],
    });
  }

  const problems: string[] = [];

  if (clip !== null && found.data.clip.sha256 !== clip.sha256) {
    problems.push(
      `${target.id}: klip zmienił się od rozpoznania twarzy, rozpoznaj je ponownie: aimator versions faces ${scope} --regenerate`
    );
  }

  const binding =
    bound.ok && bound.data.found.sha256 === foundFile.sha256 ? bound.data.faces : null;

  if (!bound.ok) {
    problems.push(
      `${target.id}: twarze nie są przypisane postaciom: ${bindCommand(input, target.id, target.speakers)}`
    );
  } else if (binding === null) {
    problems.push(
      `${target.id}: przypisanie dotyczy wcześniejszego rozpoznania twarzy, przypisz je ponownie: ${bindCommand(input, target.id, target.speakers)}`
    );
  }

  const unbound = target.speakers.filter(
    (cast) => binding !== null && !Object.values(binding).includes(cast)
  );

  problems.push(
    ...unbound.map(
      (cast) =>
        `${target.id}: ${cast} mówi w kadrze, a żadna twarz nie jest mu przypisana: ${bindCommand(input, target.id, target.speakers)}`
    )
  );

  return ok({ binding, bindingFile, found: found.data, foundFile, problems });
}

/** A clip as stage 7 published it on this track, as far as stage 12 reads it. */
export interface SourceClip {
  readonly path: string;
  /** Why stage 12 may not use it yet: a clip nobody accepted is not one to lip-sync. */
  readonly problems: readonly string[];
  /** Its stage-7 record: which model rendered it, and the attempt that holds Kling's id. */
  readonly record: { readonly producer: { readonly model: string | null }; readonly runId: string };
  /** Its file as it stands now, or null while there is none. */
  readonly recorded: RecordedFile | null;
}

/**
 * One clip of this track, accepted or not. The verdict is stage 7's own,
 * through its entry, so a clip whose inputs drifted is as unaccepted here as it
 * is there.
 */
export async function readSourceClip(
  input: Stage12Scope,
  stage12: Stage12,
  id: string
): Promise<Result<SourceClip>> {
  const path = clipVideo(stage12.paths.track, id);
  const status = await checkClips(input);

  if (!path.ok) {
    return path;
  }
  if (!status.ok) {
    return status;
  }

  const clips = await readJson(stage12.paths.track.clipsStage, stageFileSchema);
  const record = clips.ok ? clips.data.artifacts[id] : undefined;
  const state = status.data.artifacts.find((one) => one.kind === "clip" && one.id === id);
  const bytes = await readDigest(path.data);

  return ok({
    path: path.data,
    problems: [
      ...(state?.approved === true
        ? []
        : [
            `${id}: klip nie ma ważnej zgody na torze ${input.track}, lip-sync rusza usta tylko w przyjętym obrazie: aimator check ${input.projectId} ${input.episodeId} --stage clips --track ${input.track}`,
          ]),
      ...(bytes.ok ? [] : [`${id}: brakuje pliku klipu na torze ${input.track}`]),
    ],
    record: record ?? { producer: { model: null }, runId: "" },
    recorded: bytes.ok
      ? { path: toWorkspacePath(input.workspace.root, path.data), sha256: bytes.data.sha256 }
      : null,
  });
}

/**
 * Why a line of this clip may not be lip-synced yet: it is the line a person
 * has to accept. One copy for the purchase and the check, because a clip the
 * purchase refuses over a line is one the check has to say waits for it.
 */
export function lineProblems(input: Stage12Scope, stage12: Stage12, target: ClipTarget): string[] {
  const scope = `${input.projectId} ${input.episodeId}`;
  const problems = stage12.translationApproved
    ? []
    : [
        `${target.id}: przekład skryptu nie ma ważnej zgody: aimator check ${scope} --stage dialogue`,
      ];

  for (const line of target.lines) {
    if (line.state !== "completed") {
      problems.push(
        `${line.key}: kwestia nie jest kupiona: aimator dialogue generate ${scope} --language ${stage12.language ?? "<kod>"}`
      );
    } else if (!line.approved) {
      problems.push(
        `${line.key}: kwestia nie ma ważnej zgody, odsłuchaj i zatwierdź: aimator approve ${scope} --stage dialogue --artifact ${line.key}`
      );
    }
  }

  return problems;
}

/** The clips whose mouths move, the ones that pass untouched, and the lines heard from off screen. */
function derive(
  plan: ShotList | null,
  lines: readonly SpokenLine[]
): Pick<Stage12, "notices" | "targets" | "untouched"> {
  if (plan === null) {
    return { notices: [], targets: [], untouched: [] };
  }

  const clipOf = new Map(plan.shots.map((shot) => [shot.id, shot.clip]));
  const notices = lines
    .filter((line) => !line.onScreen)
    .map(
      (line) =>
        `${line.key}: ${line.cast} mówi spoza kadru ujęcia ${line.shot}, nie ma czyich ust poruszyć, kwestia zostaje bez lip-syncu`
    );
  const targets: ClipTarget[] = [];

  for (const clip of plan.clips) {
    const spoken = lines.filter((line) => line.onScreen && clipOf.get(line.shot) === clip.id);

    if (spoken.length > 0) {
      targets.push({
        id: clip.id,
        lines: spoken,
        speakers: [...new Set(spoken.map((line) => line.cast))],
        start: clip.start,
      });
    }
  }

  return {
    notices,
    targets,
    untouched: plan.clips
      .map((clip) => clip.id)
      .filter((id) => !targets.some((one) => one.id === id)),
  };
}
