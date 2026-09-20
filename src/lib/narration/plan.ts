import {
  emptyStage,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  stageFileSchema,
  toWorkspacePath,
} from "../artifact/index.js";
import { type EpisodeSettings, readStage0Inputs } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import { validateVideo } from "../video-model/index.js";
import {
  clipVideo,
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { buildPrompt } from "./prompt.js";
import type { NarrationLine } from "./validate.js";

/**
 * Internal to the narration module: what stage 9 reads, and whether it may act.
 *
 * Stage 9 has two gates rather than one, because it has two halves that cost
 * different things.
 *
 * **Buying the speech** waits on the approved shot list and on a voice: the
 * words come out of the plan, and a narrator nobody cast is not a decision the
 * tool gets to make. It does **not** wait on a cut — a sentence is bought once
 * and read the same way whichever film it ends up over, so holding it hostage
 * to a track would be the mistake the contract calls holding a stage hostage to
 * a file it never opens.
 *
 * **Mixing** waits on the approved lines *and* on this track's approved
 * `episode.mp4`, because only then is there a timeline to lay them on.
 *
 * Which is also the answer to where the anchors resolve. The script says `N02
 * begins at 7s of the plan`; a track's clips came back with their own drift, so
 * 7s of the plan is not 7s of that film. `resolve` maps one to the other
 * through the clips themselves — the same arithmetic stage 8 already does, run
 * in the other direction. That is stage 4's precedent, exactly: one artifact,
 * two productions, resolved at the sender.
 */

/** The one stage name this module writes and reads, at both of its levels. */
export const STAGE = "soundtrack";

/** The artifact key of the script: the one record that is not an utterance. */
export const SCRIPT = "script";

/** The artifact key of the mix, per track. It names the film, not the making of it. */
export const NARRATED = "narrated";

export interface Stage9Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

export class Stage9BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`etap 9 nie może tego zrobić:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "Stage9BlockedError";
    this.problems = problems;
  }
}

export interface Stage9Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
}

export interface Stage9Inputs {
  /** The episode's frame, which the verdict on a narrated cut compares against. */
  readonly aspectRatio: string;
  /** Why the script may not be bought yet. Empty means it may. */
  readonly gate: readonly string[];
  /** project.json, project.md, episode.json and shot-list.md, with digests. */
  readonly inputs: readonly RecordedFile[];
  /** Which voice reads the series, or null when nobody has cast one. */
  readonly narratorVoiceId: string | null;
  readonly paths: Stage9Paths;
  /** The exact text a paid call would send, or `null` when it cannot be built. */
  readonly prompt: string | null;
  readonly settings: EpisodeSettings;
  /** `shot-list.md`, verbatim — the document every sentence is lifted out of. */
  readonly shotList: string | null;
  /** The shared stage file: the script and every bought line. */
  readonly stage: StageFile;
}

function resolvePaths(input: Stage9Scope): Result<Stage9Paths> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  return episode.ok ? ok({ episode: episode.data, project: project.data }) : episode;
}

/**
 * Everything stage 9's shared half consumes, with the digest of each file as it
 * was read.
 *
 * It does not read the prompt package: nothing here carries an instruction to
 * an image or video model, so a hash of bytes nobody sent would describe a
 * question nobody asked — the same reason stage 3 does not record `source.md`
 * and stage 8 does not record the manifest.
 */
export async function readStage9Inputs(input: Stage9Scope): Promise<Result<Stage9Inputs>> {
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

  // One gate covers stage 0 and stage 1 arithmetically, exactly as stage 8's
  // does: the project files are recorded inputs of the shot list, so editing
  // one revokes its approval and this refuses without a rule of its own.
  const upstream = await checkShotList(input);

  if (!upstream.ok) {
    return upstream;
  }

  if (!upstream.data.approved) {
    gate.push(...upstream.data.problems);
    gate.push(
      `etap 3 musi mieć review.status = "approved" zanim etap 9 wyda pieniądze: aimator approve ${input.projectId} ${input.episodeId} --stage shot-list`
    );
  }

  // An episode whose sound mode forbids a narrator has no narration to lift,
  // and buying one would put a voice into a film nobody asked to have one.
  if (stage0.data.settings.audio === "music-and-effects") {
    gate.push(
      `odcinek deklaruje audio: ${stage0.data.settings.audio}, czyli bez mowy — etap 9 nie ma narracji do podniesienia`
    );
  }

  if (stage0.data.narratorVoiceId === null) {
    gate.push(
      `nikt nie obsadził narratora — wskaż głos przez: aimator project voice ${input.projectId} --voice-id <id>`
    );
  }

  const shotList = await readDigest(paths.data.episode.shotList);

  if (!shotList.ok) {
    gate.push(`brakuje ${relative(paths.data.episode.shotList)} — etap 9 nie ma z czego podnosić`);
  }

  const stage = await readJson(paths.data.episode.soundtrackStage, stageFileSchema);
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
    narratorVoiceId: stage0.data.narratorVoiceId,
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
    shotList: text,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
  });
}

/** One line as the mixer uses it: where the bytes are, and when they start. */
export interface PlacedLine {
  /** The second of *this track's* finished film the line begins at. */
  readonly atSeconds: number;
  readonly id: string;
  /** Absolute, for the muxer. */
  readonly path: string;
  /** What the plan said, before the track's own drift was applied. */
  readonly plannedSeconds: number;
  /** How long the bought recording runs. */
  readonly seconds: number;
}

interface TrackTimeline {
  /** How long this track's cut actually runs, read from its own boxes. */
  readonly actualSeconds: number;
  /** Why this track may not be mixed yet. Empty means it may. */
  readonly gate: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly paths: EpisodeTrackPaths;
  /** This track's own soundtrack stage file. */
  readonly stage: StageFile;
  /** The approved cut, absolute. */
  readonly video: string;
}

/**
 * This track's finished film, and whether stage 9 may lay anything over it.
 *
 * The gate is the assembly's approval, and nothing else: the entry frames, the
 * end frames and the clips were what stage 8 needed, not what this stage opens.
 */
export async function readTrackTimeline(
  input: Stage9Scope & { readonly track: ImageTrack },
  paths: Stage9Paths,
  aspectRatio: string
): Promise<Result<TrackTimeline>> {
  const track = episodeTrackPaths(paths.episode, input.track);
  const assembly = await readJson(track.assemblyStage, stageFileSchema);
  const stage = await readJson(track.soundtrackStage, stageFileSchema);
  const record = assembly.ok ? assembly.data.artifacts.episode : undefined;
  const cut = await readDigest(track.episodeVideo);
  const gate: string[] = [];

  if (record === undefined || record.status !== "completed") {
    gate.push(`nie ma zmontowanego odcinka na torze ${input.track} — etap 8 go nie ukończył`);
  }

  if (!cut.ok) {
    gate.push(`brakuje ${toWorkspacePath(input.workspace.root, track.episodeVideo)}`);

    return ok({
      actualSeconds: 0,
      gate,
      inputs: [],
      paths: track,
      stage: stage.ok ? stage.data : emptyStage(STAGE),
      video: track.episodeVideo,
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

  // Approval, not validation: a cut that merely exists is a cut nobody has
  // watched, and the whole stage sits downstream of a human saying yes.
  if (record !== undefined && record.review.status !== "approved") {
    gate.push(`zmontowany odcinek czeka na ocenę człowieka na torze ${input.track}`);
  }

  // The film's own length, read from its boxes. It is what the placement is
  // measured against, never the episode's declared duration: the clips drifted
  // and stage 8 cut what came back rather than trimming it.
  const verdict = validateVideo(cut.data.bytes, { aspectRatio, seconds: null });

  return ok({
    actualSeconds: verdict.ok ? verdict.data.seconds : 0,
    gate: verdict.ok
      ? gate
      : [
          ...gate,
          `odcinek na torze ${input.track} nie daje się odczytać: ${verdict.error.message}`,
        ],
    inputs: [recorded],
    paths: track,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
    video: track.episodeVideo,
  });
}

/**
 * A second of the approved plan, as a second of one track's finished film.
 *
 * The clips tile the plan without a gap and came back a little longer than they
 * were ordered, so the two timelines run at the same speed and drift apart at
 * every seam. Mapping one to the other is therefore not a scale factor: it is
 * "which clip is this second in, how far into it, and how much real time came
 * before that clip" — the same arithmetic stage 8 reports as drift, read in the
 * other direction.
 *
 * A second past the end of the plan maps to the end of the film. Nothing
 * upstream can produce one, because every anchor validated inside a shot.
 */
function resolveAnchor(
  plannedSeconds: number,
  clips: readonly { readonly actualSeconds: number; readonly end: number; readonly start: number }[]
): number {
  let elapsed = 0;

  for (const clip of clips) {
    if (plannedSeconds < clip.end) {
      const into = plannedSeconds - clip.start;

      // Within a clip the two run at the same rate; the fraction a renderer
      // leaves over sits at its end, not spread through it.
      return round(elapsed + Math.min(into, clip.actualSeconds));
    }

    elapsed += clip.actualSeconds;
  }

  return round(elapsed);
}

/** Seconds, to the thousandth — the precision an audio delay is spelled in. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Where each line lands on this track, and every reason it may not land there.
 *
 * Two refusals, and they are stage 7's rather than stage 8's, deliberately. The
 * bytes of a bought line are published exactly as they arrived — nothing here
 * stretches a reading, speeds one up or shortens a pause, because those are
 * bytes somebody paid for and altering them would be a quiet substitution. But
 * **where** a line sits comes from a plan a human approved, so a line that would
 * talk over the next one, or run past the end of the film, is refused and the
 * message names the remedy. The refusal costs nothing: the recordings stay, and
 * re-mixing after a fix is free.
 */
export function placeLines(input: {
  readonly actualSeconds: number;
  readonly clips: readonly { actualSeconds: number; end: number; start: number }[];
  readonly lines: readonly (NarrationLine & { readonly path: string; readonly seconds: number })[];
}): { placed: readonly PlacedLine[]; problems: readonly string[] } {
  const placed: PlacedLine[] = [];
  const problems: string[] = [];

  for (const line of input.lines) {
    const atSeconds = resolveAnchor(line.atSeconds, input.clips);
    const ends = round(atSeconds + line.seconds);
    const previous = placed.at(-1);

    if (previous !== undefined && atSeconds < round(previous.atSeconds + previous.seconds)) {
      problems.push(
        `${previous.id} kończy się w ${round(previous.atSeconds + previous.seconds)}s, a ${line.id} zaczyna w ${atSeconds}s — narrator mówiłby sam przez siebie; skróć wcześniejszą kwestię w skrypcie albo przesuń kotwicę późniejszej`
      );
    }

    if (ends > input.actualSeconds) {
      problems.push(
        `${line.id} kończy się w ${ends}s, a film trwa ${input.actualSeconds}s — kwestia nie mieści się w odcinku; skróć ją w skrypcie narracji albo przesuń jej kotwicę`
      );
    }

    placed.push({
      atSeconds,
      id: line.id,
      path: line.path,
      plannedSeconds: line.atSeconds,
      seconds: line.seconds,
    });
  }

  return { placed, problems };
}

/**
 * What the episode declared it would sound like, against what stage 9 can make.
 *
 * All four sound modes include music and effects. No model here writes either,
 * no variable names one and no command brings one in — so they are absent, and
 * rule 7 says an absence is reported rather than filled with a guess. Stated
 * the way stage 8 states silence and stage 2 states a missing alpha channel.
 */
export function missingSound(settings: EpisodeSettings): readonly string[] {
  return [
    `odcinek deklaruje audio: ${settings.audio}, co obejmuje muzykę i efekty — etap 9 produkuje samą narrację, a muzyki ani efektów nie wytwarza ani nie wnosi żaden etap tego potoku`,
  ];
}

/** The clips of the approved plan with the seconds each one actually runs. */
export async function readClipDrift(
  input: Stage9Scope & { readonly track: ImageTrack },
  paths: Stage9Paths,
  aspectRatio: string
): Promise<Result<readonly { actualSeconds: number; end: number; start: number }[]>> {
  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  if (plan.data.verdict === null) {
    return err(new Stage9BlockedError(["lista ujęć nie istnieje albo nie przechodzi walidacji"]));
  }

  const track = episodeTrackPaths(paths.episode, input.track);
  const drift: { actualSeconds: number; end: number; start: number }[] = [];

  for (const clip of plan.data.verdict.clips) {
    const file = clipVideo(track, clip.id);
    // biome-ignore lint/performance/noAwaitInLoops: one clip read at a time, in the plan's order
    const bytes = file.ok ? await readDigest(file.data) : null;
    const verdict =
      bytes?.ok === true
        ? validateVideo(bytes.data.bytes, { aspectRatio, seconds: clip.end - clip.start })
        : null;

    drift.push({
      // A clip that cannot be read falls back to what the plan ordered. The
      // gate has already refused the mix by then; this only keeps the
      // arithmetic total so the report can still be printed.
      actualSeconds: verdict?.ok === true ? verdict.data.seconds : clip.end - clip.start,
      end: clip.end,
      start: clip.start,
    });
  }

  return ok(drift);
}
