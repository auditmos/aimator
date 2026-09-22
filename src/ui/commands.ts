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
 * `--json` is asked for where the panel **arranges** an answer rather than
 * reading it out: the bill has to stand as a number beside the button that
 * spends it, and finding that number inside a Polish sentence would be this
 * client learning the CLI's text format. Where the panel shows a finished
 * command whole, `check` and `approve`, the flag stays off and what appears on
 * screen is the text a terminal would have printed, refusals included.
 */

interface ProjectRef {
  readonly projectId: string;
}

interface EpisodeRef extends ProjectRef {
  readonly episodeId: string;
}

/** One member of the cast, which is a directory level and never a filename. */
interface CastRef extends ProjectRef {
  readonly characterId: string;
}

/**
 * The five decisions an episode carries, plus the sixth stage 3 asks for.
 *
 * Every one of them is a string, including the two that are numbers, because
 * what the form holds is what somebody typed and an empty field means
 * undecided. Coercing "" to 0 here would be this client answering a question
 * rule 7 says only a person may answer.
 */
interface Settings {
  readonly audio: string;
  readonly duration: string;
  readonly language: string;
  readonly maxClip: string;
  readonly nature: string;
  readonly subtitles: string;
}

/**
 * What stage 1's paid command is told, beyond which episode it is about.
 *
 * An empty string is not a value here: it means the panel's field was left
 * alone, so the flag is not spelled at all and the CLI's own answer stands,
 * which for the model is `AIMATOR_SCREENPLAY_MODEL` and for the budget is the
 * command's default. That is rule 7 read at the edge of the screen: a field
 * nobody filled in is undecided, never a zero.
 */
interface Send extends EpisodeRef {
  readonly maxOutputTokens: string;
  readonly model: string;
  /** A second paid attempt over a screenplay that already exists. */
  readonly regenerate: boolean;
}

/**
 * A dry run that came back: the only thing a purchase may be built from.
 *
 * Both halves are load-bearing. The argv is what makes the purchase *the same
 * send*, so nobody can preview one episode and buy another; the identifier is
 * what makes it a **finished** dry run rather than an array somebody spelled,
 * because it is issued by the server when the run is started and comes back
 * with the run's answer.
 */
export interface Preview {
  readonly argv: readonly string[];
  readonly runId: string;
}

/** A purchase the two-step rule would not allow. Never a refusal to show. */
class NotPreviewedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPreviewedError";
  }
}

/** A flag the panel left empty is not spelled at all. */
function flag(name: string, value: string): readonly string[] {
  return value === "" ? [] : [name, value];
}

/** The six decisions, in the order the usage text lists them. */
function settings(one: Settings): readonly string[] {
  return [
    ...flag("--duration", one.duration),
    ...flag("--audio", one.audio),
    ...flag("--language", one.language),
    ...flag("--subtitles", one.subtitles),
    ...flag("--nature", one.nature),
    ...flag("--max-clip", one.maxClip),
  ];
}

/**
 * Everything any intent needs, which nothing but the dictionary's test holds.
 *
 * Each intent below declares the narrow shape it actually reads, and the
 * record is typed as taking this wide one, which is legal because a function
 * asking for less is assignable to one asked for more. The point is the test:
 * it hands one object to every intent, so a new intent is checked against
 * `--help` the moment it exists rather than when somebody remembers to add it.
 */
interface Everything extends Send, Settings {
  readonly aspectRatio: string;
  readonly characterId: string;
  readonly name: string;
  readonly source: string;
  readonly sources: readonly string[];
  readonly title: string;
  readonly voiceId: string;
}

export const INTENTS = {
  /** Stage 0: one more member of the cast, declared rather than inferred. */
  addCharacter: (one: CastRef & { readonly name: string }): readonly string[] => [
    "character",
    "new",
    one.projectId,
    one.characterId,
    "--name",
    one.name,
  ],
  /**
   * Stage 0: photographs this character is drawn from, by path.
   *
   * Several `--source` flags rather than one comma-separated value, because
   * that is what the command takes and a path may contain a comma. The paths
   * travel exactly as typed: the archive records where each file came from.
   */
  addCharacterSources: (
    one: CastRef & { readonly sources: readonly string[] }
  ): readonly string[] => [
    "character",
    "add",
    one.projectId,
    one.characterId,
    ...one.sources.filter((path) => path !== "").flatMap((path) => ["--source", path]),
  ],
  /** Stage 0: the episode, named by its own source file and nothing else. */
  addEpisode: (one: ProjectRef & Settings & { readonly source: string }): readonly string[] => [
    "episode",
    "add",
    one.projectId,
    "--source",
    one.source,
    ...settings(one),
  ],
  /** Stage 0, accepted: the rules, the cast and the episode's decisions. */
  approvePrepare: (one: ProjectRef): readonly string[] => [
    "approve",
    one.projectId,
    "--stage",
    "prepare",
  ],
  /** Stage 1, accepted: a human saying yes, bound to the digests it has now. */
  approveScreenplay: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "approve",
    projectId,
    episodeId,
    "--stage",
    "screenplay",
  ],
  /**
   * Stage 0: the narrator of the series, cast rather than configured.
   *
   * A voice recurs between episodes exactly as the cast does, so it is stored
   * beside them in `project.json` and gates stage 9 alone.
   */
  castNarrator: (one: ProjectRef & { readonly voiceId: string }): readonly string[] => [
    "project",
    "voice",
    one.projectId,
    "--voice-id",
    one.voiceId,
  ],
  /**
   * Stage 0, verified: named, so the answer is stage 0 and nothing else.
   *
   * Without `--stage` the same command glues four stages into one string,
   * which is the right answer for a person at a terminal and unreadable for a
   * panel showing one stage.
   */
  checkPrepare: (one: ProjectRef): readonly string[] => [
    "check",
    one.projectId,
    "--stage",
    "prepare",
  ],
  /** Stage 1, verified: reads, reports drift, writes nothing. */
  checkScreenplay: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "screenplay",
  ],
  /** Stage 0: this character is drawn from `project.md`, not from photographs. */
  describeCharacter: (one: CastRef): readonly string[] => [
    "character",
    "describe",
    one.projectId,
    one.characterId,
  ],
  /** Stage 0: the project itself, which is where an empty workspace starts. */
  initProject: (
    one: ProjectRef & { readonly aspectRatio: string; readonly title: string }
  ): readonly string[] => [
    "project",
    "init",
    one.projectId,
    "--title",
    one.title,
    ...flag("--aspect-ratio", one.aspectRatio),
  ],
  /** Stage 1, previewed: the whole send, priced, with nothing sent. */
  previewScreenplay: (send: Send): readonly string[] => [
    "screenplay",
    "generate",
    send.projectId,
    send.episodeId,
    ...flag("--model", send.model),
    ...flag("--max-output-tokens", send.maxOutputTokens),
    ...(send.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /** Stage 0: the decisions of an episode that already exists. */
  setEpisode: (one: EpisodeRef & Settings): readonly string[] => [
    "episode",
    "set",
    one.projectId,
    one.episodeId,
    ...settings(one),
  ],
} as const satisfies Record<string, (one: Everything) => readonly string[]>;

/**
 * Stage 1, bought: the previewed send, with the dry run taken off.
 *
 * It is a function rather than an entry in the record above, and that is the
 * point rather than an arrangement: everything in `INTENTS` is built from a
 * scope, and a purchase cannot be, because its only input is a dry run that
 * already came back. Deriving the argv instead of rebuilding it is what makes
 * the two steps one decision: the episode, the model, the token budget and the
 * new attempt are whatever the person read in the preview, not whatever the
 * fields say by the time the second button is clicked.
 *
 * `--json` comes off with it, and the two removals mean different things.
 * Taking off `--dry-run` is the purchase. Taking off `--json` changes nothing
 * about what is sent: the preview is arranged by the panel field by field,
 * while what a finished purchase says is read whole, so it comes back in the
 * words the terminal would have printed, and the command under the button is
 * the one a person would have typed.
 */
export function buyScreenplay(preview: Preview): readonly string[] {
  if (!preview.argv.includes("--dry-run")) {
    throw new NotPreviewedError("kupić można wyłącznie to, co pokazała próba --dry-run");
  }

  if (preview.runId === "") {
    throw new NotPreviewedError("podgląd bez identyfikatora przebiegu nie jest ukończoną próbą");
  }

  return preview.argv.filter((one) => one !== "--dry-run" && one !== "--json");
}

/** The same argv, spelled the way a terminal takes it. */
export function commandLine(argv: readonly string[]): string {
  return ["aimator", ...argv].join(" ");
}
