/**
 * Every command this screen can express, and the only place it knows one.
 *
 * A button here is a command in the terminal: the same words, in the same
 * order, with the same flags. That is the whole bargain this tool is built on,
 * because the pipeline is driven by agents as well as by a person, and a
 * screen that could express something `aimator …` cannot would be a second
 * road with one traveller. Keeping the grammar in one file is what makes the
 * bargain checkable: `commands.test.ts` builds every intent and looks each one
 * up in `--help`, so a renamed flag fails a test instead of a click.
 *
 * The array an intent returns is both halves at once: what the server is asked
 * to run, and what the panel prints under the button for copying. Two arrays
 * would be two truths, and the one on screen would be the one that rots.
 *
 * `--json` is deliberately absent. What a panel shows of a finished command is
 * the text the terminal would have printed, refusals included, and what it
 * knows about a stage's state comes from the ladder, which is `status --json`
 * already. A flag here would make the printed command unpasteable for the
 * person it is printed for.
 */

interface EpisodeRef {
  readonly episodeId: string;
  readonly projectId: string;
}

export const INTENTS = {
  /** Stage 1, accepted: a human saying yes, bound to the digests it has now. */
  approveScreenplay: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "approve",
    projectId,
    episodeId,
    "--stage",
    "screenplay",
  ],
  /** Stage 1, verified: reads, reports drift, writes nothing. */
  checkScreenplay: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "screenplay",
  ],
} as const satisfies Record<string, (scope: EpisodeRef) => readonly string[]>;

/** The same argv, spelled the way a terminal takes it. */
export function commandLine(argv: readonly string[]): string {
  return ["aimator", ...argv].join(" ");
}
