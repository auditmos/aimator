import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../cli/index.js";
import { imageTracks } from "../lib/workspace.js";

/**
 * The documentation is the one artifact in this repo that nothing else proves.
 * Tests prove the code, `pnpm types` proves the configs, and a broken link or a
 * flag that no longer exists is found only when a person reads the page, which
 * is exactly the moment the page was supposed to help them.
 *
 * So the usage text is the source of truth here, and the documents are checked
 * against it. Nothing in this file lists a command or a flag: both sets are
 * parsed out of `--help`, because a second copy of that list would drift from
 * the first one the same way the documents drift from the CLI.
 */

const repoRoot = resolve(import.meta.dirname, "../..");

/** Documents a reader is handed: the front page and everything under `docs/`. */
const READER_DOCS = ["README.md", "docs"];

/**
 * Dotted directories are tooling, not documentation. `site/` is skipped for a
 * different reason: the Markdown under it is a frozen episode source, which
 * travels verbatim and is material rather than prose this repository wrote.
 */
const SKIPPED = new Set(["site"]);

/**
 * The Markdown git would commit: tracked, plus new files nobody ignored. The
 * disk holds more than that, such as private notes in the ignored `plans/`,
 * which are nobody's documentation; a walk of the disk read a regex quoted in
 * one of them as a broken link. Output directories are ignored the same way.
 */
const COMMITTED = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
  { cwd: repoRoot, encoding: "utf8" }
)
  .split("\n")
  .filter((path) => path !== "" && existsSync(join(repoRoot, path)));

const MARKDOWN = COMMITTED.filter(
  (path) => !path.split("/").some((part) => SKIPPED.has(part) || part.startsWith("."))
);

/**
 * The one dotted directory read here, and only for its links. A skill points
 * the conversation at files, so a pointer that broke is found in conversation,
 * the moment it was meant to help. Commands and flags stay unchecked: a skill
 * speaks of `/prepare-project`, not of `pnpm dev`, so they would only cry wolf.
 */
const SKILLS = COMMITTED.filter((path) => path.startsWith(".claude/skills/")).map((file) =>
  join(repoRoot, file)
);

/** The skills that point the conversation at pages rather than copy them. */
const STAGE_0_SKILLS = [".claude/skills/develop-series", ".claude/skills/prepare-project"];
const QUOTED = /`([^`\s]+)`/g;

function markdownUnder(path: string): string[] {
  const prefix = `${relative(repoRoot, path)}/`;
  return MARKDOWN.filter((file) => file.startsWith(prefix)).map((file) => join(repoRoot, file));
}

function everyMarkdownFile(): string[] {
  return MARKDOWN.map((file) => join(repoRoot, file));
}

function readerDocs(): string[] {
  const found: string[] = [];
  for (const entry of READER_DOCS) {
    const path = join(repoRoot, entry);
    found.push(...(entry.endsWith(".md") ? [path] : markdownUnder(path)));
  }
  return found;
}

const WORD = /^[a-z][a-z-]*$/;
/** A usage line defines a command; a description line is indented deeper. */
const USAGE_LINE = /^ {2}(\S+)(?: (\S+))?/;
const FLAG = /--[a-z][a-z-]+/g;
/** Both spellings a document uses for an invocation. */
const INVOCATION = /(?:pnpm dev|aimator) (\S+)(?: (\S+))?/g;
/** The other programs this documentation tells a reader to run. */
const FOREIGN_COMMAND = /\b(wrangler|ffmpeg|ffprobe)\b/;
const ABSOLUTE_LINK = /^(https?:|mailto:)/;
const LOCAL_LINK = /\[[^\]]+\]\(([^)]+)\)/g;

/**
 * The stage list is written in three media: the README's table, the page that
 * explains the pipeline to somebody who knows video rather than code, and the
 * site’s own page. Three copies of one list is the drift this file exists to
 * catch, and `--help` cannot settle it: the CLI names commands, not stages.
 */
/** A block of the usage text that belongs to one stage, by its own heading. */
const STAGE_HEADING = /^Etap (\d+)\./;

const README_STAGE = /^\| \[(\d+)\. ([^\]]+)\]/gm;
const PAGE_STAGE = /^### (\d+)\. (.+)$/gm;
const SITE_STAGE = /data-stage="(\d+)"[\s\S]*?lang="pl">([^<]+)</g;
const DIAGRAM = /```mermaid\n([\s\S]*?)```/;

const readRepoFile = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

/** What stage 0 reads when the conversation reaches the look of a series. */
const STYLE_PAGES = ["docs/slownik.md", "docs/styl.md"];

const TABLE_SEPARATOR = /^:?-+:?$/;
const ENV_VARIABLE = /^([A-Z][A-Z0-9_]*)=(.*)$/gm;
const MODEL_VARIABLE = /_MODEL(_|$)/;
const WHITESPACE = /\s+/;
const CLOSING_VOWEL = /[aeiouyąęó]$/;

/** Every cell under `header`, in every Markdown table of `text` that has it. */
function tableColumn(text: string, header: string): string[] {
  const cells: string[] = [];
  // `undefined` outside a table; -1 inside one that lacks the header.
  let column: number | undefined;

  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) {
      column = undefined;
      continue;
    }
    const row = line
      .split("|")
      .slice(1, -1)
      .map((part) => part.trim());
    if (column === undefined) {
      column = row.indexOf(header);
      continue;
    }
    const cell = row[column];
    if (column !== -1 && cell !== undefined && !TABLE_SEPARATOR.test(cell)) {
      cells.push(cell);
    }
  }

  return cells;
}

function stageList(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)]
    .map(([, number, name]) => `${number}. ${name?.trim().toLowerCase()}`)
    .sort();
}

let usage = "";
let commands = new Set<string>();
let flags = new Set<string>();

beforeAll(async () => {
  const result = await run(["--help"]);
  if (!result.ok) {
    throw result.error;
  }
  usage = result.data;

  commands = new Set<string>();
  for (const line of usage.split("\n")) {
    const [, first, second] = USAGE_LINE.exec(line) ?? [];
    if (!(first && WORD.test(first))) {
      continue;
    }
    commands.add(second && WORD.test(second) ? `${first} ${second}` : first);
  }

  flags = new Set(usage.match(FLAG) ?? []);
});

describe("documentation", () => {
  it("should link only to files that exist", () => {
    const broken: string[] = [];
    for (const file of [...everyMarkdownFile(), ...SKILLS]) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(LOCAL_LINK)) {
        const path = target?.split("#")[0];
        if (!path || ABSOLUTE_LINK.test(target)) {
          continue;
        }
        if (!existsSync(resolve(dirname(file), path))) {
          broken.push(`${relative(repoRoot, file)} → ${target}`);
        }
      }
    }
    expect(SKILLS.length).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });

  /**
   * Instructions like these arrive wrapped in a note that they may or may not
   * be relevant, and the longer the file, the more of it is read as optional.
   * What does not fit goes to a reference file the skill loads on a stated
   * condition, which is the only way it stays short while it grows. Saving is
   * what `prepare-project` alone does, so its commands buy it twenty lines more.
   */
  it.each([
    ["develop-series", 100],
    ["prepare-project", 120],
  ])("should keep the %s skill to %i lines", (skill, limit) => {
    const text = readRepoFile(`.claude/skills/${skill}/SKILL.md`);
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(limit);
  });

  /**
   * A path in backticks is a pointer the link check above cannot see, so it
   * breaks in silence. Held to it are the two stage-0 skills, the ones that
   * point the conversation at pages instead of copying them. A workspace file
   * such as `project.md` is not in this repository and stays quoted.
   */
  it("should link, never quote, a repository file in the stage-0 skills", () => {
    const files = SKILLS.filter((file) =>
      STAGE_0_SKILLS.some((skill) => relative(repoRoot, file).startsWith(`${skill}/`))
    );
    const quoted: string[] = [];
    for (const file of files) {
      for (const [, token] of readFileSync(file, "utf8").matchAll(QUOTED)) {
        if (token && statSync(join(repoRoot, token), { throwIfNoEntry: false })?.isFile()) {
          quoted.push(`${relative(repoRoot, file)}: ${token}`);
        }
      }
    }
    expect(files.length).toBeGreaterThanOrEqual(STAGE_0_SKILLS.length);
    expect(quoted).toEqual([]);
  });

  /**
   * A page nothing links to is found only by somebody who already knows it is
   * there, which is nobody it was written for. Reachable means by any path of
   * links from the front page, not necessarily one click from it.
   */
  it("should lead from the README to every page under docs", () => {
    const reached = new Set<string>();
    const queue = [join(repoRoot, "README.md")];

    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (reached.has(file) || !existsSync(file)) {
        continue;
      }
      reached.add(file);
      for (const [, target] of readFileSync(file, "utf8").matchAll(LOCAL_LINK)) {
        const path = target?.split("#")[0];
        if (path?.endsWith(".md") && !ABSOLUTE_LINK.test(target ?? "")) {
          queue.push(resolve(dirname(file), path));
        }
      }
    }

    const orphans = markdownUnder(join(repoRoot, "docs"))
      .filter((page) => !reached.has(page))
      .map((page) => relative(repoRoot, page));
    expect(orphans).toEqual([]);
  });

  /**
   * The pages a conversation about the look of a series reads. A model named in
   * them turns into advice ("this line works on X"), which is a model chosen by
   * a page, and a model nobody chose is not a decision. Both lists come from the
   * committed reference of every variable and from the tracks themselves, so a
   * model this repo starts using is caught without editing this file.
   */
  it("should name no model and no key on the pages about style", () => {
    const variables = [...readRepoFile(".env.example").matchAll(ENV_VARIABLE)];
    const forbidden = [
      ...variables.map(([, name]) => name ?? ""),
      ...variables
        .filter(([, name]) => MODEL_VARIABLE.test(name ?? ""))
        .map(([, , id]) => id ?? ""),
      ...imageTracks,
    ].filter((word) => word !== "");

    const named: string[] = [];
    for (const page of STYLE_PAGES) {
      const text = readRepoFile(page).toLowerCase();
      named.push(
        ...forbidden
          .filter((word) => text.includes(word.toLowerCase()))
          .map((word) => `${page}: ${word}`)
      );
    }
    expect(forbidden.length).toBeGreaterThan(imageTracks.length);
    expect(named).toEqual([]);
  });

  /**
   * A studio or an artist named anywhere but in the column that decomposes it
   * is a name on its way into `project.md`, and from there verbatim into every
   * paid image. The names are read from that column rather than listed here.
   *
   * Polish inflects names ("u Burtona", "z Laiki"), so a cell is matched word by
   * word, each by its stem: without a closing vowel, capitalised as written.
   * Words under four letters are first names too short to tell from prose.
   */
  it("should name a studio or an artist only in the „Zamiast” column", () => {
    const names = tableColumn(readRepoFile("docs/styl.md"), "Zamiast");
    const stems = names
      .flatMap((name) => name.split(WHITESPACE))
      .filter((word) => word.length >= 4)
      .map((word) => word.replace(CLOSING_VOWEL, ""));
    const texts = everyMarkdownFile().map((file) => readFileSync(file, "utf8"));

    const repeated = stems
      .map((stem) => ({
        count: texts.reduce((sum, text) => sum + text.split(stem).length - 1, 0),
        stem,
      }))
      .filter(({ count }) => count !== 1)
      .map(({ count, stem }) => `${stem}: ${count}×`);

    expect(names.length).toBeGreaterThan(0);
    expect(repeated).toEqual([]);
  });

  /**
   * The page teaches five to seven tokens a line, so every line it offers has
   * to obey that, or the catalogue is the first counterexample a reader copies.
   */
  it("should keep every style line on the style page to five to seven tokens", () => {
    const page = readRepoFile("docs/styl.md");
    const catalogue = tableColumn(page, "Linia");
    const lines = [...catalogue, ...tableColumn(page, "Użyj")].map((cell) =>
      cell.replaceAll("`", "")
    );

    const outside = lines
      .map((line) => ({ line, tokens: line.split(",").length }))
      .filter(({ tokens }) => tokens < 5 || tokens > 7)
      .map(({ line, tokens }) => `${tokens}: ${line}`);

    expect(catalogue.length).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });

  it("should invoke only commands the usage text defines", () => {
    const unknown: string[] = [];
    for (const file of readerDocs()) {
      for (const [, first, second] of readFileSync(file, "utf8").matchAll(INVOCATION)) {
        if (!(first && WORD.test(first))) {
          continue;
        }
        // A second word is a subcommand only when the usage text pairs the two;
        // otherwise it is an argument, such as a project id.
        if (second && commands.has(`${first} ${second}`)) {
          continue;
        }
        if (!commands.has(first)) {
          unknown.push(`${relative(repoRoot, file)}: ${first} ${second ?? ""}`.trim());
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("should name only flags the usage text defines", () => {
    const unknown: string[] = [];
    for (const file of readerDocs()) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        // A line that invokes another program documents that program's flags.
        // The check stays on prose, which is where a renamed flag survives
        // longest, and gives up only the lines that say which tool they mean.
        if (FOREIGN_COMMAND.test(line)) {
          continue;
        }
        for (const flag of line.match(FLAG) ?? []) {
          if (!flags.has(flag)) {
            unknown.push(`${relative(repoRoot, file)}: ${flag}`);
          }
        }
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("should name the same thirteen stages in the README, the page and the site", () => {
    const listed = stageList(readRepoFile("README.md"), README_STAGE);
    expect(listed).toHaveLength(13);
    expect(stageList(readRepoFile("docs/jak-to-powstaje.md"), PAGE_STAGE)).toEqual(listed);
    expect(stageList(readRepoFile("site/jak-to-powstaje.html"), SITE_STAGE)).toEqual(listed);
  });

  it("should draw every stage the pipeline page describes", () => {
    const page = readRepoFile("docs/jak-to-powstaje.md");
    const [, diagram] = DIAGRAM.exec(page) ?? [];
    expect(diagram).toBeDefined();
    const undrawn = [...page.matchAll(PAGE_STAGE)]
      .map(([, number, name]) => `${number}. ${name?.trim()}`)
      .filter((stage) => !diagram?.includes(stage));
    expect(undrawn).toEqual([]);
  });

  /**
   * `--json` has reached every stage, and every page has to say so.
   *
   * The flag is what an agent reads instead of Polish sentences, so a stage
   * that takes it and never says so is a contract nobody can find. This used
   * to ask only about the stages whose usage block already carried the flag,
   * because it arrived one stage at a time. `cli.usage.test.ts` now holds that
   * end (every command the usage text defines declares it), so the condition
   * here could no longer be false, and a condition with no false is a comment
   * pretending to be code.
   *
   * What replaces it is the count. Which stages exist is still not listed here,
   * for the reason nothing else in this file is: the blocks are read off
   * `--help`. But a walk that found no block would have found nothing missing
   * either, so the walk says how far it got and the page list says how many
   * stages there are.
   */
  it("should document --json on every stage's page", () => {
    const pages = markdownUnder(join(repoRoot, "docs", "stages"));
    const undocumented: string[] = [];
    const walked: string[] = [];

    for (const block of usage.split("\n\n")) {
      const [, number] = STAGE_HEADING.exec(block) ?? [];

      if (number === undefined) {
        continue;
      }

      walked.push(number);

      const prefix = `/${number.padStart(2, "0")}-`;
      const page = pages.find((one) => relative(repoRoot, one).includes(prefix));

      if (page === undefined || !readFileSync(page, "utf8").includes("--json")) {
        undocumented.push(`etap ${number}`);
      }
    }

    expect(undocumented).toEqual([]);
    expect(walked).toHaveLength(pages.length);
  });

  it("should give every implemented stage a page of its own", () => {
    const pages = markdownUnder(join(repoRoot, "docs", "stages"));
    expect(pages).toHaveLength(13);
    for (const stage of Array.from({ length: 13 }, (_, index) => String(index).padStart(2, "0"))) {
      expect(pages.some((page) => relative(repoRoot, page).includes(`/${stage}-`))).toBe(true);
    }
  });
});
