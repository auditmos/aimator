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

/** A document brought in before any project: beside the projects, never inside one. */
interface ImportRef {
  readonly importId: string;
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
 * A new paid attempt over a result already published, and the note it carries.
 *
 * The note belongs to the attempt rather than standing as a flag of its own:
 * the CLI refuses `--instruction` without `--regenerate`, because correcting a
 * published version is a new paid attempt. So a note left in a box after the
 * attempt was switched off is not spelled, and an empty one never is.
 */
interface Attempt {
  /** What the published version gets wrong, verbatim, as a person wrote it. */
  readonly instruction: string;
  /** A second paid attempt over a result that already exists. */
  readonly regenerate: boolean;
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
interface Send extends Attempt, EpisodeRef {
  readonly maxOutputTokens: string;
  readonly model: string;
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
 * A yes on a frame ready for animation, and the QC criteria a person ticked.
 *
 * The list is what was ticked, never what the stage requires: a box left
 * empty is not spelled, so the CLI answers with its own refusal naming what is
 * missing, rather than this screen saying yes on somebody's behalf. An empty
 * list spells no flag, which is also what a yes on clips alone needs.
 */
interface Judged extends TrackRef {
  readonly checks: readonly string[];
}

/**
 * A no, and why. The CLI refuses one without a reason, because the reason is
 * what the next new paid attempt corrects by when nobody writes an
 * instruction, so it is sent exactly as typed.
 */
interface Refusal {
  readonly note: string;
}

/** A no on a frame ready for animation, and the QC criteria it was marked as missing. */
interface Failed extends Refusal {
  readonly failed: readonly string[];
}

/**
 * How the narrator of a series reads: five knobs, none of them a number here.
 *
 * Strings for the reason every settings field is one: an empty box means the
 * flag is not spelled at all and whatever was decided last stands. Coercing
 * `""` to `0` would be this client dialling `style` down to the flattest value
 * the provider has, which is precisely the silent default this file exists on
 * the far side of.
 */
interface Delivery extends ProjectRef {
  readonly similarity: string;
  readonly speakerBoost: boolean;
  readonly speed: string;
  readonly stability: string;
  readonly style: string;
}

/**
 * How loud this series sits, and how far the bed gives way under a voice.
 *
 * Strings for `Delivery`'s reason, read one level finer. An empty box means
 * the flag is not spelled and whatever was decided last stands; coercing `""`
 * to `0` would be this client putting the music at full level, which is the
 * one value nobody would ever dial in on purpose.
 */
interface Levels extends ProjectRef {
  readonly duckDb: string;
  readonly duckRelease: string;
  readonly effectsDb: string;
  readonly musicDb: string;
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

/** `--checks anatomy,style`: the criteria ticked, or no flag when none was. */
function checklist(names: readonly string[]): readonly string[] {
  return names.length === 0 ? [] : ["--checks", names.join(",")];
}

/** `--fail anatomy`: the criteria a refused frame missed, or no flag when none was marked. */
function failing(names: readonly string[]): readonly string[] {
  return names.length === 0 ? [] : ["--fail", names.join(",")];
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

/** `--regenerate [--instruction <uwaga>]`, exactly as the usage text nests them. */
function attempt(one: Attempt): readonly string[] {
  return one.regenerate ? ["--regenerate", ...flag("--instruction", one.instruction)] : [];
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
interface Everything extends Delivery, Failed, ImportRef, Judged, Levels, Send, Settings {
  readonly artifact: string;
  readonly artifacts: readonly string[];
  readonly aspectRatio: string;
  readonly characterId: string;
  /** Stage 8 alone: the free `generate` that shows the cut without writing it. */
  readonly dryRun: boolean;
  /** Stage 10's third model: the one that renders one effect. */
  readonly effectsModel: string;
  /** Stage 12: face id to character, as a person bound them in one clip. */
  readonly faces: Readonly<Record<string, string>>;
  /** Stage 0: an episode's idea typed on screen, which becomes `source.md`. */
  readonly idea: string;
  readonly imageModel: string;
  /** Stage 10's second model: the one that composes a bed. */
  readonly musicModel: string;
  readonly name: string;
  readonly source: string;
  readonly sources: readonly string[];
  readonly title: string;
  readonly videoModel: string;
  readonly voiceId: string;
  /** Stage 9's second provider: the model that reads, not the one that lifts. */
  readonly voiceModel: string;
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
interface ClipSend extends Attempt, TrackRef {
  readonly artifacts: readonly string[];
  readonly imageModel: string;
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
   * Stage 0: the episode from an idea typed on screen rather than a file.
   *
   * `--episode` carries what a file's name would have, the number and the
   * slug, and the screen never derives it: an episode's number is a decision.
   * The text travels exactly as typed, line breaks included, because it is
   * what `source.md` will hold.
   */
  addEpisodeIdea: (one: EpisodeRef & Settings & { readonly idea: string }): readonly string[] => [
    "episode",
    "add",
    one.projectId,
    "--idea",
    one.idea,
    "--episode",
    one.episodeId,
    ...settings(one),
  ],
  /**
   * Before stage 0: a Word document copied in and converted, for free.
   *
   * By path, like every file this screen hands the CLI: the screen takes no
   * upload, and the import records where the document came from. `--json`,
   * because the panel lays the sections and pictures out rather than reading
   * a sentence about them.
   */
  addImport: (one: ImportRef & { readonly source: string }): readonly string[] => [
    "import",
    "add",
    one.importId,
    "--source",
    one.source,
    "--json",
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
  approveClips: (one: Judged & { readonly artifacts: readonly string[] }): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "clips",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    ...checklist(one.checks),
  ],
  /**
   * Stage 10, accepted: the cue sheet, which is the gate the stems wait on.
   *
   * Its own command rather than a consequence of accepting what came back,
   * for stage 9's reason one row down: this yes is what authorises spending,
   * and the yes about the bought bytes is a different decision entirely. It
   * is also the last yes in this pipeline that a person gives before any
   * money moves.
   */
  approveCueSheet: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "approve",
    projectId,
    episodeId,
    "--stage",
    "sound-design",
    "--artifact",
    "cues",
  ],
  /**
   * Stage 11, accepted: whatever was chosen, in one command.
   *
   * Unlike stages 9 and 10 the script and the lines share one command,
   * because the CLI takes them in one list (`script,D01,en:D01`) and each key
   * still names exactly one yes: the script's opens buying the film's lines,
   * the translation's opens buying the lines in the language of the mouths,
   * and a line's is about the recording someone listened to. An empty choice
   * spells no flag, and the CLI refuses that rather than reading it as all.
   */
  approveDialogue: (
    one: EpisodeRef & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "dialogue",
    ...artifacts(one.artifacts),
  ],
  /**
   * Stage 12, accepted: one finished film, by its language.
   *
   * A film is its own judgement rather than one of a list, and the one whose
   * mouths moved is accepted against a checklist, so it carries what was
   * ticked and the CLI names what was not; the other film has none to tick.
   */
  approveFilm: (one: Judged & { readonly artifact: string }): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "versions",
    "--track",
    one.track,
    "--artifact",
    one.artifact,
    ...checklist(one.checks),
  ],
  /**
   * Stage 10, accepted: this track's full mix, and nothing to narrow.
   *
   * `--track` is the choice of question rather than a narrowing, exactly as
   * it is at stage 9: without it the same command accepts the sheet or the
   * stems, which were bought once and belong to both films.
   */
  approveMaster: (one: TrackRef): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "sound-design",
    "--track",
    one.track,
  ],
  /**
   * Stage 9, accepted: this track's narrated cut, and nothing to narrow.
   *
   * `--track` here is not a narrowing but the **choice of question**: without
   * it the same command accepts the words, which are shared by both tracks and
   * were bought once. That is why there are four stage-9 approvals rather than
   * one with flags: two levels of the tree, and two decisions at the top one.
   */
  approveMix: (one: TrackRef): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "soundtrack",
    "--track",
    one.track,
  ],
  /**
   * Stage 9, accepted: recordings, listened to, several at a time.
   *
   * A recording is accepted by **hearing** it, exactly as an image is accepted
   * by looking at one, so several in a sitting is one decision and one command.
   * It is a different command from the script's for a reason that outlives the
   * flag: accepting the script is what authorises the buying, and accepting
   * what came back is a yes about different bytes entirely.
   */
  approveNarrationLines: (
    one: EpisodeRef & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "soundtrack",
    ...artifacts(one.artifacts),
  ],
  /** Stage 9, accepted: the script, which is the gate the recordings wait on. */
  approveNarrationScript: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "approve",
    projectId,
    episodeId,
    "--stage",
    "soundtrack",
    "--artifact",
    "script",
  ],
  /**
   * Stage 6, accepted: the one frame, and no `--artifact` anywhere near it.
   *
   * Stage 5 demands the flag because it has several candidates and accepting
   * the wrong one buys an image. Here the command already says which stage and
   * which track, and there is nothing else it could mean, so a flag with one
   * legal value would be ceremony standing where a decision used to be.
   */
  approveOpeningFrame: (one: Judged): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "opening-frame",
    "--track",
    one.track,
    ...checklist(one.checks),
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
   * Stage 10, accepted: stems, listened to, several at a time.
   *
   * A bed is accepted by **hearing** it under the picture it was written for,
   * the same act an image asks for one sense over, so several in a sitting is
   * one decision and one command. The ids are the CLI's own, `M01` for a bed
   * and `E01` for an effect.
   */
  approveStems: (
    one: EpisodeRef & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "sound-design",
    ...artifacts(one.artifacts),
  ],
  /**
   * Stage 12, accepted: clips whose mouths a person watched land on the lines.
   *
   * Each is its own judgement, so the CLI asks for the list rather than reading
   * none as all, and an empty choice spells no flag for it to refuse.
   */
  approveVersions: (
    one: TrackRef & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "approve",
    one.projectId,
    one.episodeId,
    "--stage",
    "versions",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
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
   * Stage 12: who each face in one clip is, as a person said it.
   *
   * A decision rather than a purchase, so it is written at once and has no
   * preview: nothing is sent and no key is read. Face id to character, in the
   * order chosen; an empty choice spells no `--face`, and the CLI refuses that
   * rather than this screen guessing, because a face is never inferred, not
   * even when the clip shows one.
   */
  bindFaces: (
    one: TrackRef & {
      readonly artifact: string;
      readonly faces: Readonly<Record<string, string>>;
    }
  ): readonly string[] => [
    "versions",
    "bind",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    "--artifact",
    one.artifact,
    ...flag(
      "--face",
      Object.entries(one.faces)
        .map(([face, cast]) => `${face}=${cast}`)
        .join(",")
    ),
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
  /** Stage 11, verified: the script, its translation and every line, shared, with no track. */
  checkDialogue: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "dialogue",
  ],
  /** Stage 10, verified: this track's full mix, where every sound landed. */
  checkMaster: (one: TrackRef): readonly string[] => [
    "check",
    one.projectId,
    one.episodeId,
    "--stage",
    "sound-design",
    "--track",
    one.track,
  ],
  /** Stage 9, verified: this track's mix, which is where the words landed. */
  checkMix: (one: TrackRef): readonly string[] => [
    "check",
    one.projectId,
    one.episodeId,
    "--stage",
    "soundtrack",
    "--track",
    one.track,
  ],
  /** Stage 9, verified: the words, shared, with no track to ask about. */
  checkNarration: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "soundtrack",
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
  /** Stage 10, verified: the sheet and the stems, shared, with no track. */
  checkSoundDesign: ({ episodeId, projectId }: EpisodeRef): readonly string[] => [
    "check",
    projectId,
    episodeId,
    "--stage",
    "sound-design",
  ],
  /** Stage 12, verified: one track's clips, their faces and who each face is. */
  checkVersions: (one: TrackRef): readonly string[] => [
    "check",
    one.projectId,
    one.episodeId,
    "--stage",
    "versions",
    "--track",
    one.track,
  ],
  /** Stage 0: this character is drawn from `project.md`, not from photographs. */
  describeCharacter: (one: CastRef): readonly string[] => [
    "character",
    "describe",
    one.projectId,
    one.characterId,
  ],
  /**
   * Stage 9: how the narrator of this series reads, which is direction.
   *
   * A project-level command, because a reading recurs between episodes exactly
   * as a cast does, and one that writes stage 9's own file rather than stage
   * 0's: `project.json` is a recorded input of nearly everything in the
   * workspace, so a knob somebody is expected to turn would lapse approvals on
   * bytes it never touched. The voice is casting and lives there; how that
   * voice performs is direction and lives here.
   *
   * An empty field is not a value, rule 7 at the edge of the screen: the flag
   * is not spelled at all and whatever was decided last stands.
   */
  directNarrator: (one: Delivery): readonly string[] => [
    "narration",
    "direction",
    one.projectId,
    ...flag("--stability", one.stability),
    ...flag("--style", one.style),
    ...flag("--speed", one.speed),
    ...flag("--similarity", one.similarity),
    ...(one.speakerBoost ? ["--speaker-boost"] : []),
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
   * Stage 12: one language's film of this track, laid over the shared picture.
   *
   * Stage 8's reading, because it buys nothing either: the local engine cuts
   * the picture once and lays one language's lines over it beside the stems,
   * so `--dry-run` is the plan rather than a bill, and the same command lays
   * the film without it. `--regenerate` guards an accepted film, not a wallet.
   */
  makeFilm: (
    one: TrackRef & {
      readonly dryRun: boolean;
      readonly language: string;
      readonly regenerate: boolean;
    }
  ): readonly string[] => [
    "versions",
    "final",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    "--language",
    one.language,
    ...(one.regenerate ? ["--regenerate"] : []),
    ...(one.dryRun ? ["--dry-run"] : []),
    "--json",
  ],
  /**
   * Stage 9's per-track half: it buys nothing, so it has no preview.
   *
   * Like stage 8 it needs a program on this machine rather than a provider,
   * and unlike stage 8 it has nothing to show before running: where each line
   * lands is arithmetic over a film that already exists, and the report says
   * it afterwards. A line that would talk over the next one is a refusal here
   * rather than a nudge, because the anchor came from a plan a human approved.
   */
  mixNarration: (one: TrackRef & { readonly regenerate: boolean }): readonly string[] => [
    "narration",
    "mix",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...(one.regenerate ? ["--regenerate"] : []),
    "--json",
  ],
  /**
   * Stage 10's per-track half: it buys nothing, so it has no preview.
   *
   * Like stage 9's it needs a program on this machine rather than a provider,
   * and it rebuilds from `episode.mp4` and the lossless stems rather than
   * laying music over `narrated.mp4`, which is the only arrangement that
   * encodes the speech once and the only one in which the bed can step back
   * under a voice.
   */
  mixSoundDesign: (one: TrackRef & { readonly regenerate: boolean }): readonly string[] => [
    "sound-design",
    "mix",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...(one.regenerate ? ["--regenerate"] : []),
    "--json",
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
    one: Attempt & CharacterTrackRef & { readonly model: string }
  ): readonly string[] => [
    "character",
    "generate",
    one.projectId,
    one.characterId,
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    ...flag("--model", one.model),
    ...attempt(one),
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
    ...attempt(one),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 11, previewed: the script's one text call, or the lines' bill, in
   * either language.
   *
   * Stage 9's shape one row down, with one flag more. `--language` is what
   * chooses which lines are bought: none, or the film's own, means the lines of
   * the script; the language of the mouths means the lines of the accepted
   * translation, keyed `en:D01`. It is a flag rather than a second command
   * because the CLI made it one: both are the same purchase read from a
   * different script. An empty language is not spelled, rule 7 at the edge of
   * the screen, so the CLI's own answer stands.
   */
  previewDialogue: (
    one: Send & {
      readonly artifacts: readonly string[];
      readonly language: string;
      readonly voiceModel: string;
    }
  ): readonly string[] => [
    "dialogue",
    "generate",
    one.projectId,
    one.episodeId,
    ...artifacts(one.artifacts),
    ...flag("--language", one.language),
    ...flag("--model", one.model),
    ...flag("--voice-model", one.voiceModel),
    ...flag("--max-output-tokens", one.maxOutputTokens),
    ...attempt(one),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 12, previewed: the faces in one clip, one paid face call.
   *
   * Exactly one clip, because one call finds the faces of one; the CLI refuses
   * a list. A second call on the same clip is a second charge, so it takes a
   * new attempt, and no note: nothing here is written by a model that reads.
   */
  previewFaces: (
    one: TrackRef & { readonly artifact: string; readonly regenerate: boolean }
  ): readonly string[] => [
    "versions",
    "faces",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...flag("--artifact", one.artifact),
    ...(one.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /**
   * An import's grouping, previewed: the sections as they would be sent, and
   * a bill of one call. Bought through `buy`, like every other paid send.
   */
  previewGrouping: (
    one: Attempt &
      ImportRef & {
        readonly maxOutputTokens: string;
        readonly model: string;
      }
  ): readonly string[] => [
    "import",
    "group",
    one.importId,
    ...flag("--model", one.model),
    ...flag("--max-output-tokens", one.maxOutputTokens),
    ...attempt(one),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 12, previewed: the jobs that move the mouths, and their two bills.
   *
   * No choice is every clip the gates allow, and a choice narrows the purchase
   * to it. The bill is face calls and lip-sync jobs counted apart, because a
   * second speaker in a clip costs a face call beside its job.
   */
  previewLipSync: (
    one: TrackRef & { readonly artifacts: readonly string[]; readonly regenerate: boolean }
  ): readonly string[] => [
    "versions",
    "lip-sync",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    ...(one.regenerate ? ["--regenerate"] : []),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 9, previewed: the script's one text call, or the recordings' bill.
   *
   * One command covers both halves, and which one it is doing is the report's
   * answer rather than a flag: until the script exists and a human has
   * accepted it, this buys the script; afterwards it buys the lines that yes
   * authorised. Two model flags, because the stage buys from two providers and
   * a bare `--model` would not say which: the same refusal stage 7 makes.
   *
   * What the preview is for is different here too. Every stage above this one
   * is billed per call; this provider charges for the **characters** of the
   * text it is handed, so the count of calls has stopped being the bill and
   * the report prints both.
   */
  previewNarration: (
    one: Send & { readonly artifacts: readonly string[]; readonly voiceModel: string }
  ): readonly string[] => [
    "narration",
    "generate",
    one.projectId,
    one.episodeId,
    ...artifacts(one.artifacts),
    ...flag("--model", one.model),
    ...flag("--voice-model", one.voiceModel),
    ...flag("--max-output-tokens", one.maxOutputTokens),
    ...attempt(one),
    "--dry-run",
    "--json",
  ],
  /** Stage 6, previewed: one image or the reason there is none. */
  previewOpeningFrame: (
    one: Attempt & TrackRef & { readonly model: string }
  ): readonly string[] => [
    "opening-frame",
    "generate",
    one.projectId,
    one.episodeId,
    "--track",
    one.track,
    ...flag("--model", one.model),
    ...attempt(one),
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
    ...attempt(send),
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
    one: Attempt &
      TrackRef & {
        readonly artifacts: readonly string[];
        readonly model: string;
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
    ...attempt(one),
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
    ...attempt(send),
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
    ...attempt(send),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 10, previewed: the sheet's one text call, or the stems' bill.
   *
   * One command covers both halves and the report says which it is doing,
   * exactly as at stage 9: until the cue sheet exists and a human has accepted
   * it, this buys the sheet; afterwards it buys the stems that yes authorised.
   *
   * Three model flags, because the stage buys from three call sites. What the
   * preview is for differs again: this provider rates **per minute of
   * generated audio** and charges at generation, so the count of calls says
   * nothing about the money and a regeneration is a second full charge.
   */
  previewSoundDesign: (
    one: Send & {
      readonly artifacts: readonly string[];
      readonly effectsModel: string;
      readonly musicModel: string;
    }
  ): readonly string[] => [
    "sound-design",
    "generate",
    one.projectId,
    one.episodeId,
    ...artifacts(one.artifacts),
    ...flag("--model", one.model),
    ...flag("--music-model", one.musicModel),
    ...flag("--effects-model", one.effectsModel),
    ...flag("--max-output-tokens", one.maxOutputTokens),
    ...attempt(one),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 11, previewed: the script in the language of the mouths, one text call.
   *
   * No `--artifact`, because there is one translation per episode and a flag
   * with one legal value is ceremony; no language either, because which one
   * is the episode's `lip-sync.json`, a decision stage 0 stores and this
   * screen never makes on its behalf.
   */
  previewTranslation: (send: Send): readonly string[] => [
    "dialogue",
    "translate",
    send.projectId,
    send.episodeId,
    ...flag("--model", send.model),
    ...flag("--max-output-tokens", send.maxOutputTokens),
    ...attempt(send),
    "--dry-run",
    "--json",
  ],
  /**
   * Stage 2, refused: the chosen pictures of one character, and why.
   *
   * Every rejection below names what it refuses, and the panels offer it only
   * over a choice: with no `--artifact` the CLI reads a no as one about every
   * artifact in the file, which on a gallery is a decision nobody made.
   */
  rejectCharacter: (one: CharacterTrackRef & Refusal): readonly string[] => [
    "reject",
    one.projectId,
    one.characterId,
    "--stage",
    "character",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    "--note",
    one.note,
  ],
  /** Stage 7, refused: chosen links, and the criteria the entry frames among them missed. */
  rejectClips: (
    one: TrackRef & Failed & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "reject",
    one.projectId,
    one.episodeId,
    "--stage",
    "clips",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    "--note",
    one.note,
    ...failing(one.failed),
  ],
  /**
   * Stage 11, refused: the chosen script, translation or lines, and why.
   *
   * The script's note and the translation's are what the next new attempt
   * corrects by, through the text call; a line's has no model to read it, so
   * there it is the reason on record and the next purchase simply buys again.
   */
  rejectDialogue: (
    one: EpisodeRef & Refusal & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "reject",
    one.projectId,
    one.episodeId,
    "--stage",
    "dialogue",
    ...artifacts(one.artifacts),
    "--note",
    one.note,
  ],
  /** Stage 6, refused: the one frame, so no `--artifact`, as on its yes. */
  rejectOpeningFrame: (one: TrackRef & Failed): readonly string[] => [
    "reject",
    one.projectId,
    one.episodeId,
    "--stage",
    "opening-frame",
    "--track",
    one.track,
    "--note",
    one.note,
    ...failing(one.failed),
  ],
  /** Stage 5, refused: the chosen references; none is judged against a checklist. */
  rejectReferences: (
    one: TrackRef & Refusal & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "reject",
    one.projectId,
    one.episodeId,
    "--stage",
    "references",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    "--note",
    one.note,
  ],
  /**
   * Stage 12, refused: the chosen clips' versions or a film, and why.
   *
   * No model reads the note: a lip-sync is a sound and a face, so the reason
   * is what the record says, and the way out is a new job or a new binding.
   * The film whose mouths moved was accepted against a checklist, so a no
   * about it may carry what it missed; a clip's version has none to miss.
   */
  rejectVersions: (
    one: TrackRef & Failed & { readonly artifacts: readonly string[] }
  ): readonly string[] => [
    "reject",
    one.projectId,
    one.episodeId,
    "--stage",
    "versions",
    "--track",
    one.track,
    ...artifacts(one.artifacts),
    "--note",
    one.note,
    ...failing(one.failed),
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
   * Stage 10: how loud this series sits, which is neither casting nor reading.
   *
   * `narration/delivery` one level finer, and in its own file for the reason
   * that one is not in `project.json`: how loud the bed sits under a narrator
   * says nothing about how that narrator read, so changing the mix must not
   * lapse a recording. Two knobs, two scopes, two files.
   *
   * It has starting values where nothing else in this pipeline does, and the
   * justification is its own: **this decision cannot be made before it is
   * heard**, so refusing the first mix would demand an answer nobody is yet in
   * a position to form, and a mix costs nothing to redo. An empty field is
   * still undecided, so the flag is not spelled at all.
   */
  setLevels: (one: Levels): readonly string[] => [
    "sound-design",
    "levels",
    one.projectId,
    ...flag("--music-db", one.musicDb),
    ...flag("--effects-db", one.effectsDb),
    ...flag("--duck-db", one.duckDb),
    ...flag("--duck-release", one.duckRelease),
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

/** What a POSIX shell reads as one word without quotes, Polish letters included. */
const BARE = /^[\p{L}\p{N}_@%+=:,./-]+$/u;

/** One argument as a shell reads it: bare where it can be, single-quoted otherwise. */
function shellWord(one: string): string {
  return BARE.test(one) ? one : `'${one.replaceAll("'", "'\\''")}'`;
}

/**
 * The same argv, spelled the way a terminal takes it.
 *
 * Quoted, because the line is one a person pastes: a note or a title is
 * several words, and unquoted a shell would hand the CLI each of them apart.
 */
export function commandLine(argv: readonly string[]): string {
  return ["aimator", ...argv.map(shellWord)].join(" ");
}
