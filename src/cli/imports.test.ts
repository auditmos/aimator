import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The module's shape, checked rather than remembered.
 *
 * A folder with a file per stage is only worth the move if the files stay
 * independent: the moment one stage reaches into another's renderers, the
 * split has bought a longer import list and nothing else. Two claims, both
 * read off the source, neither provable by the behaviour freeze next door:
 *
 * 1. The entry declares `run` and nothing else. Knip catches an export no
 *    caller needs; this catches one a caller does need but should not have.
 * 2. No stage file imports another stage file. A piece two stages share is
 *    promoted into `common.ts`, which is the rule AGENTS.md already states
 *    for `src/lib`.
 */

const cli = import.meta.dirname;
const stages = join(cli, "stages");
const IMPORT = /^import\s[\s\S]*?["']([^"']+)["'];$/gm;
const EXPORT = /^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/gm;
const REEXPORT = /^export\s*\{/m;
const STAR = /^export\s+\*/m;

function sourceOf(path: string): string {
  return readFileSync(path, "utf8");
}

function importsOf(source: string): readonly string[] {
  return [...source.matchAll(IMPORT)].map(([, specifier]) => specifier ?? "");
}

function stageFiles(): readonly string[] {
  return readdirSync(stages).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

describe("the CLI module", () => {
  it("declares run at the entry and nothing else", () => {
    const source = sourceOf(join(cli, "index.ts"));
    const names = [...source.matchAll(EXPORT)].map(([, name]) => name);

    expect(names).toEqual(["run"]);
    expect(source).not.toMatch(REEXPORT);
    expect(source).not.toMatch(STAR);
  });

  it("gives every stage a file of its own", () => {
    expect(stageFiles().length).toBeGreaterThan(10);
  });

  it("never lets one stage file import another", () => {
    const offenders: string[] = [];

    for (const name of stageFiles()) {
      for (const specifier of importsOf(sourceOf(join(stages, name)))) {
        if (specifier.startsWith("./")) {
          offenders.push(`${name} → ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
