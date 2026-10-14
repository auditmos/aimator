import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "./cli/index.js";
import { resolveWorkspace, type Workspace } from "./lib/workspace.js";
import { docx, EPISODE, makeCut, makeUpstream, PROJECT, png } from "./test/fixture.js";

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

/** The two words a usage line opens with, before any argument or flag. */
const COMMAND = /^ {2}(\S+)(?: (\S+))?/;
const WORD = /^[a-z][a-z-]*$/;
/** A signature too long for one line wraps under its arguments; prose does not. */
const WRAPPED = /^ {5,}\S/;

/**
 * Which command a usage line opens, or none when the line opens no command.
 *
 * A second word belongs to the name only when it is a word: `project init` is
 * a command and `check <id>` is `check` with an argument. That is the rule
 * `docs.test.ts` reads an invocation by, and it is the same rule for the same
 * reason: what the parser dispatches on is one or two words, never a shape.
 */
function commandOf(line: string): string | null {
  const [, first, second] = COMMAND.exec(line) ?? [];

  if (first === undefined || !WORD.test(first)) {
    return null;
  }

  return second !== undefined && WORD.test(second) ? `${first} ${second}` : first;
}

/**
 * Every command the usage text defines, each with its whole signature.
 *
 * A signature is the usage line plus the lines it wraps onto, and nothing
 * else. The sentences under a command are indented four spaces and several of
 * them talk *about* `--json`, so folding them in would let a paragraph stand
 * in for a flag, which is the one mistake the check below has to not make.
 */
function signatures(text: string): Map<string, string> {
  const found = new Map<string, string>();
  let open: string | null = null;

  for (const line of text.split("\n")) {
    // Annotated, because the loop carries `open` forward from it and inferring
    // one from the other is a circle TypeScript refuses to walk.
    const command: string | null =
      commandOf(line) ?? (open !== null && WRAPPED.test(line) ? open : null);

    if (command === null) {
      open = null;
      continue;
    }

    found.set(command, `${found.get(command) ?? ""}\n${line}`);
    open = command;
  }

  return found;
}

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
  "  approve <id> --stage style --track <tor> --artifact S01[,S02] [--json]": [
    "approve",
    PROJECT,
    "--stage",
    "style",
    "--track",
    T,
    "--artifact",
    "S01",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
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
  "  approve <id> <character-id> --stage voice --language <kod> [--json]": [
    "approve",
    PROJECT,
    "ewa",
    "--stage",
    "voice",
    "--language",
    "pl",
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
    "--checks",
    "all",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage dialogue --artifact script|script-<kod>|D01[,<kod>:D01]": [
    "approve",
    ...ON,
    "--stage",
    "dialogue",
    "--artifact",
    "script",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  approve <id> <episode-id> --stage opening-frame --track <tor> --checks <kryteria>|all": [
    "approve",
    ...ON,
    "--stage",
    "opening-frame",
    "--track",
    T,
    "--checks",
    "all",
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
  "  approve <id> <episode-id> --stage sound-design --artifact cues|M01[,E02] [--json]": [
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
  "  approve <id> <episode-id> --stage sound-design --track <tor> [--json]": [
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
  "  approve <id> <episode-id> --stage soundtrack --artifact script|N01[,N02] [--json]": [
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
  "  approve <id> <episode-id> --stage soundtrack --track <tor> [--json]": [
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
  "  approve <id> <episode-id> --stage versions --track <tor> --artifact C01[,C02]|<kod>": [
    "approve",
    ...ON,
    "--stage",
    "versions",
    "--track",
    T,
    "--artifact",
    "C01",
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
  "  character sample <id> <character-id> --language <kod> --text <zdanie>": [
    "character",
    "sample",
    PROJECT,
    "ewa",
    "--language",
    "pl",
    "--text",
    "Nie boję się burzy.",
    "--model",
    "eleven_multilingual_v2",
    "--dry-run",
  ],
  "  character voice <id> <character-id> --language <kod> --voice-id <id głosu> [--json]": [
    "character",
    "voice",
    PROJECT,
    "ewa",
    "--language",
    "pl",
    "--voice-id",
    "pNInz6obpgDQGcFmaJgB",
    "--dry-run",
  ],
  "  check <id> --stage prepare [--json]": ["check", PROJECT, "--stage", "prepare", "--json"],
  "  check <id> --stage style --track <tor> [--json]": [
    "check",
    PROJECT,
    "--stage",
    "style",
    "--track",
    T,
  ],
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
  "  check <id> <character-id> --stage voice --language <kod> [--json]": [
    "check",
    PROJECT,
    "ewa",
    "--stage",
    "voice",
    "--language",
    "pl",
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
  "  check <id> <episode-id> --stage dialogue [--json]": ["check", ...ON, "--stage", "dialogue"],
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
  "  check <id> <episode-id> --stage sound-design [--track <tor>] [--json]": [
    "check",
    ...ON,
    "--stage",
    "sound-design",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage soundtrack [--track <tor>] [--json]": [
    "check",
    ...ON,
    "--stage",
    "soundtrack",
    "--track",
    T,
  ],
  "  check <id> <episode-id> --stage versions --track <tor> [--json]": [
    "check",
    ...ON,
    "--stage",
    "versions",
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
  "  dialogue generate <id> <episode-id> [--model <id>] [--voice-model <id>]": [
    "dialogue",
    "generate",
    ...ON,
    "--model",
    "gpt-6-astra",
    "--voice-model",
    "eleven-v4",
    "--dry-run",
  ],
  "  dialogue translate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]": [
    "dialogue",
    "translate",
    ...ON,
    "--model",
    "gpt-6-astra",
    "--dry-run",
  ],
  '  episode add <id> --idea "<tekst>" --episode <NN-slug> [te same flagi decyzji] [--json]': [
    "episode",
    "add",
    PROJECT,
    "--idea",
    "Ewa czeka na słońce.",
    "--episode",
    "02-slonce",
    "--duration",
    "30",
    "--dry-run",
  ],
  "  episode add <id> --source <NN-tytul.md|katalog> [--duration <s>] [--audio <tryb>]": [
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
  "  episode lip-sync <id> <episode-id> --language <kod>|--none [--json]": [
    "episode",
    "lip-sync",
    ...ON,
    "--language",
    "en",
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
  "  episode show <id> <episode-id> [--json]": ["episode", "show", ...ON],
  "  import add <id> --source <plik.docx> [--json]": [
    "import",
    "add",
    "pola",
    "--source",
    "<scratch>/treatment.docx",
    "--dry-run",
  ],
  "  import group <id> [--model <id>] [--max-output-tokens <n>] [--dry-run] [--json]": [
    "import",
    "group",
    "miko",
    "--model",
    "gpt-6-astra",
    "--dry-run",
  ],
  "  import list [--json]": ["import", "list"],
  "  import show <id> [--json]": ["import", "show", "miko"],
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
  "  project draft <id> --import <id-importu> [--model <id>] [--max-output-tokens <n>]": [
    "project",
    "draft",
    PROJECT,
    "--import",
    "miko",
    "--model",
    "gpt-6-astra",
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
  "  project rules <id> --text <treść> [--json]": [
    "project",
    "rules",
    PROJECT,
    "--text",
    "# Zasady\n\nUstalone.\n",
    "--dry-run",
  ],
  "  project show <id> [--json]": ["project", "show", PROJECT],
  "  project style <id> --generated --count <1-4> [--json]": [
    "project",
    "style",
    PROJECT,
    "--generated",
    "--count",
    "2",
    "--dry-run",
  ],
  "  project style <id> --none [--json]": ["project", "style", PROJECT, "--none", "--dry-run"],
  "  project style <id> --source <plik.png> [--source <plik.png>...] [--json]": [
    "project",
    "style",
    PROJECT,
    "--source",
    "<scratch>/styl.png",
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
  // The fixture decides "none", so there is no style frame to say no to, and
  // the refusal for nothing to reject is what is frozen.
  "  reject <id> --stage style --track <tor> --artifact S01[,S02] --note <uwaga> [--json]": [
    "reject",
    PROJECT,
    "--stage",
    "style",
    "--track",
    T,
    "--artifact",
    "S01",
    "--note",
    "za jasno",
    "--dry-run",
  ],
  "  reject <id> <character-id> --stage character --track <tor> --artifact <klucz>": [
    "reject",
    PROJECT,
    "ewa",
    "--stage",
    "character",
    "--track",
    T,
    "--artifact",
    "hero",
    "--note",
    "uszy za duże",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  // A no needs no proof the bytes are intact, so it writes over anything the
  // stage holds; `--dry-run` keeps the freeze from writing it.
  "  reject <id> <episode-id> --stage <etap> [--track <tor>] [--artifact <klucz>[,...]]": [
    "reject",
    ...ON,
    "--stage",
    "references",
    "--track",
    T,
    "--artifact",
    "R01",
    "--note",
    "za ciemno",
    "--reviewer",
    "fixture",
    "--dry-run",
  ],
  "  screenplay generate <id> <episode-id> --verbatim [--regenerate] [--dry-run] [--json]": [
    "screenplay",
    "generate",
    ...ON,
    "--verbatim",
    "--regenerate",
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
  // The fixture decides "none", so what is frozen here is the refusal a project
  // that does not generate its style frames gets, which is itself a contract.
  "  style generate <id> --track <gpt-image|seedream> [--artifact S01,...] [--model <id>]": [
    "style",
    "generate",
    PROJECT,
    "--track",
    T,
    "--model",
    "gpt-image-2.5-sunburst",
    "--dry-run",
  ],
  "  versions bind <id> <episode-id> --track <tor> --artifact C01": [
    "versions",
    "bind",
    ...ON,
    "--track",
    T,
    "--artifact",
    "C01",
    "--face",
    "0=ewa",
    "--dry-run",
  ],
  // The fixture's episode has no dialogue and no lip-sync.json, so what stage 12
  // freezes is its first refusal: the decision the whole stage hangs off.
  "  versions faces <id> <episode-id> --track <gpt-image|seedream> --artifact C01": [
    "versions",
    "faces",
    ...ON,
    "--track",
    T,
    "--artifact",
    "C01",
    "--dry-run",
  ],
  "  versions final <id> <episode-id> --track <tor> --language <kod>": [
    "versions",
    "final",
    ...ON,
    "--track",
    T,
    "--language",
    "en",
    "--dry-run",
  ],
  "  versions lip-sync <id> <episode-id> --track <tor> [--artifact C01[,C02]]": [
    "versions",
    "lip-sync",
    ...ON,
    "--track",
    T,
    "--dry-run",
  ],
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
  await writeFile(join(scratch, "styl.png"), png(64, 64, 3));
  await writeFile(
    join(scratch, "treatment.docx"),
    docx(
      '<w:p><w:pPr><w:pStyle w:val="Nagwek1"/></w:pPr><w:r><w:t>Pola</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rId10"/></w:drawing></w:r></w:p>'
    )
  );

  // `import show` needs an import to read; the table's own `add` is a dry run.
  const imported = await run([
    "import",
    "add",
    "miko",
    "--source",
    join(scratch, "treatment.docx"),
    "--workspace",
    root,
  ]);
  if (!imported.ok) {
    throw imported.error;
  }

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

/**
 * The parity promise, kept where it can be read: in the usage text itself.
 *
 * A screen over this CLI can only ask what the terminal answers, and the other
 * caller is an agent, which reads an object rather than Polish sentences. A
 * command with no `--json` is therefore a question one of the two callers
 * cannot ask, and the hole would open silently: nothing about a stage that
 * forgot the flag looks wrong until somebody tries to click it.
 *
 * It is read per **command** rather than per usage line, because a command is
 * what the parser dispatches on. `check <id> <episode-id>` glues four stages
 * into one string for a person at a terminal and `common.ts` refuses `--json`
 * over it by name, while `check --stage screenplay` answers as an object: one
 * command, two grammars, one flag.
 */
describe("--json", () => {
  it("should be declared by every command the usage text defines", () => {
    const declared = signatures(usage);
    const silent = [...declared]
      .filter(([, signature]) => !signature.includes("--json"))
      .map(([command]) => command);

    expect(silent).toEqual([]);

    // Second, because it is the weaker claim and has to fail second: a parse
    // that matched nothing would have found nothing silent either and would
    // have passed. The commands are read back against the frozen table, whose
    // keys the test above pins to the usage lines one by one.
    const covered = new Set(Object.keys(TABLE).flatMap((line) => commandOf(line) ?? []));

    expect([...declared.keys()].sort()).toEqual([...covered].sort());
  });
});

describe("every command", () => {
  it.each(Object.entries(TABLE))("%s", async (_line, argv) => {
    expect(await outcome(argv)).toMatchSnapshot();
  });
});
