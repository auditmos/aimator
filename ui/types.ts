/**
 * What the server hands over, which is what the CLI already prints.
 *
 * These are declarations of somebody else's shape rather than a model of this
 * client's own: every field here exists because `status --json` or
 * `list --json` writes it, and the contract for both is in `docs/pipeline.md`.
 * Nothing in the browser derives a state, a verdict or a next step; it renders
 * the ones it was given, which is the whole arrangement this tool is built on.
 */

export type CellState = "approved" | "blocked" | "ready" | "review" | "running";

/**
 * Stage 0's report, as all seven of its commands print it under `--json` and
 * as the ladder carries it inside the stage-0 cell.
 *
 * `problems` here is advisory rather than blocking, and the panel treats it
 * that way: a project with no episode yet says so and is still acceptable,
 * exactly as the CLI accepts it. The blocking kind never reaches this shape,
 * because the stage refuses to answer at all.
 */
export interface Stage0Report {
  readonly approved: boolean;
  readonly created: readonly string[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly ready: boolean;
  readonly reused: readonly string[];
}

/**
 * What every reviewed text stage answers, whatever else it also answers.
 *
 * Stages 1, 3 and 4 share it to the field, which is why the one condition that
 * decides whether "Zatwierdź" exists is written once rather than three times.
 */
export interface TextStatus {
  readonly approved: boolean;
  /** Inputs whose bytes no longer match what this stage was written from. */
  readonly inputsChanged: readonly string[];
  readonly problems: readonly string[];
  readonly status: "absent" | "completed" | "submitted";
}

/**
 * Stage 1's own object, as `check --stage screenplay --json` prints it and as
 * the ladder carries it inside its stage-1 cell. Declared, never derived: the
 * panel renders these fields and computes no verdict of its own.
 */
export interface ScreenplayStatus extends TextStatus {
  readonly verdict: {
    readonly durationSeconds: number;
    readonly longestSceneSeconds: number;
    readonly scenes: number;
  } | null;
}

/** Stage 3's own object: the plan, counted in the three units it never mixes. */
export interface ShotListStatus extends TextStatus {
  readonly verdict: {
    readonly castSeen: readonly string[];
    readonly clips: readonly unknown[];
    readonly durationSeconds: number;
    readonly longestClipSeconds: number;
    readonly maxClipSeconds: number;
    readonly scenes: readonly unknown[];
    readonly shots: readonly unknown[];
  } | null;
}

/** Stage 4's own object: the graph, and what it says depends on what. */
export interface PromptPackageStatus extends TextStatus {
  readonly verdict: {
    readonly clips: readonly { readonly id: string }[];
    readonly heroes: readonly string[];
    readonly references: readonly {
      readonly dependsOn: readonly string[];
      readonly id: string;
      readonly kind: string;
      readonly subject: string;
    }[];
  } | null;
}

/**
 * One of the ten pictures of a character, as `check --stage character` reports it.
 *
 * The verdict is what the stage measured in the bytes, so the panel takes the
 * picture's real dimensions from it rather than holding a copy of the frame a
 * character sheet is drawn in. That frame is `lib/character`'s fact, and a
 * second copy of it in a browser would be wrong the day it changed.
 */
export interface ArtifactStatus {
  readonly approved: boolean;
  readonly artifact: string;
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
  readonly verdict: { readonly height: number; readonly width: number } | null;
}

/**
 * Stage 2's own object: one character as one track draws it.
 *
 * The ten artifacts arrive in the order the stage draws them, card first and
 * hero last, so the panel lists them rather than holding a second copy of
 * their names. A list the screen owned would drift from the stage's the day
 * somebody added a view.
 */
export interface CharacterStatus {
  readonly approved: boolean;
  readonly artifacts: readonly ArtifactStatus[];
  readonly inputsChanged: readonly string[];
  readonly name: string;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: string;
}

/**
 * What every paid stage's report says that a panel has to show.
 *
 * The bill first, because it is the one number that must stand beside the
 * button that spends it rather than inside a sentence somebody has to parse.
 */
export interface PaidReport {
  readonly paidCalls: number;
  readonly problems: readonly string[];
  readonly prompt: string | null;
}

/**
 * One future paid call, as stage 4 plans it for one track.
 *
 * The attachments are the point: rule 8 says a prompt is text **plus ordered
 * attachments addressed by position**, and this is the only place that order
 * is visible before anything is sent. `bytes` is deliberately absent, because
 * a JSON document has none and the digest identifies the file.
 */
export interface PlannedArtifact {
  readonly attachments: readonly {
    readonly id: string;
    readonly path: string;
    readonly role: string;
    readonly sha256: string | null;
    readonly state: "absent" | "approved" | "changed" | "pending";
  }[];
  readonly blockers: readonly string[];
  readonly kind: string;
  readonly name: string;
  readonly seconds: number | null;
  readonly text: string | null;
}

/** What `prompt-package show --json` prints: one track's whole send plan. */
export interface SendPlan {
  readonly artifacts: readonly PlannedArtifact[];
  readonly aspectRatio: string;
  readonly command: "show";
  readonly limit: number;
  readonly problems: readonly string[];
  readonly promptVersion: number;
  readonly size: string;
  readonly stage: "prompt-package";
  readonly track: string;
}

/** One cell of the ladder, exactly as `status --json` writes it. */
export interface StatusCell {
  /** Set only where a cell is per character, which is stage 2 alone. */
  readonly character: string | null;
  readonly id: string;
  readonly nextStep: string | null;
  /** Why the cell is blocked, in the stage's own words. */
  readonly reason: string | null;
  readonly stage: number;
  readonly state: CellState;
  /** The stage's own check object. Read here for its reports, nothing else. */
  readonly status: { readonly notices?: readonly string[] } | null;
  readonly title: string;
  readonly track: string | null;
}

/** What a started command said when it finished, under the id it was given. */
export type RunDone =
  | { readonly data: string; readonly ok: true; readonly runId: string }
  | { readonly error: Refusal["error"]; readonly ok: false; readonly runId: string };

export interface EpisodeStatus {
  readonly cells: readonly StatusCell[];
  readonly command: "status";
  readonly episodeId: string;
  readonly next: { readonly cell: string; readonly command: string } | null;
  readonly projectId: string;
}

export interface ListedProject {
  readonly episodes: readonly string[];
  readonly id: string;
}

export interface WorkspaceListing {
  readonly command: "list";
  readonly projects: readonly ListedProject[];
  readonly workspace: string;
}

/** A command that refused, in the words the terminal would have printed. */
export interface Refusal {
  readonly error: { readonly message: string; readonly name: string };
}
