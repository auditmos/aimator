import { describe, expect, it } from "vitest";
import { run } from "../cli/index.js";
import { buyScreenplay, commandLine, INTENTS } from "./commands.js";

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

const scope = {
  episodeId: "01-burza",
  maxOutputTokens: "12000",
  model: "gpt-6-astra",
  projectId: "dzielna-ewa",
  regenerate: false,
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
    ["buyScreenplay", buyScreenplay({ argv: preview, runId: "9f1c" })] as const,
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
    expect(buyScreenplay({ argv: INTENTS.previewScreenplay(scope), runId: "9f1c" })).toEqual([
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
    expect(buyScreenplay({ argv: preview, runId: "9f1c" })).toContain("--regenerate");
  });

  it("should refuse to build a purchase with no finished dry run behind it", () => {
    expect(() => buyScreenplay({ argv: INTENTS.checkScreenplay(scope), runId: "9f1c" })).toThrow(
      NO_DRY_RUN
    );
    expect(() => buyScreenplay({ argv: INTENTS.previewScreenplay(scope), runId: "" })).toThrow(
      NO_RUN_ID
    );
  });
});
