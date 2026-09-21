import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../cli.js";

/**
 * The documentation is the one artifact in this repo that nothing else proves.
 * Tests prove the code, `pnpm types` proves the configs, and a broken link or a
 * flag that no longer exists is found only when a person reads the page — which
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

  it("should give every implemented stage a page of its own", () => {
    const pages = markdownUnder(join(repoRoot, "docs", "stages"));
    expect(pages).toHaveLength(11);
    for (const stage of Array.from({ length: 11 }, (_, index) => String(index).padStart(2, "0"))) {
      expect(pages.some((page) => relative(repoRoot, page).includes(`/${stage}-`))).toBe(true);
    }
  });
});
