import { describe, expect, it } from "vitest";
import { run } from "../cli/index.js";
import { buy, commandLine, INTENTS } from "./commands.js";

/**
 * The client's one piece of knowledge about the CLI, checked against the CLI.
 *
 * Everything the screen can do is a command, and every command it can build
 * lives in one file, so that a renamed flag breaks a test rather than a button
 * somebody clicks a week later. The method is `docs.test.ts`'s, for the same
 * reason it is used there: `--help` is the contract, and a second copy of the
 * list of commands would drift from it exactly as the documentation would.
 *
 * Assumptions this file encodes:
 *
 * - **Every intent is an argv the usage text defines**, command word and
 *   flags alike. A button whose command the CLI would reject is a button that
 *   lies about being a terminal.
 * - **The argv shown and the argv sent are one array.** `commandLine` spells
 *   the same array a person could paste, which is what makes "the command is
 *   visible beside the button" true rather than decorative.
 * - **A purchase is derived from a preview, never built from a scope.** That
 *   is why it is a function of its own rather than an entry in the record:
 *   the dictionary's shape is what makes "two steps, always" checkable
 *   instead of remembered.
 */

const WORD = /^[a-z][a-z-]*$/;
/** Commands whose `generate` reaches no provider: stage 8 cuts locally. */
const FREE = new Set(["assembly"]);
const NO_DRY_RUN = /dry-run/;
const NO_RUN_ID = /identyfikator/;
const USAGE_LINE = /^ {2}(\S+)(?: (\S+))?/;
const FLAG = /--[a-z][a-z-]+/g;

/**
 * One object wide enough for every intent, which only this test ever holds.
 *
 * Each intent declares the narrow shape it needs, and the record they live in
 * is typed as taking this one, so a scope that grew a field nobody reads is a
 * type error rather than a dead value on a form. The test hands the same
 * object to all of them, because what it is checking is the argv, not who
 * assembles it.
 */
const scope = {
  artifact: "opening-frame",
  artifacts: ["card", "front"],
  aspectRatio: "16:9",
  audio: "narration",
  characterId: "ewa",
  dryRun: false,
  duckDb: "-12",
  duckRelease: "400",
  duration: "30",
  effectsDb: "-10",
  effectsModel: "eleven-sfx",
  episodeId: "01-burza",
  imageModel: "gpt-image-2.5-sunburst",
  language: "pl",
  maxClip: "15",
  maxOutputTokens: "12000",
  model: "gpt-6-astra",
  musicDb: "-18",
  musicModel: "eleven-music",
  name: "Ewa",
  nature: "law-or-idea",
  projectId: "dzielna-ewa",
  regenerate: false,
  similarity: "0.8",
  source: "/Users/ktos/Filmy/01-Burza.md",
  sources: ["/Users/ktos/Zdjecia/ewa-1.png"],
  speakerBoost: false,
  speed: "1",
  stability: "0.35",
  style: "0.4",
  subtitles: "none",
  title: "Dzielna Ewa",
  track: "gpt-image",
  videoModel: "dreamina-seedance-2-5-260628",
  voiceId: "voice-1",
  voiceModel: "eleven_multilingual_v2",
};

/**
 * Every argv this screen can build, the purchase included.
 *
 * The purchase is appended by hand because it is the one intent that cannot be
 * built from a scope, which is the rule the dictionary exists to enforce. It
 * still has to be checked against `--help` like the rest: a command nobody
 * could paste is no less wrong for having cost money.
 */
function everyIntent(): readonly (readonly [string, readonly string[]])[] {
  const preview = INTENTS.previewScreenplay(scope);

  return [
    ...Object.entries(INTENTS).map(([name, build]) => [name, build(scope)] as const),
    ["buy", buy({ argv: preview, runId: "9f1c" })] as const,
  ];
}

async function usage(): Promise<string> {
  const result = await run(["--help"]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

/** The commands the usage text defines, in the spelling it defines them. */
function commandsOf(text: string): Set<string> {
  const commands = new Set<string>();

  for (const line of text.split("\n")) {
    const [, first, second] = USAGE_LINE.exec(line) ?? [];

    if (!(first && WORD.test(first))) {
      continue;
    }

    commands.add(second && WORD.test(second) ? `${first} ${second}` : first);
  }

  return commands;
}

describe("the command dictionary", () => {
  it("should build only commands the usage text defines", async () => {
    const commands = commandsOf(await usage());
    const unknown: string[] = [];

    for (const [intent, argv] of everyIntent()) {
      const [first = "", second] = argv;

      if (second !== undefined && commands.has(`${first} ${second}`)) {
        continue;
      }

      if (!commands.has(first)) {
        unknown.push(`${intent}: ${first}`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it("should name only flags the usage text defines", async () => {
    const flags = new Set((await usage()).match(FLAG) ?? []);
    const unknown: string[] = [];

    for (const [intent, argv] of everyIntent()) {
      for (const argument of argv) {
        if (argument.startsWith("--") && !flags.has(argument)) {
          unknown.push(`${intent}: ${argument}`);
        }
      }
    }

    expect(unknown).toEqual([]);
  });

  it("should show the same argv it would send", () => {
    const argv = INTENTS.approveScreenplay(scope);

    expect(commandLine(argv)).toBe(`aimator ${argv.join(" ")}`);
  });

  /**
   * Two `generate` commands on this screen are not sends, and naming both
   * sharpens this claim rather than weakening it.
   *
   * `--republish` publishes a clip again out of its own archive: it touches no
   * key, reaches no provider and therefore has nothing to preview. Stage 8's
   * whole command is the other one, and for a stronger reason than a flag: it
   * buys nothing at all, from anybody, and what it needs instead is a program
   * on this machine. Everything else that reaches a model has to arrive here
   * as a dry run, because a purchase is derived from one and is the only
   * intent that cannot be built from a scope.
   */
  it("should build no purchase from a scope alone", () => {
    const spending = Object.entries(INTENTS).filter(([, build]) => {
      const argv = build(scope);

      return (
        argv.includes("generate") &&
        !(argv.includes("--dry-run") || argv.includes("--republish") || FREE.has(argv[0] ?? ""))
      );
    });

    expect(spending).toEqual([]);
  });
});

/**
 * Stage 0, the one stage a person fills in rather than buys.
 *
 * It has no bill and no preview, so what the dictionary owes here is narrower
 * and sharper: the **path** a person pastes out of Finder has to reach
 * `--source` byte for byte, because `episode.json` records it as the file's
 * origin. An upload would have recorded a temporary directory, which is why
 * the PRD refused one, and a client that trimmed, resolved or re-encoded the
 * string would have broken the same promise more quietly.
 */
describe("the stage-0 forms", () => {
  it("should hand the typed path to --source without touching it", () => {
    expect(INTENTS.addEpisode(scope)).toEqual([
      "episode",
      "add",
      "dzielna-ewa",
      "--source",
      "/Users/ktos/Filmy/01-Burza.md",
      "--duration",
      "30",
      "--audio",
      "narration",
      "--language",
      "pl",
      "--subtitles",
      "none",
      "--nature",
      "law-or-idea",
      "--max-clip",
      "15",
    ]);
  });

  /** Rule 7 at the edge of the screen: a field nobody filled in is undecided. */
  it("should leave out a decision the form was not given", () => {
    expect(
      INTENTS.setEpisode({
        ...scope,
        audio: "",
        language: "",
        maxClip: "",
        nature: "",
        subtitles: "",
      })
    ).toEqual(["episode", "set", "dzielna-ewa", "01-burza", "--duration", "30"]);
  });

  it("should spell every photograph as its own --source", () => {
    expect(
      INTENTS.addCharacterSources({
        ...scope,
        sources: ["/Zdjecia/ewa-1.png", "/Zdjecia/ewa-2.png"],
      })
    ).toEqual([
      "character",
      "add",
      "dzielna-ewa",
      "ewa",
      "--source",
      "/Zdjecia/ewa-1.png",
      "--source",
      "/Zdjecia/ewa-2.png",
    ]);
  });

  it("should name stage 0 when it asks about it, so the answer is stage 0 alone", () => {
    expect(INTENTS.checkPrepare(scope)).toEqual(["check", "dzielna-ewa", "--stage", "prepare"]);
    expect(INTENTS.approvePrepare(scope)).toEqual(["approve", "dzielna-ewa", "--stage", "prepare"]);
  });
});

/**
 * Stages 3 and 4, where one screen first asks about a track.
 *
 * The shot list and the package are shared by both productions and neither
 * names one, which is exactly why the **send plan** has to: `hero:ewa` and
 * `R01` become a file only at the sender, per track, and that resolution is
 * what answers the gate. So `show` is the one stage-4 command that carries
 * `--track`, and it asks for the object because the panel numbers the
 * attachments itself, `Image N = <id> — <rola>`, in the order the bytes go.
 */
describe("the stage-3 and stage-4 panels", () => {
  it("should name each stage when it asks about it, so the answer is that stage alone", () => {
    expect(INTENTS.checkShotList(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "shot-list",
    ]);
    expect(INTENTS.checkPromptPackage(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "prompt-package",
    ]);
    expect(INTENTS.approveShotList(scope)).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "shot-list",
    ]);
    expect(INTENTS.approvePromptPackage(scope)).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "prompt-package",
    ]);
  });

  it("should read the send plan of one track, and of one artifact when asked", () => {
    expect(INTENTS.showSendPlan({ ...scope, artifact: "" })).toEqual([
      "prompt-package",
      "show",
      "dzielna-ewa",
      "01-burza",
      "--track",
      "gpt-image",
      "--json",
    ]);
    expect(INTENTS.showSendPlan(scope)).toEqual([
      "prompt-package",
      "show",
      "dzielna-ewa",
      "01-burza",
      "--track",
      "gpt-image",
      "--artifact",
      "opening-frame",
      "--json",
    ]);
  });

  /** The same derivation, three stages over: what was previewed is what is bought. */
  it("should buy exactly the send each of them previewed", () => {
    for (const preview of [INTENTS.previewShotList(scope), INTENTS.previewPromptPackage(scope)]) {
      const bought = buy({ argv: preview, runId: "9f1c" });

      expect(bought).not.toContain("--dry-run");
      expect(bought).not.toContain("--json");
      expect(bought).toContain("gpt-6-astra");
      expect(bought.slice(0, 2)).toEqual(preview.slice(0, 2));
    }
  });
});

/**
 * Stage 2, the first panel where one click is about several pictures.
 *
 * The CLI takes a list, so the screen has to build one: accepting six
 * references or two views is one decision somebody made, and six clicks would
 * turn it into six commands, six approvals and six lines in an archive. That
 * is the whole of user story 13, and it is a property of the argv rather than
 * of the buttons, which is why it is checked here.
 */
describe("the stage-2 panel", () => {
  it("should put several chosen artifacts in one command", () => {
    expect(INTENTS.approveCharacter(scope)).toEqual([
      "approve",
      "dzielna-ewa",
      "ewa",
      "--stage",
      "character",
      "--track",
      "gpt-image",
      "--artifact",
      "card,front",
    ]);
    expect(INTENTS.previewCharacter(scope)).toEqual([
      "character",
      "generate",
      "dzielna-ewa",
      "ewa",
      "--track",
      "gpt-image",
      "--artifact",
      "card,front",
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--json",
    ]);
  });

  /** No choice is not an empty choice: the flag is then not spelled at all. */
  it("should leave --artifact out when nothing is chosen", () => {
    expect(INTENTS.previewCharacter({ ...scope, artifacts: [] })).toEqual([
      "character",
      "generate",
      "dzielna-ewa",
      "ewa",
      "--track",
      "gpt-image",
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--json",
    ]);
  });

  it("should ask about one character on one track, because the two cost separately", () => {
    expect(INTENTS.checkCharacter(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "ewa",
      "--stage",
      "character",
      "--track",
      "gpt-image",
    ]);
  });

  it("should buy exactly the pictures it previewed", () => {
    const preview = INTENTS.previewCharacter({ ...scope, regenerate: true });
    const bought = buy({ argv: preview, runId: "9f1c" });

    expect(bought).toContain("--regenerate");
    expect(bought).toContain("card,front");
    expect(bought).not.toContain("--dry-run");
  });
});

/**
 * Stages 5 and 6, where the same rule produces two different commands.
 *
 * Stage 5 accepts a **list**, because six references reviewed in one sitting
 * is one decision and six clicks would make it six commands. Stage 6 accepts
 * **nothing**, because it has one artifact: a flag with one legal value is
 * ceremony standing where a decision used to be, so the panel has none either.
 */
describe("the stage-5 and stage-6 panels", () => {
  it("should accept several references in one command, and the frame in none", () => {
    expect(INTENTS.approveReferences({ ...scope, artifacts: ["R01", "R02"] })).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "references",
      "--track",
      "gpt-image",
      "--artifact",
      "R01,R02",
    ]);
    expect(INTENTS.approveOpeningFrame(scope)).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "opening-frame",
      "--track",
      "gpt-image",
    ]);
    expect(INTENTS.approveOpeningFrame(scope)).not.toContain("--artifact");
    expect(INTENTS.previewOpeningFrame(scope)).not.toContain("--artifact");
  });

  it("should draw whatever the graph allows when no reference is named", () => {
    expect(INTENTS.previewReferences({ ...scope, artifacts: [] })).toEqual([
      "reference",
      "generate",
      "dzielna-ewa",
      "01-burza",
      "--track",
      "gpt-image",
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--json",
    ]);
  });

  it("should ask each of them about one track, because the two cost separately", () => {
    expect(INTENTS.checkReferences(scope)).toContain("references");
    expect(INTENTS.checkOpeningFrame(scope)).toContain("opening-frame");

    for (const argv of [INTENTS.checkReferences(scope), INTENTS.checkOpeningFrame(scope)]) {
      expect(argv).toContain("--track");
      expect(argv).toContain("gpt-image");
    }
  });
});

/**
 * Stage 7, where one command buys in **two currencies**.
 *
 * Everything above it has one `--model`, because one call buys one thing. Here
 * an entry frame is drawn by this track's image model and a clip is rendered
 * by the one video model both tracks share, so `--model` does not say which,
 * and the CLI refuses it with a sentence rather than picking. The dictionary
 * spells the two flags it does take, which is the whole of user story 22: the
 * screen must not be able to express less than the command.
 *
 * The rest is stage 5's arrangement over two media: a list of artifacts in one
 * command, because a clip and its entry frame reviewed in one sitting is one
 * decision, and the ids are the CLI's own, `C01` and `entry:C02`.
 */
describe("the stage-7 panel", () => {
  it("should accept a clip and an entry frame in one command", () => {
    expect(INTENTS.approveClips({ ...scope, artifacts: ["C01", "entry:C02"] })).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "clips",
      "--track",
      "gpt-image",
      "--artifact",
      "C01,entry:C02",
    ]);
  });

  it("should name the two models the stage actually has, and no bare --model", () => {
    const preview = INTENTS.previewClips({ ...scope, artifacts: [] });

    expect(preview).toEqual([
      "clip",
      "generate",
      "dzielna-ewa",
      "01-burza",
      "--track",
      "gpt-image",
      "--image-model",
      "gpt-image-2.5-sunburst",
      "--video-model",
      "dreamina-seedance-2-5-260628",
      "--dry-run",
      "--json",
    ]);
    expect(preview).not.toContain("--model");
  });

  it("should buy exactly the chain link it previewed", () => {
    const preview = INTENTS.previewClips({ ...scope, artifacts: ["C02"], regenerate: true });
    const bought = buy({ argv: preview, runId: "9f1c" });

    expect(bought).toContain("--regenerate");
    expect(bought).toContain("C02");
    expect(bought).not.toContain("--dry-run");
    expect(bought).not.toContain("--json");
  });

  /**
   * The one command in this tool that writes without paying.
   *
   * A republication decides again what the still that came back with a clip
   * is, out of the archive, sending nothing. It is not a purchase, so it has
   * no preview: what it needs instead is a target, because it rewrites a
   * record a human may already have accepted.
   */
  it("should aim a republication at named clips and never at everything", () => {
    expect(INTENTS.republishClips({ ...scope, artifacts: ["C01"] })).toEqual([
      "clip",
      "generate",
      "dzielna-ewa",
      "01-burza",
      "--track",
      "gpt-image",
      "--artifact",
      "C01",
      "--republish",
    ]);
  });

  it("should ask about one track, because the two are rendered separately", () => {
    expect(INTENTS.checkClips(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "clips",
      "--track",
      "gpt-image",
    ]);
  });
});

/**
 * Two steps before every purchase, made structural rather than promised.
 *
 * The screen has one dangerous button and the rule around it is the PRD's:
 * "Generuj" previews and "Kup" spends, always in that order, with no threshold
 * and no exception. A flag on a click would be a rule somebody has to
 * remember; instead the purchase takes a **finished dry run** as its only
 * input and is the same argv with the dry run taken off, so a person cannot
 * preview one send and buy another. The model, the token budget and the new
 * attempt travel across for free, because they are already in the array.
 */
describe("the two steps of a paid call", () => {
  it("should preview the send without making it, and ask for the object", () => {
    expect(INTENTS.previewScreenplay(scope)).toEqual([
      "screenplay",
      "generate",
      "dzielna-ewa",
      "01-burza",
      "--model",
      "gpt-6-astra",
      "--max-output-tokens",
      "12000",
      "--dry-run",
      "--json",
    ]);
  });

  it("should leave out a flag the panel left empty", () => {
    expect(INTENTS.previewScreenplay({ ...scope, maxOutputTokens: "", model: "" })).toEqual([
      "screenplay",
      "generate",
      "dzielna-ewa",
      "01-burza",
      "--dry-run",
      "--json",
    ]);
  });

  /**
   * The purchase is the previewed send; only how it answers differs.
   *
   * `--json` comes off with the dry run, and the two removals are not the same
   * kind of thing. Taking off `--dry-run` changes what is sent, which is the
   * whole purchase. Taking off `--json` changes nothing about the send: the
   * preview is arranged by the panel and the purchase is read whole, by a
   * person, in the words the terminal would have used. What stays is every
   * argument that decides what the money buys.
   */
  it("should buy exactly the send that was previewed", () => {
    expect(buy({ argv: INTENTS.previewScreenplay(scope), runId: "9f1c" })).toEqual([
      "screenplay",
      "generate",
      "dzielna-ewa",
      "01-burza",
      "--model",
      "gpt-6-astra",
      "--max-output-tokens",
      "12000",
    ]);
  });

  it("should carry a new paid attempt through both steps", () => {
    const preview = INTENTS.previewScreenplay({ ...scope, regenerate: true });

    expect(preview).toContain("--regenerate");
    expect(buy({ argv: preview, runId: "9f1c" })).toContain("--regenerate");
  });

  it("should refuse to build a purchase with no finished dry run behind it", () => {
    expect(() => buy({ argv: INTENTS.checkScreenplay(scope), runId: "9f1c" })).toThrow(NO_DRY_RUN);
    expect(() => buy({ argv: INTENTS.previewScreenplay(scope), runId: "" })).toThrow(NO_RUN_ID);
  });
});

/**
 * Stage 9, the first stage the dictionary has to keep apart at two levels.
 *
 * The words are shared by both tracks and the mix is not, so `--track` is not
 * a narrowing here but a **choice of question**, and a screen that built one
 * command for both would be asking about a film when somebody was reading a
 * script. The same split runs through the approvals: accepting the script is
 * what authorises buying the recordings, and accepting the recordings is a
 * different yes about different bytes. Two decisions, two commands.
 */
describe("the stage-9 commands", () => {
  it("should accept the script and the lines with two different commands", () => {
    const script = INTENTS.approveNarrationScript(scope);
    const lines = INTENTS.approveNarrationLines({ ...scope, artifacts: ["N01", "N02"] });

    expect(script).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "soundtrack",
      "--artifact",
      "script",
    ]);
    expect(lines).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "soundtrack",
      "--artifact",
      "N01,N02",
    ]);
    expect(script).not.toEqual(lines);
  });

  it("should ask about the words and about one track's mix with two commands", () => {
    expect(INTENTS.checkNarration(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "soundtrack",
    ]);
    expect(INTENTS.checkMix(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "soundtrack",
      "--track",
      "gpt-image",
    ]);
  });

  /** Rule 7 again: a slider the form was not given is not a value of zero. */
  it("should leave out a reading nobody dialled in", () => {
    expect(
      INTENTS.directNarrator({
        projectId: "dzielna-ewa",
        similarity: "",
        speakerBoost: false,
        speed: "",
        stability: "0.35",
        style: "",
      })
    ).toEqual(["narration", "direction", "dzielna-ewa", "--stability", "0.35"]);
  });
});

/**
 * Stage 10, the same two levels one row down, and three models instead of two.
 *
 * The sheet and the stems are shared by both tracks and the full mix is not,
 * so `--track` is the choice of question here exactly as it is one row up, and
 * accepting the sheet is what authorises buying the stems, which makes it a
 * different yes about different bytes from accepting what came back.
 *
 * The three model flags are the stage rather than a naming habit: one text
 * model writes the cue sheet, one composes a bed and one renders an effect, so
 * a bare `--model` would not say which, and a screen offering one would be
 * offering a refusal.
 */
describe("the stage-10 commands", () => {
  it("should accept the cue sheet and the stems with two different commands", () => {
    const cues = INTENTS.approveCueSheet(scope);
    const stems = INTENTS.approveStems({ ...scope, artifacts: ["M01", "E01"] });

    expect(cues).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "sound-design",
      "--artifact",
      "cues",
    ]);
    expect(stems).toEqual([
      "approve",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "sound-design",
      "--artifact",
      "M01,E01",
    ]);
    expect(cues).not.toEqual(stems);
  });

  it("should ask about the stems and about one track's master with two commands", () => {
    expect(INTENTS.checkSoundDesign(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "sound-design",
    ]);
    expect(INTENTS.checkMaster(scope)).toEqual([
      "check",
      "dzielna-ewa",
      "01-burza",
      "--stage",
      "sound-design",
      "--track",
      "gpt-image",
    ]);
  });

  it("should name all three models the stage buys from", () => {
    expect(INTENTS.previewSoundDesign(scope)).toEqual([
      "sound-design",
      "generate",
      "dzielna-ewa",
      "01-burza",
      "--artifact",
      "card,front",
      "--model",
      "gpt-6-astra",
      "--music-model",
      "eleven-music",
      "--effects-model",
      "eleven-sfx",
      "--max-output-tokens",
      "12000",
      "--dry-run",
      "--json",
    ]);
  });

  /** Rule 7 once more: a fader the form was not given is not zero decibels. */
  it("should leave out a level nobody set", () => {
    expect(
      INTENTS.setLevels({
        duckDb: "",
        duckRelease: "",
        effectsDb: "",
        musicDb: "-22",
        projectId: "dzielna-ewa",
      })
    ).toEqual(["sound-design", "levels", "dzielna-ewa", "--music-db", "-22"]);
  });
});
