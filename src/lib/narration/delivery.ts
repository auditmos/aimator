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
import { DEFAULT_DELIVERY, type SpeechDelivery } from "../voice-model/index.js";
import { projectPaths, type Workspace } from "../workspace.js";

/**
 * Internal to the narration module: how the narrator of this series performs.
 *
 * This file exists because of a bug that was not a bug in any line of code.
 * Stage 9 had nowhere to say how the narrator reads, so every call went out on
 * the provider's defaults — and those defaults are `stability: 0.5` with
 * `style: 0`, which the provider itself describes as trending monotone. The
 * result sounded flat, and no amount of re-buying would have changed it,
 * because nothing in the pipeline was ever asked the question. A missing
 * decision is not a missing number; it is a missing place to put one.
 *
 * **Why it is a file of its own, beside `project.json` rather than inside it.**
 * A reading recurs between episodes exactly as a cast does, so it belongs at
 * the project level — but `project.json` is stage 0's, and stage 0 is a
 * recorded input of nearly every artifact this pipeline makes. Putting a knob
 * somebody is expected to turn into that file would mean that nudging the
 * narrator's warmth lapses the approval on a rendered clip and on a cut
 * episode. The bytes those approvals were given for would not have changed by
 * one bit. Here the file is a recorded input of the bought recordings and of
 * nothing else, so a change lapses exactly what it actually produced.
 *
 * The seam is real rather than convenient: **the voice is casting** and lives
 * with the cast, in stage 0; **the reading is direction** and lives with the
 * stage that is the only one able to hear it.
 *
 * **Why defaults are allowed here** when rule 7 says a decision with no default
 * is stored and never inferred. These five have defaults — the provider's own,
 * documented on the endpoint — so an absent file is not an unanswered question
 * standing in for an answer. It is the same reading that lets `AIMATOR_FFMPEG`
 * be optional. What the stage does *not* do is stay silent: it sends the values
 * explicitly on every call, so the request archive states what produced the
 * bytes instead of leaving a reader to look up what the defaults were that
 * month.
 */

const deliverySchema = z.object({
  delivery: z
    .object({
      similarityBoost: z.number().min(0).max(1).default(DEFAULT_DELIVERY.similarityBoost),
      speakerBoost: z.boolean().default(DEFAULT_DELIVERY.speakerBoost),
      speed: z.number().min(0.7).max(1.2).default(DEFAULT_DELIVERY.speed),
      stability: z.number().min(0).max(1).default(DEFAULT_DELIVERY.stability),
      style: z.number().min(0).max(1).default(DEFAULT_DELIVERY.style),
    })
    .default(DEFAULT_DELIVERY),
  schemaVersion: z.literal(1).default(1),
});

interface NarrationDirection {
  /** How the narrator performs, or the provider's defaults when nobody decided. */
  readonly delivery: SpeechDelivery;
  /**
   * The file as a recorded input, or `null` when there is none.
   *
   * Null rather than a digest of the defaults: a project that never decided has
   * nothing to record, and inventing an entry would make an undecided reading
   * indistinguishable from one somebody chose to leave at 0.5.
   */
  readonly input: RecordedFile | null;
}

interface SetDeliveryInput {
  readonly mode: WriteMode;
  readonly projectId: string;
  readonly similarityBoost: number | null;
  readonly speakerBoost: boolean | null;
  readonly speed: number | null;
  readonly stability: number | null;
  readonly style: number | null;
  readonly workspace: Workspace;
}

export interface DirectionReport {
  readonly created: readonly string[];
  readonly delivery: SpeechDelivery;
  readonly nextStep: string;
  readonly problems: readonly string[];
}

class DirectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectionError";
  }
}

/** What the narrator's reading is, and how to record that it was this one. */
export async function readDirection(input: {
  readonly projectId: string;
  readonly workspace: Workspace;
}): Promise<Result<NarrationDirection>> {
  const paths = projectPaths(input.workspace, input.projectId);

  if (!paths.ok) {
    return paths;
  }

  const digest = await readDigest(paths.data.narration);

  if (!digest.ok) {
    return ok({ delivery: DEFAULT_DELIVERY, input: null });
  }

  const parsed = await readJson(paths.data.narration, deliverySchema);

  if (!parsed.ok) {
    return err(
      new DirectionError(
        `narration.json nie daje się odczytać: ${parsed.error.message} — popraw plik albo usuń go, żeby wrócić do ustawień domyślnych dostawcy`
      )
    );
  }

  return ok({
    delivery: parsed.data.delivery,
    input: {
      path: toWorkspacePath(input.workspace.root, paths.data.narration),
      sha256: digest.data.sha256,
    },
  });
}

/**
 * Records how the narrator reads, merging over whatever was decided before.
 *
 * Merged rather than replaced because these are five independent decisions and
 * a command that set the ones it was not given back to the provider's defaults
 * would undo a choice nobody revisited. `--stability` alone means stability.
 */
export async function setDirection(input: SetDeliveryInput): Promise<Result<DirectionReport>> {
  const paths = projectPaths(input.workspace, input.projectId);

  if (!paths.ok) {
    return paths;
  }

  const current = await readDirection(input);

  if (!current.ok) {
    return current;
  }

  const delivery: SpeechDelivery = {
    similarityBoost: input.similarityBoost ?? current.data.delivery.similarityBoost,
    speakerBoost: input.speakerBoost ?? current.data.delivery.speakerBoost,
    speed: input.speed ?? current.data.delivery.speed,
    stability: input.stability ?? current.data.delivery.stability,
    style: input.style ?? current.data.delivery.style,
  };
  const parsed = deliverySchema.safeParse({ delivery, schemaVersion: 1 });

  if (!parsed.success) {
    return err(
      new DirectionError(
        `poza zakresem: ${parsed.error.issues.map((one) => `${one.path.join(".")} ${one.message}`).join("; ")}`
      )
    );
  }

  const written = await applyWrites(
    [{ kind: "text", text: serialize(parsed.data), to: paths.data.narration }],
    input.mode
  );

  return written.ok
    ? ok({
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        delivery,
        nextStep: `aimator check ${input.projectId}`,
        // Said plainly rather than left to be discovered: this file is a
        // recorded input of every bought line, so a reading somebody changes
        // no longer describes the recordings made under the old one.
        problems: [
          "kwestie kupione przed tą zmianą były czytane inaczej — check zgłosi je jako nieaktualne; nowe brzmienie kupuje wyłącznie --regenerate",
        ],
      })
    : written;
}
