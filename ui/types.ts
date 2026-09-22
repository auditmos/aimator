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
 * One drawn artifact, in the fields every image stage reports about one.
 *
 * The verdict is what the stage measured in the bytes, so a panel takes the
 * picture's real dimensions from it rather than holding a copy of the frame it
 * is drawn in. That frame is the stage's fact, and a second copy of it in a
 * browser would be wrong the day it changed.
 */
export interface Drawn {
  readonly approved: boolean;
  readonly id: string;
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
  readonly verdict: { readonly height: number; readonly width: number } | null;
}

/**
 * One of the ten pictures of a character, as `check --stage character` reports it.
 *
 * The same five fields as anything else that gets drawn, under one different
 * name: stage 2 calls it `artifact` because its ids are words rather than
 * numbers. The panel renames it on the way to the gallery, which is a mapping
 * of one field and cheaper than two galleries.
 */
export interface ArtifactStatus extends Omit<Drawn, "id"> {
  readonly artifact: string;
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
 * Stage 5's own object: every reference of one track, and what each waits for.
 *
 * A dependent reference carries the reason in its own `note`, naming the
 * sibling it is composed from. That is the stage's sentence, quoted rather
 * than summarised: a cell that only said "blocked" would leave a person with
 * no next move.
 */
export interface ReferencesStatus {
  readonly approved: boolean;
  readonly artifacts: readonly Drawn[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: string;
}

/** Stage 6's own object: one frame, per track, and nothing to narrow it with. */
export interface OpeningFrameStatus {
  readonly approved: boolean;
  readonly artifact: Drawn;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: string;
}

/**
 * One link of stage 7's chain: a clip, or the frame a clip starts on.
 *
 * It is `Drawn` with a `kind` and without a verdict, and both differences are
 * the stage's rather than a shortening. The kind is there because two media
 * are bought under one review; the measurements are not, because what stage 7
 * records about a clip is a duration and a frame size in one sentence of its
 * own, and a browser that re-derived either from the bytes would be measuring
 * what the stage already measured.
 */
export interface ClipState {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this run used. */
  readonly inputsChanged: readonly string[];
  readonly kind: "clip" | "entry-frame";
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
}

/** Stage 7's own object: both media of one track, in the chain's order. */
export interface ClipsStatus {
  readonly approved: boolean;
  readonly artifacts: readonly ClipState[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: string;
}

/**
 * Stage 8's one artifact: the whole film of one track.
 *
 * It carries `seconds` where a clip's state carries none, and that is the
 * stage rather than a difference of shape: what stage 8 measures on a finished
 * cut is how long it runs, read from the file's own boxes, and that number is
 * the one a person compares against the plan they approved.
 */
export interface CutState {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this cut used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly seconds: number | null;
  readonly state: "absent" | "completed";
}

/** Stage 8's own object: one cut per track, and what it says without refusing. */
export interface AssemblyStatus {
  readonly approved: boolean;
  readonly artifact: CutState;
  readonly nextStep: string;
  /** Reported, never enforced: a silent cut is not a blocked one. */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly track: string;
}

/**
 * Stage 8's report, and the first on this screen with **no bill in it**.
 *
 * What stands where a count of paid calls stands everywhere else is an
 * arithmetic: what the approved shot list ordered, what the clips actually
 * run, and the difference nothing here trims away. The cut itself is derived
 * from that shot list at call time and stored in no file, which is why the
 * panel reads it out of this report rather than holding a plan of its own.
 */
export interface AssemblyReport {
  readonly actualSeconds: number;
  readonly cut: readonly {
    readonly id: string;
    readonly plannedSeconds: number;
    readonly seconds: number | null;
  }[];
  /** The local engine, once it has answered. `null` when it could not be asked. */
  readonly engine: string | null;
  readonly notices: readonly string[];
  readonly plannedSeconds: number;
  readonly problems: readonly string[];
}

/**
 * One thing stage 9 reviewed: the script, one recording, or one track's mix.
 *
 * Three different artifacts under one shape, because stage 9 reviews all three
 * the same way and only two of them are audible. `characters` is the bill this
 * provider actually charges in, carried on the artifact rather than derived
 * from the text, and `seconds` is what the bought bytes turned out to run.
 */
export interface LineState {
  readonly approved: boolean;
  readonly characters: number;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this line used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly seconds: number | null;
  readonly state: "absent" | "completed" | "submitted";
}

/** Stage 9's shared half: the script and every line, with no track anywhere. */
export interface NarrationStatus {
  readonly approved: boolean;
  readonly lines: readonly LineState[];
  readonly nextStep: string;
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly script: LineState;
  /** The whole bill of the script, whether or not it has been paid yet. */
  readonly totalCharacters: number;
}

/** Stage 9's per-track half: one narrated cut, and nothing to narrow it with. */
export interface MixStatus {
  readonly approved: boolean;
  readonly artifact: LineState;
  readonly nextStep: string;
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly track: string;
}

/**
 * Stage 9's report, and the first whose bill is **not** the count of calls.
 *
 * Both numbers travel because neither alone is what a person is deciding on:
 * this provider charges for the characters of the text it is handed, so a
 * panel printing the call count alone would put a number nobody is billed
 * beside the button that spends. `contextCharacters` rides beside the bill and
 * never inside it, because the provider does not say whether it charges for
 * them and this tool does not guess with somebody else's account.
 */
export interface NarrationReport {
  readonly calls: number;
  readonly characters: number;
  readonly contextCharacters: number;
  readonly lines: readonly {
    readonly characters: number;
    readonly id: string;
    readonly note: string;
    readonly state: string;
  }[];
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text the script call would send. */
  readonly prompt: string | null;
  /** What would happen to the script itself, which decides what the bill is. */
  readonly script: { readonly note: string; readonly state: string };
}

/** Stage 9's per-track report: where each accepted line landed on this film. */
export interface MixReport {
  readonly actualSeconds: number;
  /** The local engine, once it has answered. `null` when it could not be asked. */
  readonly engine: string | null;
  readonly lines: readonly {
    readonly atSeconds: number;
    readonly id: string;
    readonly plannedSeconds: number;
    readonly seconds: number;
  }[];
  readonly notices: readonly string[];
  readonly problems: readonly string[];
}

/**
 * What every paid stage's report says that a panel has to show.
 *
 * The bill is deliberately **not** here, and that is the interesting part.
 * Every stage up to stage 6 is billed in one number and stage 7 is billed in
 * two, counted apart because an image and a video cost differently by an order
 * of magnitude; a shared `paidCalls` would have made the panel add up numbers
 * nobody is billed. So each panel reads its own report's own fields, and what
 * is common is only what every one of them has: the obstacles.
 */
export interface PaidReport {
  readonly problems: readonly string[];
}

/** A stage billed in one number: one call buys one thing, once. */
export interface CallsReport extends PaidReport {
  readonly paidCalls: number;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
}

/**
 * An image stage's: one call is one picture, and each picture has its own text.
 *
 * The prompt sits under the artifact rather than at the top of the report,
 * because one command draws one picture or eight and each of them is sent a
 * different instruction.
 */
export interface DrawnReport extends PaidReport {
  readonly artifacts: readonly { readonly id: string; readonly prompt: string | null }[];
  readonly paidCalls: number;
}

/** Stage 7's: two media, two bills, and a prompt under each artifact. */
export interface MediaReport extends PaidReport {
  readonly artifacts: readonly { readonly id: string; readonly prompt: string | null }[];
  readonly paidImages: number;
  readonly paidVideos: number;
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
