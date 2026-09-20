import {
  emptyStage,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  stageFileSchema,
  toWorkspacePath,
} from "../artifact/index.js";
import { validateAudio } from "../audio-model/index.js";
import { type EpisodeSettings, readStage0Inputs } from "../project/index.js";
import { ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import type { PlanClock } from "../timeline.js";
import { validateVideo } from "../video-model/index.js";
import {
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  type ProjectPaths,
  projectPaths,
  soundStem,
  type Workspace,
} from "../workspace.js";
import { buildPrompt } from "./prompt.js";
import { validateSoundDesign } from "./validate.js";

/**
 * Internal to the sound-design module: what stage 10 reads, and whether it may
 * act.
 *
 * Two gates, because two halves that cost different things — stage 9's shape,
 * one row down.
 *
 * **Buying the stems** waits on the approved shot list and, for the stems
 * themselves, on an approved cue sheet. It does **not** wait on a cut and does
 * not wait on stage 9: a bed has no idea which of the two films it will sit
 * under, and a thunderclap does not care whether anybody has recorded the
 * narrator yet. The two stages can run side by side.
 *
 * **Mixing** waits on this track's approved `episode.mp4`, on every stem, and
 * — when the episode's mode carries speech — on this track's approved
 * `narrated.mp4` and on the accepted lines behind it.
 *
 * That last gate is the one worth defending, because it looks like the mistake
 * stage 8 names: holding a stage hostage to a file it never opens. Stage 10
 * builds the full mix from `episode.mp4` and the lossless stems rather than
 * from `narrated.mp4`, so it genuinely does not read those bytes. What it
 * reads is the **yes** on them — and that yes is the only evidence anywhere
 * that the narration lands in the right place over this film, which is a fact
 * stage 10 reuses rather than re-establishes. `narrated.mp4` does not become a
 * dead end; it becomes the one place that placement can be heard without music
 * in the way.
 */

/** The one stage name this module writes and reads, at both of its levels. */
export const STAGE = "sound-design";

/** The artifact key of the cue sheet: the one record that is not a stem. */
export const CUES = "cues";

/** The artifact key of the full mix, per track. It names the film, not the making of it. */
export const MIXED = "mixed";

export interface Stage10Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

export class Stage10BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`etap 10 nie może tego zrobić:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "Stage10BlockedError";
    this.problems = problems;
  }
}

export interface Stage10Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
}

export interface Stage10Inputs {
  readonly aspectRatio: string;
  /** Why the cue sheet may not be bought yet. Empty means it may. */
  readonly gate: readonly string[];
  /** project.json, project.md, episode.json and shot-list.md, with digests. */
  readonly inputs: readonly RecordedFile[];
  /**
   * Whether a bed must be guaranteed free of singing.
   *
   * Derived from the episode's sound mode rather than stored, and that is the
   * same move `force_instrumental` deserves: a mode that carries speech has
   * already decided a voice is the foreground, and a second voice singing over
   * the narrator is not a decision anybody made. A mode with no speech in it
   * may legitimately have vocals, so it gets them.
   */
  readonly instrumental: boolean;
  readonly paths: Stage10Paths;
  /** The exact text a paid call would send, or `null` when it cannot be built. */
  readonly prompt: string | null;
  readonly settings: EpisodeSettings;
  /** The shared stage file: the cue sheet and every bought stem. */
  readonly stage: StageFile;
}

function resolvePaths(input: Stage10Scope): Result<Stage10Paths> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  return episode.ok ? ok({ episode: episode.data, project: project.data }) : episode;
}

/** Whether this episode's declared mode puts a human voice in the film. */
function carriesSpeech(settings: EpisodeSettings): boolean {
  return settings.audio !== "music-and-effects";
}

/**
 * Everything stage 10's shared half consumes, with the digest of each file as
 * it was read.
 *
 * It does not read the prompt package: nothing here carries an instruction to
 * an image or video model, so a hash of bytes nobody sent would describe a
 * question nobody asked — the same reason stage 9 does not record it either.
 */
export async function readStage10Inputs(input: Stage10Scope): Promise<Result<Stage10Inputs>> {
  const paths = resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const stage0 = await readStage0Inputs(input);

  if (!stage0.ok) {
    return stage0;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const sourcePath = relative(paths.data.episode.source);
  const gate: string[] = [];

  // One gate covers stages 0 to 3 arithmetically, exactly as stage 8's and
  // stage 9's do: the project files are recorded inputs of the shot list, so
  // editing one revokes its approval and this refuses without a rule of its own.
  const upstream = await checkShotList(input);

  if (!upstream.ok) {
    return upstream;
  }

  if (!upstream.data.approved) {
    gate.push(...upstream.data.problems);
    gate.push(
      `etap 3 musi mieć review.status = "approved" zanim etap 10 wyda pieniądze: aimator approve ${input.projectId} ${input.episodeId} --stage shot-list`
    );
  }

  const shotList = await readDigest(paths.data.episode.shotList);

  if (!shotList.ok) {
    gate.push(`brakuje ${relative(paths.data.episode.shotList)} — etap 10 nie ma z czego pisać`);
  }

  const stage = await readJson(paths.data.episode.soundDesignStage, stageFileSchema);
  const text = shotList.ok ? shotList.data.bytes.toString("utf8") : null;

  return ok({
    aspectRatio: stage0.data.aspectRatio,
    gate,
    inputs: [
      ...stage0.data.inputs.filter((entry) => entry.path !== sourcePath),
      ...(shotList.ok
        ? [{ path: relative(paths.data.episode.shotList), sha256: shotList.data.sha256 }]
        : []),
    ],
    instrumental: carriesSpeech(stage0.data.settings),
    paths: paths.data,
    prompt:
      text === null
        ? null
        : buildPrompt({
            rules: stage0.data.rules,
            settings: stage0.data.settings,
            shotList: text,
          }),
    settings: stage0.data.settings,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
  });
}

/** One bought stem, with the bytes somebody accepted. */
interface AcceptedStem {
  /** Where the plan puts it, before any track's drift is applied. */
  readonly atSeconds: number;
  readonly id: string;
  readonly kind: "effect" | "music";
  /** Absolute, for the muxer. */
  readonly path: string;
  /** How long the bought audio actually runs, from its own frames. */
  readonly seconds: number;
}

interface AcceptedStems {
  /** Why these stems may not be laid down yet. Empty means they may. */
  readonly gate: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly stems: readonly AcceptedStem[];
}

/** The cue sheet as data, or `null` when there is none that validates. */
export async function readSheet(
  input: Stage10Scope,
  stage10: Stage10Inputs
): Promise<ReturnType<typeof validateSoundDesign> | null> {
  const text = await readDigest(stage10.paths.episode.soundDesign);
  const plan = await checkShotList(input);

  if (!(text.ok && plan.ok) || plan.data.verdict === null) {
    return null;
  }

  return validateSoundDesign({
    shotList: plan.data.verdict,
    text: text.data.bytes.toString("utf8"),
  });
}

/**
 * Every cue of the approved sheet, with the stem somebody accepted.
 *
 * Stage 9's `readAcceptedLines` one row down, and deliberately the same shape:
 * the gate is per cue and it is approval rather than existence, because bytes
 * that merely exist are bytes nobody has listened to.
 */
export async function readAcceptedStems(input: Stage10Scope): Promise<Result<AcceptedStems>> {
  const stage10 = await readStage10Inputs(input);

  if (!stage10.ok) {
    return stage10;
  }

  const sheet = await readSheet(input, stage10.data);
  const digest = await readDigest(stage10.data.paths.episode.soundDesign);

  // An absent sheet is an obstacle, not a failure: `--dry-run` has to report it
  // beside the others rather than die on it, which every gate here promises.
  if (sheet === null || !digest.ok) {
    return ok({
      gate: ["nie ma arkusza cue — uruchom najpierw: sound-design generate"],
      inputs: [],
      stems: [],
    });
  }

  if (!sheet.ok) {
    return ok({ gate: [sheet.error.message], inputs: [], stems: [] });
  }

  const gate: string[] = [];
  const inputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, stage10.data.paths.episode.soundDesign),
      sha256: digest.data.sha256,
    },
  ];

  if (stage10.data.stage.artifacts[CUES]?.review.status !== "approved") {
    gate.push("arkusz cue czeka na ocenę człowieka");
  }

  const stems: AcceptedStem[] = [];
  const wanted: readonly PlannedCue[] = [
    ...sheet.data.music.map((cue) => ({
      atSeconds: cue.start,
      id: cue.id,
      kind: "music" as const,
    })),
    ...sheet.data.effects.map((cue) => ({
      atSeconds: cue.atSeconds,
      id: cue.id,
      kind: "effect" as const,
    })),
  ];

  for (const cue of wanted) {
    const file = soundStem(stage10.data.paths.episode, cue.id);

    if (!file.ok) {
      return file;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one stem read at a time, in the sheet's order
    const one = await readStem(input, stage10.data.stage, cue, file.data);

    gate.push(...one.gate);

    if (one.stem !== null && one.recorded !== null) {
      inputs.push(one.recorded);
      stems.push(one.stem);
    }
  }

  if (stems.length === 0) {
    gate.push("żaden stem nie jest gotowy — nie ma czego położyć na obrazie");
  }

  return ok({ gate, inputs, stems });
}

/** One cue as the sheet planned it: enough to find its file and place it. */
interface PlannedCue {
  readonly atSeconds: number;
  readonly id: string;
  readonly kind: "effect" | "music";
}

/** One bought stem: is it there, does it match its record, did anybody accept it. */
async function readStem(
  input: Stage10Scope,
  stage: StageFile,
  cue: PlannedCue,
  file: string
): Promise<{
  gate: readonly string[];
  recorded: RecordedFile | null;
  stem: AcceptedStem | null;
}> {
  const bytes = await readDigest(file);
  const record = stage.artifacts[cue.id];

  if (!bytes.ok || record?.status !== "completed") {
    return {
      gate: [`${cue.id}: nie ma dźwięku — cue nie zostało kupione`],
      recorded: null,
      stem: null,
    };
  }

  const recorded = {
    path: toWorkspacePath(input.workspace.root, file),
    sha256: bytes.data.sha256,
  };
  const output = record.outputs.find((one) => one.path === recorded.path);
  const gate: string[] = [];

  if (output === undefined || output.sha256 !== recorded.sha256) {
    gate.push(`${cue.id}: bajty dźwięku nie zgadzają się z jego rekordem`);
  }

  if (record.review.status !== "approved") {
    gate.push(`${cue.id}: dźwięk czeka na ocenę człowieka`);
  }

  const verdict = validateAudio(bytes.data.bytes);

  if (!verdict.ok) {
    return { gate: [...gate, `${cue.id}: ${verdict.error.message}`], recorded: null, stem: null };
  }

  return {
    gate,
    recorded,
    stem: { ...cue, path: file, seconds: verdict.data.seconds },
  };
}

interface TrackState {
  /** How long this track's cut actually runs, read from its own boxes. */
  readonly actualSeconds: number;
  /** Why this track may not be mixed yet. Empty means it may. */
  readonly gate: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly paths: EpisodeTrackPaths;
  /** This track's own sound-design stage file. */
  readonly stage: StageFile;
  /** The approved cut. Its frames are copied through, never re-encoded. */
  readonly video: string;
}

/**
 * This track's finished film, and whether stage 10 may lay anything over it.
 *
 * Two approvals rather than one. `episode.mp4` because its frames are what the
 * full mix copies through. `narrated.mp4` because the yes on it is the only
 * evidence that the narration lands correctly over *this* film — and only when
 * the episode's mode carries speech, since a film with no narrator has no
 * narrated cut to wait for and demanding one would be a gate with nothing
 * behind it.
 */
export async function readTrackState(
  input: Stage10Scope & { readonly track: ImageTrack },
  stage10: Stage10Inputs
): Promise<Result<TrackState>> {
  const track = episodeTrackPaths(stage10.paths.episode, input.track);
  const assembly = await readJson(track.assemblyStage, stageFileSchema);
  const soundtrack = await readJson(track.soundtrackStage, stageFileSchema);
  const stage = await readJson(track.soundDesignStage, stageFileSchema);
  const record = assembly.ok ? assembly.data.artifacts.episode : undefined;
  const cut = await readDigest(track.episodeVideo);
  const gate: string[] = [];
  const idle = {
    actualSeconds: 0,
    inputs: [],
    paths: track,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
    video: track.episodeVideo,
  };

  if (record === undefined || record.status !== "completed") {
    gate.push(`nie ma zmontowanego odcinka na torze ${input.track} — etap 8 go nie ukończył`);
  }

  if (!cut.ok) {
    return ok({
      ...idle,
      gate: [...gate, `brakuje ${toWorkspacePath(input.workspace.root, track.episodeVideo)}`],
    });
  }

  const recorded: RecordedFile = {
    path: toWorkspacePath(input.workspace.root, track.episodeVideo),
    sha256: cut.data.sha256,
  };
  const output = record?.outputs.find((one) => one.path === recorded.path);

  if (record !== undefined && (output === undefined || output.sha256 !== recorded.sha256)) {
    gate.push(`bajty odcinka nie zgadzają się z jego rekordem z etapu 8 na torze ${input.track}`);
  }

  if (record !== undefined && record.review.status !== "approved") {
    gate.push(`zmontowany odcinek czeka na ocenę człowieka na torze ${input.track}`);
  }

  if (carriesSpeech(stage10.settings)) {
    const narrated = soundtrack.ok ? soundtrack.data.artifacts.narrated : undefined;

    if (narrated === undefined || narrated.status !== "completed") {
      gate.push(
        `nie ma narracji położonej na obrazie na torze ${input.track} — etap 9 nie ukończył miksu`
      );
    } else if (narrated.review.status !== "approved") {
      gate.push(
        `narracja na torze ${input.track} czeka na ocenę człowieka — to jedyne miejsce, w którym słychać samo jej umieszczenie, i etap 10 z tej zgody korzysta`
      );
    }
  }

  // The film's own length, read from its boxes. It is what the placement is
  // measured against, never the episode's declared duration: the clips drifted
  // and stage 8 cut what came back rather than trimming it.
  const verdict = validateVideo(cut.data.bytes, {
    aspectRatio: stage10.aspectRatio,
    seconds: null,
  });

  return ok({
    ...idle,
    actualSeconds: verdict.ok ? verdict.data.seconds : 0,
    gate: verdict.ok
      ? gate
      : [
          ...gate,
          `odcinek na torze ${input.track} nie daje się odczytać: ${verdict.error.message}`,
        ],
    inputs: [recorded],
  });
}

/** One sound as the mixer uses it: where the bytes are, and when they start. */
export interface PlacedSound {
  /** The second of *this track's* finished film it begins at. */
  readonly atSeconds: number;
  readonly id: string;
  readonly kind: "effect" | "music" | "speech";
  /** Absolute, for the muxer. */
  readonly path: string;
  /** What the plan said, before the track's own drift was applied. */
  readonly plannedSeconds: number;
  readonly seconds: number;
}

/**
 * Where each sound lands on this track, and every reason it may not land there.
 *
 * The two refusals stage 9 owns apply unchanged to an effect: the bytes are
 * published as they arrived, because somebody paid for them, but **where** a
 * sound sits comes from a plan a human approved, so one that runs past the end
 * of the film is refused and the message names the remedy.
 *
 * Two things differ from speech, and both are the nature of the material
 * rather than an exception. **Effects may overlap each other** — two things
 * can happen at once, and only a narrator cannot talk over himself. And **a
 * bed that falls short of the film is reported, not refused**: that is a gap,
 * which is stage 8's kind of drift, rather than an overlap, which is stage 7's
 * kind of collision. Refusing a film for a tenth of a second of silence at the
 * end would be a refusal nobody downstream could act on.
 */
export function placeSounds(input: {
  readonly actualSeconds: number;
  readonly clock: PlanClock;
  /**
   * Everything to be laid down, in one list.
   *
   * A stem and an accepted line are different artifacts of different stages,
   * and this deliberately asks for neither: what placement needs is an id,
   * some bytes, a second of the plan and a length. Taking the union of two
   * stages' types instead would make this function know which stage each
   * sound came from, which is exactly what it must not care about.
   */
  readonly sounds: readonly {
    readonly atSeconds: number;
    readonly id: string;
    readonly kind: PlacedSound["kind"];
    readonly path: string;
    readonly seconds: number;
  }[];
}): { placed: readonly PlacedSound[]; problems: readonly string[] } {
  const placed: PlacedSound[] = [];
  const problems: string[] = [];

  for (const sound of input.sounds) {
    const atSeconds = input.clock.at(sound.atSeconds);
    const ends = round(atSeconds + sound.seconds);

    if (sound.kind === "effect" && ends > input.actualSeconds) {
      problems.push(
        `${sound.id} kończy się w ${ends}s, a film trwa ${input.actualSeconds}s — efekt nie mieści się w odcinku; skróć go w arkuszu cue albo przesuń jego kotwicę`
      );
    }

    placed.push({
      atSeconds,
      id: sound.id,
      kind: sound.kind,
      path: sound.path,
      plannedSeconds: sound.atSeconds,
      seconds: sound.seconds,
    });
  }

  return { placed, problems };
}

/** Seconds, to the thousandth — the precision an audio delay is spelled in. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Where the music stops short of the film, stated rather than corrected.
 *
 * Stage 8's reading of drift, one row down: the clips came back a little
 * longer than the plan ordered, so a bed bought at the plan's length ends a
 * fraction before the picture does. Stretching it would be bytes nobody
 * accepted; refusing would be a refusal with no remedy. So it is reported, and
 * the silence at the end is a silence somebody can hear and decide about.
 */
export function musicGap(placed: readonly PlacedSound[], actualSeconds: number): readonly string[] {
  const beds = placed.filter((sound) => sound.kind === "music");

  if (beds.length === 0) {
    return [];
  }

  const last = beds.reduce((end, bed) => Math.max(end, round(bed.atSeconds + bed.seconds)), 0);
  const gap = round(actualSeconds - last);

  return gap <= 0
    ? []
    : [
        `podkład kończy się w ${last}s, a film trwa ${actualSeconds}s — ostatnie ${gap}s gra bez muzyki, bo klipy wróciły dłuższe niż plan; to meldunek, nie błąd`,
      ];
}

/**
 * What the episode declared it would sound like, against what stage 10 can
 * make.
 *
 * Two of the four modes are closed by this stage: `music-and-effects` and
 * `narration` are exactly what stages 9 and 10 produce between them. The other
 * two are not, and the missing half is not music — it is **character
 * dialogue**, which no stage in this pipeline produces and none does after
 * this one. Rule 7 says an absence is reported rather than filled with a
 * guess, so it is stated the way stage 8 states silence and stage 2 states a
 * missing alpha channel. The row that would close it is declared, not
 * half-built.
 */
export function missingDialogue(settings: EpisodeSettings): readonly string[] {
  if (settings.audio !== "dialogue" && settings.audio !== "dialogue-and-narration") {
    return [];
  }

  return [
    `odcinek deklaruje audio: ${settings.audio}, czyli mowę postaci — etap 10 składa muzykę, efekty i narrację, a dialogów postaci nie wytwarza żaden etap tego potoku`,
  ];
}
