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
 * Stage 1's own object, as `check --stage screenplay --json` prints it and as
 * the ladder carries it inside its stage-1 cell. Declared, never derived: the
 * panel renders these fields and computes no verdict of its own.
 */
export interface ScreenplayStatus {
  readonly approved: boolean;
  /** Stage-0 inputs whose bytes no longer match what this screenplay was written from. */
  readonly inputsChanged: readonly string[];
  readonly problems: readonly string[];
  readonly status: "absent" | "completed" | "submitted";
  readonly verdict: {
    readonly durationSeconds: number;
    readonly longestSceneSeconds: number;
    readonly scenes: number;
  } | null;
}

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
