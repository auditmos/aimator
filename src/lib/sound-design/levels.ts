import { z } from "zod";
import {
  applyWrites,
  type RecordedFile,
  readDigest,
  readJson,
  serialize,
  toWorkspacePath,
  type WriteMode,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { projectPaths, type Workspace } from "../workspace.js";

/**
 * Internal to the sound-design module: how loud each thing sits, and how far
 * the music steps back under a voice.
 *
 * This file is `narration/delivery.ts` one row down, and it exists for the
 * same reason that one does: a knob somebody is expected to turn needs a place
 * to live, and **where a decision lives decides what changing it
 * invalidates**.
 *
 * It is not in `project.json`, for delivery's reason: stage 0's file is a
 * recorded input of nearly every artifact in the workspace, so nudging the
 * music down two decibels would lapse the approval on rendered clips and on a
 * cut episode whose bytes it never touched. And it is not in `narration.json`
 * either, which is the subtler half: that file is a recorded input of the
 * **bought recordings**, and how loud the bed sits under them has nothing to
 * do with how they were read. Changing the mix must not lapse a recording.
 * Two knobs, two scopes, two files.
 *
 * **Why defaults are allowed here**, when rule 7 says a decision with no
 * default is stored and never inferred. Delivery could point at the provider's
 * own documented defaults; there is no provider here, so that argument is not
 * available and it is worth saying so rather than borrowing it. The one that
 * does apply is different: **this decision cannot be made before it is
 * heard.** Refusing the first mix until somebody dials a number would demand
 * an answer nobody is in a position to form, and a mix costs nothing to redo.
 * So these are a starting point rather than an answer, and, exactly as
 * delivery does; they are sent **explicitly** on every invocation, so the run
 * archive states what produced these bytes instead of leaving a reader to
 * guess what the defaults were that month.
 */

/**
 * Where a mix starts before anybody has heard it.
 *
 * Decibels relative to each stem as it was bought. The bed sits well under a
 * voice, effects sit closer to the front because they are meant to be noticed,
 * and the duck is how much further the bed drops while somebody is speaking.
 */
const DEFAULT_LEVELS = {
  duckDb: -9,
  /** How long the bed takes to come back up after a line ends, in milliseconds. */
  duckReleaseMs: 400,
  effectsDb: -10,
  musicDb: -18,
} as const;

export interface MixLevels {
  readonly duckDb: number;
  readonly duckReleaseMs: number;
  readonly effectsDb: number;
  readonly musicDb: number;
}

const levelsSchema = z.object({
  levels: z
    .object({
      duckDb: z.number().min(-60).max(0).default(DEFAULT_LEVELS.duckDb),
      duckReleaseMs: z.number().min(10).max(5000).default(DEFAULT_LEVELS.duckReleaseMs),
      effectsDb: z.number().min(-60).max(12).default(DEFAULT_LEVELS.effectsDb),
      musicDb: z.number().min(-60).max(12).default(DEFAULT_LEVELS.musicDb),
    })
    .default(DEFAULT_LEVELS),
  schemaVersion: z.literal(1).default(1),
});

interface MixDirection {
  /**
   * The file as a recorded input, or `null` when there is none.
   *
   * Null rather than a digest of the defaults: a project that never decided
   * has nothing to record, and inventing an entry would make an undecided mix
   * indistinguishable from one somebody chose to leave where it was.
   */
  readonly input: RecordedFile | null;
  /** How the mix sits, or the starting point when nobody has decided. */
  readonly levels: MixLevels;
}

interface SetLevelsInput {
  readonly duckDb: number | null;
  readonly duckReleaseMs: number | null;
  readonly effectsDb: number | null;
  readonly mode: WriteMode;
  readonly musicDb: number | null;
  readonly projectId: string;
  readonly workspace: Workspace;
}

export interface LevelsReport {
  readonly created: readonly string[];
  readonly levels: MixLevels;
  readonly nextStep: string;
  readonly problems: readonly string[];
}

class LevelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LevelsError";
  }
}

/** How this series is mixed, and how to record that it was mixed this way. */
export async function readLevels(input: {
  readonly projectId: string;
  readonly workspace: Workspace;
}): Promise<Result<MixDirection>> {
  const paths = projectPaths(input.workspace, input.projectId);

  if (!paths.ok) {
    return paths;
  }

  const digest = await readDigest(paths.data.mix);

  if (!digest.ok) {
    return ok({ input: null, levels: DEFAULT_LEVELS });
  }

  const parsed = await readJson(paths.data.mix, levelsSchema);

  if (!parsed.ok) {
    return err(
      new LevelsError(
        `mix.json nie daje się odczytać: ${parsed.error.message}, popraw plik albo usuń go, żeby wrócić do wartości startowych`
      )
    );
  }

  return ok({
    input: {
      path: toWorkspacePath(input.workspace.root, paths.data.mix),
      sha256: digest.data.sha256,
    },
    levels: parsed.data.levels,
  });
}

/**
 * Records how this series is mixed, merging over whatever was decided before.
 *
 * Merged rather than replaced, for delivery's reason: these are independent
 * decisions and a command that reset the ones it was not given would undo a
 * choice nobody revisited. `--music-db` alone means the music level.
 */
export async function setLevels(input: SetLevelsInput): Promise<Result<LevelsReport>> {
  const paths = projectPaths(input.workspace, input.projectId);

  if (!paths.ok) {
    return paths;
  }

  const current = await readLevels(input);

  if (!current.ok) {
    return current;
  }

  const levels: MixLevels = {
    duckDb: input.duckDb ?? current.data.levels.duckDb,
    duckReleaseMs: input.duckReleaseMs ?? current.data.levels.duckReleaseMs,
    effectsDb: input.effectsDb ?? current.data.levels.effectsDb,
    musicDb: input.musicDb ?? current.data.levels.musicDb,
  };
  const parsed = levelsSchema.safeParse({ levels, schemaVersion: 1 });

  if (!parsed.success) {
    return err(
      new LevelsError(
        `poza zakresem: ${parsed.error.issues.map((one) => `${one.path.join(".")} ${one.message}`).join("; ")}`
      )
    );
  }

  const written = await applyWrites(
    [{ kind: "text", text: serialize(parsed.data), to: paths.data.mix }],
    input.mode
  );

  return written.ok
    ? ok({
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        levels,
        nextStep: `aimator check ${input.projectId}`,
        // Said plainly rather than left to be discovered, but note what is
        // *not* said: no bought stem and no bought line is affected, because
        // this file is a recorded input of the mix alone. That is the whole
        // reason it is not inside `narration.json`.
        problems: [
          "miksy zrobione przed tą zmianą brzmią inaczej, check zgłosi je jako nieaktualne; ponowny miks nic nie kosztuje i niczego nie dokupuje",
        ],
      })
    : written;
}
