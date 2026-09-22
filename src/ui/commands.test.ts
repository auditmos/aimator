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
  aspectRatio: "16:9",
  audio: "narration",
  characterId: "ewa",
  duration: "30",
  episodeId: "01-burza",
  language: "pl",
  maxClip: "15",
  maxOutputTokens: "12000",
  model: "gpt-6-astra",
  name: "Ewa",
  nature: "law-or-idea",
  projectId: "dzielna-ewa",
  regenerate: false,
  source: "/Users/ktos/Filmy/01-Burza.md",
  sources: ["/Users/ktos/Zdjecia/ewa-1.png"],
  subtitles: "none",
  title: "Dzielna Ewa",
  track: "gpt-image",
  voiceId: "voice-1",
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

  it("should build no purchase from a scope alone", () => {
    const spending = Object.entries(INTENTS).filter(
      ([, build]) => build(scope).includes("generate") && !build(scope).includes("--dry-run")
    );

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
