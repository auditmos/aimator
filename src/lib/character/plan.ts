import {
  emptyStage,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  stageFileSchema,
  toWorkspacePath,
} from "../artifact/index.js";
import { attach, correction, type ImageAttachment, previousId } from "../image-model/index.js";
import type { Stage0Character } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type CharacterTrackPaths,
  characterViewImage,
  type ImageTrack,
  type Workspace,
} from "../workspace.js";
import {
  buildPrompt,
  CHARACTER_VIEWS,
  type CharacterArtifact,
  type ReferenceSlot,
  referencePlan,
} from "./prompt.js";

/**
 * Internal to the character module: what an artifact is drawn from, and
 * whether it may be drawn yet.
 *
 * Both halves belong together because both are about inputs. The gates ask
 * whether the images this one depends on have been accepted; the plan turns
 * that dependency into the exact ordered bytes a request will carry. Nothing
 * here touches the network, writes a file, or knows that a call costs money.
 */

/** The one stage name this module writes and reads. */
const STAGE = "character";

/** What the plan needs from the command: which track, and where the tree is. */
interface PlanScope {
  /** A note on the one named image, which then leads its list as Image 1. */
  readonly instruction?: string | null;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

export class Stage2BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 2 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage2BlockedError";
    this.problems = problems;
  }
}

/** Everything the gates and the plan read: where, what state, what inputs. */
export interface Scope {
  readonly paths: CharacterTrackPaths;
  readonly stage: StageFile;
  readonly stage0: Stage0Character;
}

/** A record that finished and whose bytes a human has accepted. */
export function accepted(stage: StageFile, key: CharacterArtifact): boolean {
  const record = stage.artifacts[key];

  return record?.status === "completed" && record.review.status === "approved";
}

/**
 * Why one artifact may not be drawn yet. Empty means it may.
 *
 * This is the sequence the whole stage exists to enforce: the views are drawn
 * from the card, so they wait for a human to accept the card; the hero is drawn
 * from the views, so it waits for all eight. Validation never opens either gate;
 * only an explicit approval does.
 */
export function sequenceGate(stage: StageFile, artifact: CharacterArtifact): readonly string[] {
  if (artifact === "card") {
    return [];
  }

  if (artifact === "hero") {
    const missing = CHARACTER_VIEWS.filter((view) => !accepted(stage, view));

    return missing.length === 0
      ? []
      : [`hero czeka na zatwierdzenie widoków: ${missing.join(", ")}`];
  }

  return accepted(stage, "card")
    ? []
    : ["widoki czekają na zatwierdzenie karty, oceń card.png i zatwierdź ją"];
}

/**
 * What this invocation is about, when the user named nothing.
 *
 * The gates make the answer single-valued: exactly one step of the sequence is
 * ever runnable, so `character generate` with no flags does the next thing and
 * stops, rather than trying to spend the whole stage's budget in one go.
 */
export function nextGroup(stage: StageFile): readonly CharacterArtifact[] {
  if (stage.artifacts.card?.status !== "completed") {
    return ["card"];
  }

  if (!accepted(stage, "card")) {
    return [];
  }

  const pending = CHARACTER_VIEWS.filter((view) => stage.artifacts[view]?.status !== "completed");

  if (pending.length > 0) {
    return pending;
  }

  const unapproved = CHARACTER_VIEWS.filter((view) => !accepted(stage, view));

  if (unapproved.length > 0) {
    return [];
  }

  return stage.artifacts.hero?.status === "completed" ? [] : ["hero"];
}

export async function readStage(path: string): Promise<StageFile> {
  const stage = await readJson(path, stageFileSchema);

  return stage.ok ? stage.data : emptyStage(STAGE);
}

/** What one artifact is drawn from: the ordered bytes, and what they are. */
interface Plan {
  readonly attachments: readonly ImageAttachment[];
  readonly inputs: readonly RecordedFile[];
  readonly prompt: string;
  readonly references: readonly RecordedFile[];
}

/**
 * What one artifact would be drawn from, and the exact prompt for it.
 *
 * The references are re-read and re-hashed here rather than trusted from the
 * stage file: a card edited outside the tool must not silently become the
 * authority for eight views drawn from it.
 */
export async function buildPlan(
  input: PlanScope,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Result<Plan>> {
  const sources = scope.stage0.sources.map((source) => basenameOf(source.path));
  const instruction = input.instruction ?? null;
  const slots = referencePlan({
    artifact,
    basis: scope.stage0.basis,
    correcting: instruction !== null,
    sources,
    track: input.track,
  });

  if (!slots.ok) {
    return slots;
  }

  const resolved = await resolveSlots(input, scope, slots.data);

  if (!resolved.ok) {
    return resolved;
  }

  // The corrected image is recorded by the attempt, from its own archive,
  // never here: here it is the file the new image is about to replace.
  const planned = resolved.data.filter((entry) => entry.slot.kind !== "previous");

  return ok({
    attachments: resolved.data.map((entry) => entry.attachment),
    inputs: [
      ...scope.stage0.inputs,
      ...planned.map((entry) => entry.reference).filter((ref) => !isStage0(scope, ref)),
    ],
    prompt: buildPrompt({
      artifact,
      basis: scope.stage0.basis,
      correction: instruction === null ? null : correction(instruction),
      name: scope.stage0.name,
      references: slots.data,
      rules: scope.stage0.rules,
    }),
    references: resolved.data.map((entry) => entry.reference),
  });
}

function isStage0(scope: Scope, reference: RecordedFile): boolean {
  return scope.stage0.inputs.some((entry) => entry.path === reference.path);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

interface ResolvedSlot {
  readonly attachment: ImageAttachment;
  readonly reference: RecordedFile;
  readonly slot: ReferenceSlot;
}

/** Turns the plan's slots into bytes, refusing anything that no longer matches. */
async function resolveSlots(
  input: PlanScope,
  scope: Scope,
  slots: readonly ReferenceSlot[]
): Promise<Result<readonly ResolvedSlot[]>> {
  const out: ResolvedSlot[] = [];

  for (const slot of slots) {
    const path = pathOf(scope, slot);

    if (!path.ok) {
      return path;
    }

    // biome-ignore lint/performance/noAwaitInLoops: ordered, and the order is the prompt
    const digest = await readDigest(path.data);

    if (!digest.ok) {
      const where = toWorkspacePath(input.workspace.root, path.data);

      return err(
        new Stage2BlockedError([
          slot.kind === "previous"
            ? `nie ma opublikowanego obrazu (${where}), który --instruction mógłby poprawić; pierwszy kupuje generate bez tej flagi`
            : `brakuje referencji ${slot.name} (${where})`,
        ])
      );
    }

    const expected = expectedDigest(scope, slot);

    if (expected !== null && expected !== digest.data.sha256) {
      return err(
        new Stage2BlockedError([
          `${slot.name}: bajty nie zgadzają się z zatwierdzonym hashem, plik zmieniono poza narzędziem, więc nie jest już tym, co ktoś przyjął`,
        ])
      );
    }

    out.push({
      attachment: attach(
        slot.kind === "previous" ? previousId(slot.name) : slot.name,
        digest.data.bytes
      ),
      reference: {
        path: toWorkspacePath(input.workspace.root, path.data),
        sha256: digest.data.sha256,
      },
      slot,
    });
  }

  return ok(out);
}

function pathOf(scope: Scope, slot: ReferenceSlot): Result<string> {
  if (slot.kind === "previous") {
    return outputPath(scope.paths, slot.name as CharacterArtifact);
  }

  if (slot.kind === "card") {
    return ok(scope.paths.card);
  }

  if (slot.kind === "view") {
    return characterViewImage(scope.paths, slot.name);
  }

  const source = scope.stage0.sources.find((entry) => basenameOf(entry.path) === slot.name);

  return source === undefined
    ? err(new Stage2BlockedError([`nie znaleziono pliku ${slot.name} w materiałach postaci`]))
    : ok(source.path);
}

/** The digest a reference must still have, or `null` when stage 0 already owns it. */
function expectedDigest(scope: Scope, slot: ReferenceSlot): string | null {
  // The image being corrected need not be accepted: correcting one nobody
  // accepted is what the flag is for. Whatever is on disk is what was seen.
  if (slot.kind === "previous") {
    return null;
  }

  if (slot.kind === "photograph" || slot.kind === "design") {
    return (
      scope.stage0.sources.find((entry) => basenameOf(entry.path) === slot.name)?.sha256 ?? null
    );
  }

  const key: CharacterArtifact = slot.kind === "card" ? "card" : (slot.name as CharacterArtifact);

  return scope.stage.artifacts[key]?.outputs[0]?.sha256 ?? null;
}
export function outputPath(
  paths: CharacterTrackPaths,
  artifact: CharacterArtifact
): Result<string> {
  if (artifact === "card") {
    return ok(paths.card);
  }

  return artifact === "hero" ? ok(paths.hero) : characterViewImage(paths, artifact);
}
