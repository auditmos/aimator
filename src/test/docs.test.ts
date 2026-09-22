import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../cli/index.js";

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
 * Dotted directories are tooling, not documentation; `dist/` and `out/` are
 * output. `site/` is skipped for a different reason: the Markdown under it is a
 * frozen episode source, which travels verbatim and is material rather than
 * prose this repository wrote.
 */
const SKIPPED = new Set(["dist", "node_modules", "out", "site"]);

function markdownUnder(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownUnder(child));
    } else if (entry.name.endsWith(".md")) {
      found.push(child);
    }
  }
  return found;
}

function everyMarkdownFile(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const child = join(repoRoot, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownUnder(child));
    } else if (entry.name.endsWith(".md")) {
      found.push(child);
    }
  }
  return found;
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
    for (const file of everyMarkdownFile()) {
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
    expect(broken).toEqual([]);
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

  it("should name the same eleven stages in the README, the page and the site", () => {
    const listed = stageList(readRepoFile("README.md"), README_STAGE);
    expect(listed).toHaveLength(11);
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
   * end — every command the usage text defines declares it — so the condition
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
    expect(pages).toHaveLength(11);
    for (const stage of Array.from({ length: 11 }, (_, index) => String(index).padStart(2, "0"))) {
      expect(pages.some((page) => relative(repoRoot, page).includes(`/${stage}-`))).toBe(true);
    }
  });
});
