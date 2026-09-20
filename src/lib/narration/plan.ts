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
import { ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import type { PlanClock } from "../timeline.js";
import { validateVideo } from "../video-model/index.js";
import { validateSpeech } from "../voice-model/index.js";
import {
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  narrationAudio,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { buildPrompt } from "./prompt.js";
import { type NarrationLine, validateNarration } from "./validate.js";

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

/** One accepted line: the sentence, its anchor in the plan, and its bytes. */
interface AcceptedLine {
  /** Where the plan puts it, before any track's drift is applied. */
  readonly atSeconds: number;
  readonly characters: number;
  readonly id: string;
  /** Absolute, for a mixer. */
  readonly path: string;
  /** How long the bought recording runs, from its own header. */
  readonly seconds: number;
  readonly shot: string;
  readonly text: string;
}

interface AcceptedLines {
  /** Why these lines may not be laid down yet. Empty means they may. */
  readonly gate: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly lines: readonly AcceptedLine[];
}

/**
 * Every line of the approved script, with the recording somebody accepted.
 *
 * The gate is per utterance and it is approval rather than existence: a
 * recording that merely exists is one nobody has listened to, and every stage
 * that lays these down sits downstream of a human saying yes.
 *
 * It is **exported** because stage 10 mixes the same recordings into the full
 * soundtrack and would otherwise have to ask the same seven questions of the
 * same files. That is a stage consuming an earlier stage's artifact through
 * its public entry, which is the ordinary direction — the alternative was a
 * second copy of this function inside stage 10, reaching into what stage 9
 * knows about its own lines.
 */
export async function readAcceptedLines(input: Stage9Scope): Promise<Result<AcceptedLines>> {
  const stage9 = await readStage9Inputs(input);

  if (!stage9.ok) {
    return stage9;
  }

  const script = await readDigest(stage9.data.paths.episode.narrationScript);
  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  // An absent script is an obstacle, not a failure: `--dry-run` has to be able
  // to report it beside the others rather than die on it, which is what every
  // gate in this pipeline promises.
  if (!script.ok || plan.data.verdict === null) {
    return ok({
      gate: ["nie ma skryptu narracji — uruchom najpierw: narration generate"],
      inputs: [],
      lines: [],
    });
  }

  const verdict = validateNarration({
    shotList: plan.data.verdict,
    text: script.data.bytes.toString("utf8"),
  });

  if (!verdict.ok) {
    return ok({ gate: [verdict.error.message], inputs: [], lines: [] });
  }

  const gate: string[] = [];
  const inputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, stage9.data.paths.episode.narrationScript),
      sha256: script.data.sha256,
    },
  ];

  if (stage9.data.stage.artifacts[SCRIPT]?.review.status !== "approved") {
    gate.push("skrypt narracji czeka na ocenę człowieka");
  }

  const lines: AcceptedLine[] = [];

  for (const line of verdict.data.lines) {
    const file = narrationAudio(stage9.data.paths.episode, line.id);

    if (!file.ok) {
      return file;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one line read at a time, in the script's order
    const bytes = await readDigest(file.data);
    const record = stage9.data.stage.artifacts[line.id];

    if (!bytes.ok || record?.status !== "completed") {
      gate.push(`${line.id}: nie ma nagrania — kwestia nie została kupiona`);
      continue;
    }

    const recorded = {
      path: toWorkspacePath(input.workspace.root, file.data),
      sha256: bytes.data.sha256,
    };
    const output = record.outputs.find((one) => one.path === recorded.path);

    if (output === undefined || output.sha256 !== recorded.sha256) {
      gate.push(`${line.id}: bajty nagrania nie zgadzają się z jego rekordem`);
    }

    if (record.review.status !== "approved") {
      gate.push(`${line.id}: nagranie czeka na ocenę człowieka`);
    }

    const speech = validateSpeech(bytes.data.bytes);

    if (!speech.ok) {
      gate.push(`${line.id}: ${speech.error.message}`);
      continue;
    }

    inputs.push(recorded);
    lines.push({ ...line, path: file.data, seconds: speech.data.seconds });
  }

  if (lines.length === 0) {
    gate.push("żadna kwestia nie jest gotowa — nie ma czego położyć na obrazie");
  }

  return ok({ gate, inputs, lines });
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
  /** The plan's clock as this track's, from `lib/timeline`. */
  readonly clock: PlanClock;
  readonly lines: readonly (NarrationLine & { readonly path: string; readonly seconds: number })[];
}): { placed: readonly PlacedLine[]; problems: readonly string[] } {
  const placed: PlacedLine[] = [];
  const problems: string[] = [];

  for (const line of input.lines) {
    const atSeconds = input.clock.at(line.atSeconds);
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
