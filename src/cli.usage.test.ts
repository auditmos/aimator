import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "./cli/index.js";
import { resolveWorkspace, type Workspace } from "./lib/workspace.js";
import { EPISODE, makeCut, makeUpstream, PROJECT } from "./test/fixture.js";

/**
 * The CLI's behaviour, frozen.
 *
 * `cli.test.ts` proves what each command does; this file proves that nothing
 * about it changed, which is a different claim and the one a structural
 * refactor has to make. Two freezes:
 *
 * 1. The usage text, compared to a file byte for byte. `docs.test.ts` parses
 *    commands and flags out of it, so a changed character there is a changed
 *    contract, not a changed comment.
 * 2. One invocation per usage line, run on the shared fixture, with the whole
 *    `Result` (the text, or the error's class and message) held in a snapshot.
 *    The table is keyed by the usage line itself, so a command that appears in
 *    `--help` without an entry here fails, and an entry whose line has gone
 *    fails too: the freeze cannot silently cover less than the usage.
 *
 * Nothing here spends or writes: every command that would is run with
 * `--dry-run`, which by contract never reads a secret, and `env` is mocked to
 * an empty configuration so a developer's `.env` cannot reach the snapshot.
 * The engine is pointed at a path that exists on no machine, for the same
 * reason: what a dry run says about ffmpeg must not depend on which ffmpeg is
 * installed where the test runs.
 */

vi.mock("./lib/env.js", () => ({ env: { AIMATOR_FFMPEG: "/nonexistent/aimator-ffmpeg" } }));

/** A usage line defines a command; a description line is indented deeper. */
const USAGE_LINE = /^ {2}[a-z][a-z-]*(?: [a-z][a-z-]*)? /;
const SHA256 = /\b[0-9a-f]{64}\b/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };
let usage = "";

/** Same manifest stages 8 and 9 hand the fixture: two clips, one seeded. */
function answer(): string {
  return JSON.stringify({
    clips: ["C01", "C02"].map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: [{ clipId: "C02", prompt: "Pierwsza chwila klipu C02." }],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/**
 * Everything that varies between two runs of the same command on the same
 * fixture and means nothing to the freeze: where the temporary tree was, when
 * a file was written, and the digest that changed because the time did.
 */
function normalize(text: string): string {
  return text
    .replaceAll(root, "<workspace>")
    .replaceAll(scratch, "<scratch>")
    .replace(SHA256, "<sha256>")
    .replace(TIMESTAMP, "<timestamp>");
}

async function outcome(argv: readonly string[]): Promise<string> {
  const result = await run([
    ...argv.map((arg) => arg.replace("<scratch>", scratch)),
    "--workspace",
    root,
  ]);

  return result.ok
    ? `ok\n${normalize(result.data)}`
    : `${result.error.name}\n${normalize(result.error.message)}`;
}

const T = "gpt-image";
const ON = [PROJECT, EPISODE] as const;

/**
 * One invocation per usage line, keyed by the line as `--help` prints it.
 * Every entry that would write or spend carries `--dry-run`; every approval
 * names its reviewer, because the default is the machine's user name; every
 * paid command names its model, because the default is the developer's `.env`.
 * `<scratch>` is where the fixture put files a command takes from outside.
 */
const TABLE: Readonly<Record<string, readonly string[]>> = {
  "  approve <id> [<episode-id>] [--stage prepare|screenplay|shot-list|prompt-package]": [
    "approve",
    ...ON,
    "--stage",
    "screenplay",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <character-id> --stage character --track <tor> [--json]": [
    "approve",
    PROJECT,
    "ewa",
    "--stage",
    "character",
    "--track",
    T,
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage assembly --track <tor> [--json]": [
    "approve",
    ...ON,
    "--stage",
    "assembly",
    "--track",
    T,
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage clips --track <tor> --artifact C01[,entry:C02]": [
    "approve",
    ...ON,
    "--stage",
    "clips",
    "--track",
    T,
    "--artifact",
    "C01,entry:C02",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage opening-frame --track <tor> [--json]": [
    "approve",
    ...ON,
    "--stage",
    "opening-frame",
    "--track",
    T,
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage references --track <tor> --artifact R01[,R02]": [
    "approve",
    ...ON,
    "--stage",
    "references",
    "--track",
    T,
    "--artifact",
    "R01",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage sound-design --artifact cues|M01[,E02]": [
    "approve",
    ...ON,
    "--stage",
    "sound-design",
    "--artifact",
    "cues",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage sound-design --track <tor>": [
    "approve",
    ...ON,
    "--stage",
    "sound-design",
    "--track",
    T,
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage soundtrack --artifact script|N01[,N02]": [
    "approve",
    ...ON,
    "--stage",
    "soundtrack",
    "--artifact",
    "script",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage soundtrack --track <tor>": [
    "approve",
    ...ON,
    "--stage",
    "soundtrack",
    "--track",
    T,
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  assembly generate <id> <episode-id> --track <gpt-image|seedream>": [
    "assembly",
    "generate",
    ...ON,
    "--track",
    T,
    "--dry-run",
  ],
  "  character add <id> <character-id> --source <plik> [--source <plik>...] [--json]": [
    "character",
    "add",
    PROJECT,
    "ewa",
    "--source",
    "<scratch>/ewa-2.png",
    "--dry-run",
  ],
  "  character describe <id> <character-id> [--json]": [
    "character",
    "describe",
    PROJECT,
    "ewa",
    "--dry-run",
  ],
  "  character generate <id> <character-id> --track <gpt-image|seedream>": [
    "character",
    "generate",
    PROJECT,
    "ewa",
    "--track",
    T,
    "--model",
    "gpt-image-2.5-sunburst",
    "--dry-run",
  ],
  "  character new <id> <character-id> --name <nazwa> [--json]": [
    "character",
    "new",
    PROJECT,
    "babcia",
    "--name",
    "Babcia",
    "--dry-run",
  ],
  "  check <id> --stage prepare [--json]": ["check", PROJECT, "--stage", "prepare", "--json"],
  "  check <id> [<episode-id>]": ["check", ...ON],
  "  check <id> <character-id> --stage character --track <tor> [--json]": [
    "check",
    PROJECT,
    "ewa",
    "--stage",
    "character",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage assembly --track <tor> [--json]": [
    "check",
    ...ON,
    "--stage",
    "assembly",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage clips --track <tor> [--json]": [
    "check",
    ...ON,
    "--stage",
    "clips",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage opening-frame --track <tor> [--json]": [
    "check",
    ...ON,
    "--stage",
    "opening-frame",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage prompt-package [--json]": [
    "check",
    ...ON,
    "--stage",
    "prompt-package",
    "--json",
  ],
  "  check <id> <episode-id> --stage references --track <tor> [--json]": [
    "check",
    ...ON,
    "--stage",
    "references",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage screenplay [--json]": [
    "check",
    ...ON,
    "--stage",
    "screenplay",
    "--json",
  ],
  "  check <id> <episode-id> --stage shot-list [--json]": [
    "check",
    ...ON,
    "--stage",
    "shot-list",
    "--json",
  ],
  "  check <id> <episode-id> --stage sound-design [--track <tor>]": [
    "check",
    ...ON,
    "--stage",
    "sound-design",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage soundtrack [--track <tor>]": [
    "check",
    ...ON,
    "--stage",
    "soundtrack",
    "--track",
    T,
  ],
  "  clip generate <id> <episode-id> --track <gpt-image|seedream>": [
    "clip",
    "generate",
    ...ON,
    "--track",
    T,
    "--image-model",
    "gpt-image-2.5-sunburst",
    "--video-model",
    "seedance-2.0",
    "--dry-run",
  ],
  "  episode add <id> --source <NN-tytul.md> [--duration <s>] [--audio <tryb>]": [
    "episode",
    "add",
    PROJECT,
    "--source",
    "<scratch>/02-Slonce.md",
    "--duration",
    "30",
    "--audio",
    "narration",
    "--dry-run",
  ],
  "  episode set <id> <episode-id> [te same flagi decyzji] [--json]": [
    "episode",
    "set",
    ...ON,
    "--duration",
    "30",
    "--dry-run",
  ],
  "  list [--json]": ["list"],
  "  narration direction <id> [--stability <0-1>] [--style <0-1>] [--speed <0.7-1.2>]": [
    "narration",
    "direction",
    PROJECT,
    "--stability",
    "0.4",
    "--style",
    "0.3",
    "--speed",
    "1",
    "--dry-run",
  ],
  "  narration generate <id> <episode-id> [--model <id>] [--voice-model <id>]": [
    "narration",
    "generate",
    ...ON,
    "--model",
    "gpt-6-astra",
    "--voice-model",
    "eleven-v4",
    "--dry-run",
  ],
  "  narration mix <id> <episode-id> --track <gpt-image|seedream>": [
    "narration",
    "mix",
    ...ON,
    "--track",
    T,
    "--dry-run",
  ],
  "  opening-frame generate <id> <episode-id> --track <gpt-image|seedream>": [
    "opening-frame",
    "generate",
    ...ON,
    "--track",
    T,
    "--model",
    "gpt-image-2.5-sunburst",
    "--dry-run",
  ],
  "  project init <id> --title <tytuł> [--aspect-ratio <w:h>] [--json]": [
    "project",
    "init",
    "nowy",
    "--title",
    "Nowy",
    "--aspect-ratio",
    "16:9",
    "--dry-run",
  ],
  "  project voice <id> --voice-id <id głosu> [--json]": [
    "project",
    "voice",
    PROJECT,
    "--voice-id",
    "voice-1",
    "--dry-run",
  ],
  "  prompt-package generate <id> <episode-id> [--model <id>]": [
    "prompt-package",
    "generate",
    ...ON,
    "--model",
    "gpt-6-astra",
    "--dry-run",
  ],
  "  prompt-package show <id> <episode-id> --track <tor> [--json]": [
    "prompt-package",
    "show",
    ...ON,
    "--track",
    T,
  ],
  "  reference generate <id> <episode-id> --track <gpt-image|seedream>": [
    "reference",
    "generate",
    ...ON,
    "--track",
    T,
    "--model",
    "gpt-image-2.5-sunburst",
    "--dry-run",
  ],
  "  screenplay generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]": [
    "screenplay",
    "generate",
    ...ON,
    "--model",
    "gpt-6-astra",
    "--max-output-tokens",
    "4096",
    "--dry-run",
  ],
  "  shot-list generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]": [
    "shot-list",
    "generate",
    ...ON,
    "--model",
    "gpt-6-astra",
    "--max-output-tokens",
    "4096",
    "--dry-run",
  ],
  "  sound-design generate <id> <episode-id> [--model <id>] [--music-model <id>]": [
    "sound-design",
    "generate",
    ...ON,
    "--model",
    "gpt-6-astra",
    "--music-model",
    "eleven-music",
    "--effects-model",
    "eleven-sfx",
    "--dry-run",
  ],
  "  sound-design levels <id> [--music-db <n>] [--effects-db <n>] [--duck-db <n>]": [
    "sound-design",
    "levels",
    PROJECT,
    "--music-db",
    "-18",
    "--effects-db",
    "-12",
    "--duck-db",
    "-6",
    "--dry-run",
  ],
  "  sound-design mix <id> <episode-id> --track <gpt-image|seedream>": [
    "sound-design",
    "mix",
    ...ON,
    "--track",
    T,
    "--dry-run",
  ],
  // No `--dry-run`: the one command that cannot write or spend, whichever way
  // it is called, so there is no second mode of it to freeze.
  "  status <id> <episode-id> [--json]": ["status", ...ON],
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-usage-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };

  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  await makeCut({ root, track: "gpt-image", workspace });
  await writeFile(join(scratch, "02-Slonce.md"), "# Słońce\n\nEwa czeka na słońce.\n", "utf8");
  await writeFile(join(scratch, "ewa-2.png"), "not really a png", "utf8");

  const help = await run(["--help"]);
  if (!help.ok) {
    throw help.error;
  }
  usage = help.data;
});

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("usage text", () => {
  it("should not change by a single character", async () => {
    await expect(usage).toMatchFileSnapshot("./__snapshots__/cli-usage.txt");
  });
});

describe("the table", () => {
  it("should carry exactly one entry per usage line", () => {
    const lines = usage.split("\n").filter((line) => USAGE_LINE.test(line));

    expect(new Set(lines).size).toBe(lines.length);
    expect(Object.keys(TABLE).sort()).toEqual([...lines].sort());
  });
});

describe("every command", () => {
  it.each(Object.entries(TABLE))("%s", async (_line, argv) => {
    expect(await outcome(argv)).toMatchSnapshot();
  });
});
