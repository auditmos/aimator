import {
  applyWrites,
  localProducer,
  newRecord,
  newRunId,
  nowIso,
  type RecordedFile,
  readDigest,
  removeFile,
  type StageFile,
  serialize,
  toWorkspacePath,
  type WriteMode,
} from "../artifact/index.js";
import { checksFlag } from "../checklist.js";
import { readAcceptedDialogue } from "../dialogue/index.js";
import type { MasterInput, Muxer } from "../muxer.js";
import { err, ok, type Result } from "../result.js";
import { placeStems } from "../sound-design/index.js";
import { type PlanClock, placeSpeech, readPlanClock } from "../timeline.js";
import { hasSound, validateVideo } from "../video-model/index.js";
import {
  assemblyRunPaths,
  clipVideo,
  type EpisodeTrackPaths,
  mixRunPaths,
  versionClip,
  versionFilm,
} from "../workspace.js";
import {
  holdingLock,
  readSourceClip,
  readStage12,
  STAGE,
  type Stage12,
  Stage12BlockedError,
  type Stage12Scope,
} from "./plan.js";
import { checkVersions, type FinalFilm, type VersionsStatus } from "./review.js";

/**
 * Internal to the versions module: the two finished films of one track.
 *
 * It buys nothing. Both films are built by the local engine out of what the
 * stages above already accepted: one picture, the lip-synced clips in place of
 * the clips they replace, and over it the lines of one language beside the
 * same music and effects. The language of the mouths gets its translated
 * lines; the film's language gets its own, which is classic dubbing: the
 * mouths match the other one.
 *
 * **The picture is made once and shared.** It is cut again only when a clip it
 * was cut from has changed, so the two films are laid over the same bytes, and
 * a film whose picture moved lapses with it. It carries no yes of its own:
 * nobody watches a silent cut, they watch the films.
 *
 * **`--regenerate` guards an approval, not a wallet**, stage 8's reading: a
 * finished film is left alone unless asked for again, and the one it replaces
 * is copied into the archive first, so a failed attempt puts back the film a
 * person may already have accepted.
 */

/** The record key of the picture both films share. It names the film, not the making of it. */
const PICTURE = "episode";

type FinalInput = Stage12Scope & {
  /** Which of the two films: the language of the mouths, or the film's own. */
  readonly language: string;
  readonly mode: WriteMode;
  /** The local engine, injected exactly as `fetch` is in a paid stage. */
  readonly mux: Muxer;
  readonly regenerate: boolean;
};

/** One sound of a film, where it lands on the picture. */
interface FilmSound {
  /** The second of the picture it begins at. */
  readonly atSeconds: number;
  readonly id: string;
  readonly kind: "effect" | "music" | "speech";
  /** Absolute, for the engine. */
  readonly path: string;
  /** What the plan said, before the picture's own drift was applied. */
  readonly plannedSeconds: number;
  readonly seconds: number;
}

export interface FinalReport {
  /** How long the picture runs: its clips as they came back. */
  readonly actualSeconds: number;
  readonly created: readonly string[];
  /** The local engine, once it has answered; null when it could not be asked. */
  readonly engine: string | null;
  readonly language: string;
  /** How the stems sit, sent explicitly; null while the stage is gated. */
  readonly levels: MasterInput["levels"] | null;
  readonly nextStep: string;
  /** What is said without refusing: a bed that stops short of the film. */
  readonly notices: readonly string[];
  /** The picture's clips in the plan's order: lip-synced, or stage 7's as it is. */
  readonly picture: readonly { readonly id: string; readonly source: "clips" | "lip-sync" }[];
  readonly problems: readonly string[];
  readonly sounds: readonly Omit<FilmSound, "path">[];
  readonly state: "blocked" | "planned" | "published" | "skipped";
}

/** One clip of the picture: the file in its place, and its bytes as they are now. */
interface PictureClip {
  readonly id: string;
  /** What a stream copy has to agree on, as a person reads it: `1920x1080, hvc1, 24 kl./s`. */
  readonly parameters: string | null;
  readonly path: string;
  readonly recorded: RecordedFile | null;
  readonly source: "clips" | "lip-sync";
}

/** The picture as it would be cut now: its clips in order, their clock and their length. */
interface Picture {
  readonly clips: readonly PictureClip[];
  readonly clock: PlanClock;
  readonly seconds: number;
}

function finalCommand(input: FinalInput): string {
  return `aimator versions final ${input.projectId} ${input.episodeId} --track ${input.track} --language ${input.language}`;
}

/** The command that records a yes on this film, with the checklist it is given against. */
function approveHint(input: FinalInput, film: FinalFilm | undefined): string {
  return `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track} --artifact ${input.language}${checksFlag(film?.checks ?? [])}`;
}

/** Where a person goes from a film that is already there. */
function afterwards(input: FinalInput, film: FinalFilm | undefined): string {
  if (film?.approved === true) {
    return `film ${input.language} na torze ${input.track} jest przyjęty`;
  }

  return (film?.inputsChanged.length ?? 0) > 0
    ? `${finalCommand(input)} --regenerate`
    : approveHint(input, film);
}

/** Each clip whose mouths move, and the file that stands in its place: its lip-synced version. */
function replacements(stage12: Stage12): Result<Record<string, string>> {
  const replaced: Record<string, string> = {};

  for (const target of stage12.targets) {
    const file = versionClip(stage12.paths.track, target.id);

    if (!file.ok) {
      return file;
    }

    replaced[target.id] = file.data;
  }

  return ok(replaced);
}

/** What a stream copy has to agree on, as a person reads it; null for bytes that are no MP4. */
function parametersOf(bytes: Buffer): string | null {
  const verdict = validateVideo(bytes, { aspectRatio: null, seconds: null });

  if (!verdict.ok) {
    return null;
  }

  const { codec, frameRate, height, width } = verdict.data;
  const rate = frameRate === null ? "tempo nieznane" : `${frameRate} kl./s`;

  return `${width}x${height}, ${codec ?? "kodek nieznany"}, ${rate}`;
}

/** Every clip in the plan's order: the lip-synced version where a face moved, stage 7's elsewhere. */
async function readPicture(input: FinalInput, stage12: Stage12): Promise<Result<Picture>> {
  const replaced = replacements(stage12);

  if (!replaced.ok) {
    return replaced;
  }

  const clock = await readPlanClock({
    ...input,
    aspectRatio: stage12.aspectRatio,
    replaced: replaced.data,
  });

  if (!clock.ok) {
    return clock;
  }

  const clips: PictureClip[] = [];

  for (const clip of clock.data.drift) {
    const swapped = replaced.data[clip.id];
    const file = swapped === undefined ? clipVideo(stage12.paths.track, clip.id) : ok(swapped);

    if (!file.ok) {
      return file;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one clip read at a time, in the plan's order
    const bytes = await readDigest(file.data);

    clips.push({
      id: clip.id,
      parameters: bytes.ok ? parametersOf(bytes.data.bytes) : null,
      path: file.data,
      recorded: bytes.ok
        ? { path: toWorkspacePath(input.workspace.root, file.data), sha256: bytes.data.sha256 }
        : null,
      source: swapped === undefined ? "clips" : "lip-sync",
    });
  }

  return ok({
    clips,
    clock: clock.data,
    seconds: round(clock.data.drift.reduce((total, one) => total + one.actualSeconds, 0)),
  });
}

/** Why the film may not be made: a clip's version, or a stage-7 clip, nobody accepted. */
async function clipProblems(
  input: FinalInput,
  stage12: Stage12,
  status: VersionsStatus
): Promise<Result<string[]>> {
  const problems = status.clips
    .filter((clip) => !clip.approved)
    .map(
      (clip) =>
        `${clip.id}: klip wymaga lip-syncu, a jego wersja nie ma ważnej zgody: aimator check ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`
    );

  for (const id of stage12.untouched) {
    // biome-ignore lint/performance/noAwaitInLoops: one clip at a time, in the plan's order
    const source = await readSourceClip(input, stage12, id);

    if (!source.ok) {
      return source;
    }

    problems.push(...source.data.problems);
  }

  return ok(problems);
}

/**
 * Why the clips may not be cut into one picture: a stream copy holds only while
 * every clip shares a frame, a codec and a frame rate, and a lip-synced clip
 * is the provider's re-encode of the clip it replaces, which promises none of
 * them. Stage 8 can read the same promise off the model that rendered each
 * clip; here every clip in the swap has another model by construction, so the
 * parameters are read off the bytes. Refused before the engine runs, because a
 * copy across them is a broken film or an error far from its cause, and a
 * re-encode would put frames into the film that nobody accepted.
 */
function parameterProblems(input: FinalInput, picture: Picture): readonly string[] {
  const groups = new Map<string, string[]>();

  for (const clip of picture.clips.filter((one) => one.parameters !== null)) {
    const key = clip.parameters ?? "";

    groups.set(key, [...(groups.get(key) ?? []), clip.id]);
  }

  return groups.size < 2
    ? []
    : [
        `klipy obrazu wersji na torze ${input.track} różnią się parametrami: ${[...groups.entries()].map(([parameters, ids]) => `${ids.join(", ")} (${parameters})`).join("; ")}; obraz jest kopią strumieni, więc wymaga jednego kadru, kodeka i tempa klatek, a etap 12 niczego nie przekodowuje`,
      ];
}

/**
 * Two utterances heard at once, or one that runs past the film, refused rather
 * than moved: the recordings are bytes somebody accepted. The arithmetic is
 * `lib/timeline`'s, on the picture's own clock; the remedy is this film's
 * language's, because the line too long was written in a different place: the
 * translation for the language of the mouths, the script for the film's own.
 */
function placementProblems(
  input: FinalInput,
  stage12: Stage12,
  picture: Picture,
  lines: readonly { atSeconds: number; id: string; seconds: number }[]
): readonly string[] {
  const scope = `${input.projectId} ${input.episodeId}`;
  const where =
    input.language === stage12.language
      ? `w przekładzie i kup od nowa: aimator dialogue translate ${scope} --regenerate --instruction <uwaga>`
      : "tam, gdzie powstała (scenariusz, etap 1), albo przesuń kotwicę w skrypcie dialogu";
  const spoken = placeSpeech({
    actualSeconds: picture.seconds,
    clock: picture.clock,
    speech: lines,
  });

  return [
    ...spoken.overlaps.map(
      ({ earlier, later }) =>
        `${earlier.id} kończy się w ${earlier.ends}s, a ${later.id} zaczyna w ${later.atSeconds}s, dwie wypowiedzi brzmiałyby naraz w filmie ${input.language}; skróć wcześniejszą ${where}`
    ),
    ...spoken.overruns.map(
      (one) =>
        `${one.id} kończy się w ${one.ends}s, a film trwa ${picture.seconds}s, wypowiedź nie mieści się w filmie ${input.language}; skróć ją ${where}`
    ),
  ];
}

/** A report of a stage that has not opened: its gate, and nothing read beyond it. */
function gated(input: FinalInput, gate: readonly string[]): FinalReport {
  return {
    actualSeconds: 0,
    created: [],
    engine: null,
    language: input.language,
    levels: null,
    nextStep: gate[0] ?? "",
    notices: [],
    picture: [],
    problems: gate,
    sounds: [],
    state: "blocked",
  };
}

/** Everything one film is made of, read once, and every reason it may not be made yet. */
interface Film {
  /** Its state in `check`, with the checklist its yes is given against; undefined while gated. */
  readonly film: FinalFilm | undefined;
  /** The lines, the stems and `mix.json`: what the film records beside its picture. */
  readonly inputs: readonly RecordedFile[];
  readonly levels: MasterInput["levels"];
  readonly notices: readonly string[];
  readonly picture: Picture;
  readonly problems: readonly string[];
  readonly sounds: readonly FilmSound[];
  readonly target: string;
}

/** The clips, the picture, the stems and the lines of one film, each through its own stage's entry. */
async function readFilm(input: FinalInput, stage12: Stage12): Promise<Result<Film>> {
  const status = await checkVersions(input);

  if (!status.ok) {
    return status;
  }

  const clips = await clipProblems(input, stage12, status.data);
  const picture = await readPicture(input, stage12);
  const speech = await readAcceptedDialogue({ ...input, language: input.language });
  const target = versionFilm(stage12.paths.track, input.language);

  if (!clips.ok) {
    return clips;
  }
  if (!picture.ok) {
    return picture;
  }
  if (!speech.ok) {
    return speech;
  }
  if (!target.ok) {
    return target;
  }

  const stems = await placeStems({
    ...input,
    actualSeconds: picture.data.seconds,
    clock: picture.data.clock,
  });

  if (!stems.ok) {
    return stems;
  }

  return ok({
    film: status.data.finals.find((one) => one.id === input.language),
    inputs: [...speech.data.inputs, ...stems.data.inputs],
    levels: stems.data.levels,
    notices: stems.data.notices,
    picture: picture.data,
    problems: [
      ...clips.data,
      ...parameterProblems(input, picture.data),
      ...speech.data.gate,
      ...placementProblems(input, stage12, picture.data, speech.data.lines),
      ...stems.data.problems,
    ],
    sounds: [
      ...speech.data.lines.map((line) => ({
        atSeconds: picture.data.clock.at(line.atSeconds),
        id: line.id,
        kind: "speech" as const,
        path: line.path,
        plannedSeconds: line.atSeconds,
        seconds: line.seconds,
      })),
      ...stems.data.placed,
    ],
    target: target.data,
  });
}

/**
 * Builds one of the two films, or says everything that stands in its way. A
 * dry run states the cut, every sound and where it lands, and the obstacles,
 * and asks the engine nothing but its name.
 */
export async function generateFinal(input: FinalInput): Promise<Result<FinalReport>> {
  const stage12 = await readStage12(input);

  if (!stage12.ok) {
    return stage12;
  }

  const { filmLanguage, gate, language } = stage12.data;

  if (gate.length > 0) {
    return input.mode === "dry-run" ? ok(gated(input, gate)) : err(new Stage12BlockedError(gate));
  }

  // A language outside the two makes every other answer meaningless, so it is
  // refused alone, before anything is read for a film nobody could make.
  if (input.language !== language && input.language !== filmLanguage) {
    return err(
      new Stage12BlockedError([
        `--language "${input.language}", odcinek ma wersje: ${language}, ${filmLanguage}`,
      ])
    );
  }

  const read = await readFilm(input, stage12.data);

  if (!read.ok) {
    return read;
  }

  const engine = await input.mux.version();
  const { film, picture } = read.data;
  const problems = [...read.data.problems, ...(engine.ok ? [] : [engine.error.message])];
  const finished = film?.state === "completed" && !input.regenerate;
  const report = {
    actualSeconds: picture.seconds,
    created: [],
    engine: engine.ok ? engine.data : null,
    language: input.language,
    levels: read.data.levels,
    notices: read.data.notices,
    picture: picture.clips.map(({ id, source }) => ({ id, source })),
    sounds: read.data.sounds.map(({ path: _path, ...sound }) => sound),
  };

  if (input.mode === "dry-run") {
    const state = finished ? "skipped" : "planned";

    return ok({
      ...report,
      nextStep: problems[0] ?? (finished ? afterwards(input, film) : finalCommand(input)),
      problems,
      state: problems.length > 0 ? "blocked" : state,
    });
  }

  if (problems.length > 0) {
    return err(new Stage12BlockedError(problems));
  }

  if (finished) {
    return ok({ ...report, nextStep: afterwards(input, film), problems: [], state: "skipped" });
  }

  return await holdingLock(
    stage12.data.paths.track.versionsLock,
    async (): Promise<Result<FinalReport>> => {
      const cut = await cutPicture(input, stage12.data, picture);

      if (!cut.ok) {
        return cut;
      }

      const laid = await layFilm(input, {
        ...read.data,
        picture: cut.data,
        ratio: stage12.data.aspectRatio,
        seconds: picture.seconds,
        track: stage12.data.paths.track,
      });

      return laid.ok
        ? ok({
            ...report,
            created: [...cut.data.created, ...laid.data],
            nextStep: approveHint(input, film),
            problems: [],
            state: "published",
          })
        : laid;
    }
  );
}

/** The picture as a film is laid over it: its file, its record and what it was cut from. */
interface CutPicture {
  readonly created: readonly string[];
  /** Its clips, by digest: inputs of every film laid over it, so a moved clip lapses them. */
  readonly inputs: readonly RecordedFile[];
  readonly output: RecordedFile;
  readonly path: string;
  readonly stage: StageFile;
}

/**
 * The picture, cut again only when a clip it was cut from has changed.
 *
 * Nothing about it is anybody's yes, so cutting it again needs no
 * `--regenerate`; what it must not do is cut a second, different picture
 * under a film that was laid over the first one, and it does not: a film
 * records the picture's digest and its clips', so a new picture lapses it
 * rather than hiding under it.
 */
async function cutPicture(
  input: FinalInput,
  stage12: Stage12,
  picture: Picture
): Promise<Result<CutPicture>> {
  const target = stage12.paths.track.versionsPicture;
  const inputs = picture.clips.flatMap((one) => (one.recorded === null ? [] : [one.recorded]));
  const record = stage12.stage.artifacts[PICTURE];
  const now = await readDigest(target);
  const [published] = record?.outputs ?? [];
  const current =
    record?.status === "completed" &&
    now.ok &&
    published?.sha256 === now.data.sha256 &&
    record.inputs.length === inputs.length &&
    record.inputs.every((entry) =>
      inputs.some((one) => one.path === entry.path && one.sha256 === entry.sha256)
    );

  if (current && published !== undefined) {
    return ok({ created: [], inputs, output: published, path: target, stage: stage12.stage });
  }

  const runId = newRunId();
  const run = assemblyRunPaths(stage12.paths.track, runId);
  const cut = await input.mux.picture({
    clips: picture.clips.map((one) => one.path),
    listPath: run.list,
    target,
  });

  if (!cut.ok) {
    await removeFile(target);

    return cut;
  }

  const bytes = await readDigest(target);

  if (!bytes.ok) {
    return bytes;
  }

  // The verdict is against the clips this was cut from, never the plan: they
  // drifted, and the picture is what came back.
  const verdict = validateVideo(bytes.data.bytes, {
    aspectRatio: stage12.aspectRatio,
    seconds: picture.seconds,
  });

  if (!verdict.ok) {
    await removeFile(target);

    return err(
      new Stage12BlockedError([
        `obraz wersji nie zgadza się z klipami, z których powstał: ${verdict.error.message}`,
        "nic nie opublikowano; obraz nic nie kosztuje, więc poprawka i powtórzenie są darmowe",
      ])
    );
  }

  const output: RecordedFile = {
    path: toWorkspacePath(input.workspace.root, target),
    sha256: bytes.data.sha256,
  };
  const stage: StageFile = {
    ...stage12.stage,
    artifacts: {
      ...stage12.stage.artifacts,
      [PICTURE]: newRecord({
        inputs,
        outputs: [output],
        producer: localProducer(cut.data.engine),
        runId,
      }),
    },
  };
  const written = await applyWrites(
    [
      {
        kind: "text",
        text: serialize({ inputs, outputs: [output], runId, stage: STAGE, startedAt: nowIso() }),
        to: run.run,
      },
      {
        kind: "text",
        text: serialize({ argv: cut.data.argv, engine: cut.data.engine, stderr: cut.data.stderr }),
        to: run.transport,
      },
      { kind: "text", text: serialize(verdict.data), to: run.validation },
      { kind: "text", text: serialize(stage), to: stage12.paths.track.versionsStage },
    ],
    input.mode
  );

  return written.ok
    ? ok({ created: [target, ...written.data], inputs, output, path: target, stage })
    : written;
}

/** One language's film over the shared picture: the stems and the lines, encoded once. */
async function layFilm(
  input: FinalInput,
  film: {
    /** The lines, the stems and `mix.json`, as stages 10 and 11 recorded them. */
    readonly inputs: readonly RecordedFile[];
    readonly levels: MasterInput["levels"];
    readonly picture: CutPicture;
    readonly ratio: string;
    readonly seconds: number;
    readonly sounds: readonly FilmSound[];
    readonly target: string;
    readonly track: EpisodeTrackPaths;
  }
): Promise<Result<readonly string[]>> {
  const runId = newRunId();
  const run = mixRunPaths(film.track, runId);
  const created: string[] = [];
  const of = (kind: FilmSound["kind"]) =>
    film.sounds
      .filter((sound) => sound.kind === kind)
      .map((sound) => ({ atSeconds: sound.atSeconds, path: sound.path }));

  // The film being replaced is copied out first, so a failed attempt can put
  // back the one a person may already have accepted.
  if (input.regenerate) {
    const preserved = await applyWrites(
      [{ from: film.target, kind: "copy", to: run.previousVideo }],
      input.mode
    );

    if (preserved.ok) {
      created.push(...preserved.data);
    }
  }

  const muxed = await input.mux.master({
    effects: of("effect"),
    levels: film.levels,
    music: of("music"),
    speech: of("speech"),
    target: film.target,
    video: film.picture.path,
  });

  if (!muxed.ok) {
    await restore(run.previousVideo, film.target, input.regenerate);

    return muxed;
  }

  const bytes = await readDigest(film.target);

  if (!bytes.ok) {
    return bytes;
  }

  const verdict = validateVideo(bytes.data.bytes, {
    aspectRatio: film.ratio,
    seconds: film.seconds,
  });

  if (!(verdict.ok && hasSound(bytes.data.bytes))) {
    await restore(run.previousVideo, film.target, input.regenerate);

    return err(
      new Stage12BlockedError([
        verdict.ok
          ? `film ${input.language} nie niesie ścieżki dźwiękowej`
          : `film ${input.language} nie zgadza się z obrazem, z którego powstał: ${verdict.error.message}`,
        "nic nie opublikowano; film nic nie kosztuje, więc poprawka i powtórzenie są darmowe",
      ])
    );
  }

  const inputs = [film.picture.output, ...film.picture.inputs, ...film.inputs];
  const output: RecordedFile = {
    path: toWorkspacePath(input.workspace.root, film.target),
    sha256: bytes.data.sha256,
  };
  const stage: StageFile = {
    ...film.picture.stage,
    artifacts: {
      ...film.picture.stage.artifacts,
      [input.language]: newRecord({
        inputs,
        outputs: [output],
        producer: localProducer(muxed.data.engine),
        runId,
      }),
    },
  };
  const written = await applyWrites(
    [
      {
        kind: "text",
        text: serialize({ inputs, outputs: [output], runId, stage: STAGE, startedAt: nowIso() }),
        to: run.run,
      },
      {
        kind: "text",
        text: serialize({
          argv: muxed.data.argv,
          engine: muxed.data.engine,
          // Sent explicitly on every invocation, so this file answers what
          // produced these bytes rather than deferring to a default.
          levels: film.levels,
          stderr: muxed.data.stderr,
        }),
        to: run.transport,
      },
      { kind: "text", text: serialize(film.sounds), to: run.placement },
      { kind: "text", text: serialize(verdict.data), to: run.validation },
      { kind: "text", text: serialize(stage), to: film.track.versionsStage },
    ],
    input.mode
  );

  return written.ok ? ok([...created, film.target, ...written.data]) : written;
}

/** Puts back the film a person may have accepted, when there was one to put back. */
async function restore(previous: string, target: string, regenerated: boolean): Promise<void> {
  await removeFile(target);

  if (regenerated) {
    await applyWrites([{ from: previous, kind: "copy", to: target }], "apply");
  }
}

/** Seconds, to the hundredth, the precision a movie header actually carries. */
function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}
