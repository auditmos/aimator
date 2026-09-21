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
