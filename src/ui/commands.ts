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

/** Which of the two productions a command is about. Never guessed. */
interface TrackRef extends EpisodeRef {
  readonly track: string;
}

/**
 * One character as one track draws it, and which of the ten pictures.
 *
 * `artifacts` is a list because the CLI takes one: six references or two views
 * accepted in a single command is one decision a person made, and six clicks
 * would be six commands over one decision. An empty list means the flag is not
 * spelled at all, which for `generate` is "whatever the gates allow next".
 */
interface CharacterTrackRef extends CastRef {
  readonly artifacts: readonly string[];
  readonly track: string;
}

/** `--artifact R01,R02`: several names, one command, the way the CLI spells it. */
function artifacts(names: readonly string[]): readonly string[] {
  const listed = names.filter((name) => name !== "");

  return listed.length === 0 ? [] : ["--artifact", listed.join(",")];
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
interface Everything extends Send, Settings, TrackRef {
  readonly artifact: string;
  readonly artifacts: readonly string[];
  readonly aspectRatio: string;
  readonly characterId: string;
  /** Stage 8 alone: the free `generate` that shows the cut without writing it. */
  readonly dryRun: boolean;
  readonly imageModel: string;
  readonly name: string;
  readonly source: string;
  readonly sources: readonly string[];
  readonly title: string;
  readonly videoModel: string;
  readonly voiceId: string;
}

/**
 * What stage 7's paid command is told: two media, so two models.
 *
 * It is the first scope on this screen with no bare `model`, and that is the
 * stage rather than a naming choice. An entry frame is drawn by this track's
 * image model and a clip is rendered by the one video model both tracks share,
 * so a single flag would not say which; the CLI refuses `--model` here with a
 * sentence, and a panel that offered one would be offering a refusal.
 */
interface ClipSend extends TrackRef {
  readonly artifacts: readonly string[];
  readonly imageModel: string;
  readonly regenerate: boolean;
  readonly videoModel: string;
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
  /**
   * Stage 8, accepted: the whole film of one track, and nothing to narrow.
   *
   * No `--artifact` for stage 6's reason, read one row lower: there is one cut
   * per track, so a flag with one legal value would be ceremony standing where
   * a decision used to be. What it accepts is also a different question from
   * the clips' own yeses, which is why it is a separate command rather than a
   * consequence of them: those say each shot is good, this says these clips in
   * this order are a film.
   */
  approveAssembly: (one: TrackRef): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "assembly",
    "--track",
    one.track,
  ],
  /**
   * Stage 2, accepted: named pictures of one character on one track.
   *
   * `--artifact` is required by the CLI here and the list is what makes one
   * click one decision: accepting the card is what lets the eight views be
   * bought, so it has to be something somebody named rather than a side
   * effect of accepting something else.
   */
  approveCharacter: (one: CharacterTrackRef): readonly string[] => [
    "approve",
    one.projectId,
    one.characterId,
    "--stage",
    "character",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
  ],
  /**
   * Stage 7, accepted: clips and entry frames of one track, several at a time.
   *
   * The list matters more here than anywhere above it, because the chain is
   * what it unlocks: accepting C01 is what lets C02's entry frame be drawn,
   * and accepting that frame is what lets C02 be rendered. One sitting in
   * front of a clip and the frame it hands on is one decision, so it is one
   * command, and the ids are the CLI's own.
   */
  approveClips: (one: TrackRef & { readonly artifacts: readonly string[] }): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "clips",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
  ],
  /**
   * Stage 6, accepted: the one frame, and no `--artifact` anywhere near it.
   *
   * Stage 5 demands the flag because it has several candidates and accepting
   * the wrong one buys an image. Here the command already says which stage and
   * which track, and there is nothing else it could mean, so a flag with one
   * legal value would be ceremony standing where a decision used to be.
   */
  approveOpeningFrame: (one: TrackRef): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "opening-frame",
    "--track",
    one.track,
  ],
  /** Stage 0, accepted: the rules, the cast and the episode's decisions. */
  approvePrepare: (one: ProjectRef): readonly string[] => [
    "approve",
    one.projectId,
    "--stage",
    "prepare",
  ],
  /** Stage 4, accepted: the manifest and every prompt file under it. */
  approvePromptPackage: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "approve",
    projectId,
    episodeId,
    "--stage",
    "prompt-package",
  ],
  /**
   * Stage 5, accepted: named references on one track, several at a time.
   *
   * Six references reviewed in one sitting is one decision, so it is one
   * command with a list rather than six commands, six approvals and six lines
   * in an archive. Accepting R03 is what lets R04 be bought, which is why the
   * list is something somebody named rather than "everything".
   */
  approveReferences: (
    one: TrackRef & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "references",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
  ],
  /** Stage 1, accepted: a human saying yes, bound to the digests it has now. */
  approveScreenplay: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "approve",
    projectId,
    episodeId,
    "--stage",
    "screenplay",
  ],
  /** Stage 3, accepted: the plan every image and every clip is drawn from. */
  approveShotList: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "approve",
    projectId,
    episodeId,
    "--stage",
    "shot-list",
  ],
  /**
   * Stage 8: the cut, and the only `generate` on this screen that is not a send.
   *
   * It has no model flag, no key and no bill, because it reaches no provider:
   * what it needs is a program on this machine, and when that is missing the
   * CLI refuses rather than re-encoding. So the two-step rule does not apply
   * and `--dry-run` is here for the other half of a preview: the cut plan,
   * derived from the approved shot list at call time and stored nowhere, plus
   * how far the clips that came back drifted from it.
   */
  assembleEpisode: (
    one: TrackRef & { readonly dryRun: boolean; readonly regenerate: boolean }
  ): readonly string[] => [
    "assembly",
    "generate",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...(one.regenerate ? ["--regenerate"] : []),
    ...(one.dryRun ? ["--dry-run"] : []),
    "--json",
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
  /** Stage 8, verified: the cut of one track, read off its own boxes, offline. */
  checkAssembly: (one: TrackRef): readonly string[] => [
    "check",
    one.projectId,
    one.episodeId,
    "--stage",
    "assembly",
    "--track",
    one.track,
  ],
  /** Stage 2, verified: one character on one track, ten artifacts at a time. */
  checkCharacter: (one: CastRef & { readonly track: string }): readonly string[] => [
    "check",
    one.projectId,
    one.characterId,
    "--stage",
    "character",
    "--track",
    one.track,
  ],
  /** Stage 7, verified: both media of one track, and where the chain stands. */
  checkClips: (one: TrackRef): readonly string[] => [
    "check",
    one.projectId,
    one.episodeId,
    "--stage",
    "clips",
    "--track",
    one.track,
  ],
  /** Stage 6, verified: one frame on one track, and nothing to narrow. */
  checkOpeningFrame: (one: TrackRef): readonly string[] => [
    "check",
    one.projectId,
    one.episodeId,
    "--stage",
    "opening-frame",
    "--track",
    one.track,
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
  /** Stage 4, verified: the wiring verdict, which never reads a prompt. */
  checkPromptPackage: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "prompt-package",
  ],
  /** Stage 5, verified: every reference of this track, and what each waits for. */
  checkReferences: (one: TrackRef): readonly string[] => [
    "check",
    one.projectId,
    one.episodeId,
    "--stage",
    "references",
    "--track",
    one.track,
  ],
  /** Stage 1, verified: reads, reports drift, writes nothing. */
  checkScreenplay: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "screenplay",
  ],
  /** Stage 3, verified: coverage and the sums of time, nothing written. */
  checkShotList: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "shot-list",
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
  /**
   * Stage 2, previewed: every prompt, and the count of pictures it would buy.
   *
   * The first preview on this screen whose bill is a set rather than a coin
   * flip, which is why the count comes back as a number in an object: one
   * command draws one image or eight, and that is the thing to read before
   * clicking rather than after.
   */
  previewCharacter: (
    one: CharacterTrackRef & { readonly model: string; readonly regenerate: boolean }
  ): readonly string[] => [
    "character",
    "generate",
    one.projectId,
    one.characterId,
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    ...flag("--model", one.model),
    ...(one.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 7, previewed: how many frames and how many clips this would buy.
   *
   * The only preview on this screen whose bill is **two numbers**, and they
   * are never added up: an image and a video cost differently by an order of
   * magnitude, so one total would be a number nobody is billed. Without a
   * named artifact the command buys whatever the chain allows, which on a
   * fresh track is nothing; naming a blocked link is the other question, why
   * not that one yet, and the preview answers it with zero and a reason.
   */
  previewClips: (one: ClipSend): readonly string[] => [
    "clip",
    "generate",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    ...flag("--image-model", one.imageModel),
    ...flag("--video-model", one.videoModel),
    ...(one.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /** Stage 6, previewed: one image or the reason there is none. */
  previewOpeningFrame: (
    one: TrackRef & { readonly model: string; readonly regenerate: boolean }
  ): readonly string[] => [
    "opening-frame",
    "generate",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...flag("--model", one.model),
    ...(one.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /** Stage 4, previewed: the whole send, priced, with nothing sent. */
  previewPromptPackage: (send: Send): readonly string[] => [
    "prompt-package",
    "generate",
    send.projectId,
    send.episodeId,
    ...flag("--model", send.model),
    ...flag("--max-output-tokens", send.maxOutputTokens),
    ...(send.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 5, previewed: every prompt, and how many images the graph allows.
   *
   * Without a named artifact this draws whatever is already unblocked, which
   * is the ordinary call, and the count says how many that is. Naming one is
   * how a person asks the other question: why not that one yet.
   */
  previewReferences: (
    one: TrackRef & {
      readonly artifacts: readonly string[];
      readonly model: string;
      readonly regenerate: boolean;
    }
  ): readonly string[] => [
    "reference",
    "generate",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    ...flag("--model", one.model),
    ...(one.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
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
  /** Stage 3, previewed: the whole send, priced, with nothing sent. */
  previewShotList: (send: Send): readonly string[] => [
    "shot-list",
    "generate",
    send.projectId,
    send.episodeId,
    ...flag("--model", send.model),
    ...flag("--max-output-tokens", send.maxOutputTokens),
    ...(send.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 7, republished: the clip again, out of its own archive.
   *
   * The one command on this screen that writes without paying, and the one
   * that therefore has no preview: there is no bill to read before clicking,
   * because nothing is sent and no key is touched. What it does need is a
   * target, and that is why it appears only under chosen clips: it rewrites a
   * record and sends its review back to pending, so a bare republication would
   * quietly withdraw approvals nobody meant to withdraw.
   */
  republishClips: (
    one: TrackRef & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "clip",
    "generate",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    "--republish",
  ],
  /** Stage 0: the decisions of an episode that already exists. */
  setEpisode: (one: EpisodeRef & Settings): readonly string[] => [
    "episode",
    "set",
    one.projectId,
    one.episodeId,
    ...settings(one),
  ],
  /**
   * Stage 4, free: exactly what a later paid call would send, on one track.
   *
   * It is the one place rule 8 is visible before anything is sent, so it asks
   * for the object: the attachments of one future call, in the order their
   * bytes will travel, which the panel numbers as `Image N = <id> — <rola>`.
   * Finding that list inside a Polish sentence would be this client learning
   * the CLI's text format. Without `--artifact` it is the plan alone; with one,
   * that artifact's whole composed text comes with it.
   */
  showSendPlan: (one: TrackRef & { readonly artifact: string }): readonly string[] => [
    "prompt-package",
    "show",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...flag("--artifact", one.artifact),
    "--json",
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
export function buy(preview: Preview): readonly string[] {
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
