import { describe, expect, it } from "vitest";
import { run } from "../cli/index.js";
import { commandLine, INTENTS } from "./commands.js";

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
 * - **No intent spends money.** This slice has `check` and `approve`; the two
 *   steps of a paid call arrive with the stage that needs them.
 */

const WORD = /^[a-z][a-z-]*$/;
const USAGE_LINE = /^ {2}(\S+)(?: (\S+))?/;
const FLAG = /--[a-z][a-z-]+/g;

const scope = { episodeId: "01-burza", projectId: "dzielna-ewa" };

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

    for (const [intent, build] of Object.entries(INTENTS)) {
      const [first = "", second] = build(scope);

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

    for (const [intent, build] of Object.entries(INTENTS)) {
      for (const argument of build(scope)) {
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

  it("should build nothing that spends money in this slice", () => {
    const spending = Object.entries(INTENTS).filter(([, build]) =>
      build(scope).includes("generate")
    );

    expect(spending).toEqual([]);
  });
});
