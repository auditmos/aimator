import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The one rule this module has, checked rather than remembered.
 *
 * The UI may reach the pipeline **only** through `run(argv)`. A single import
 * of a stage module would be faster to write and would end the parity that
 * makes this tool drivable by an agent: the browser would answer a question
 * the terminal cannot, and every later panel would quietly be allowed to do
 * the same. It reads as an ordinary import, so nothing but a test catches it.
 *
 * Three modules of the library are allowed, and none of them is a stage, which
 * is the line this rule actually draws. The layout module says where the
 * workspace is, which the watcher needs and nothing else can answer; the
 * environment module is the only one permitted to read `process.env`, which the
 * process entry needs to find the default workspace; and the byte-range module
 * is arithmetic over an HTTP header, shared with the published page's worker
 * and knowing nothing about any stage or any artifact.
 */

const ui = import.meta.dirname;
const IMPORT = /^import\s[\s\S]*?["']([^"']+)["'];$/gm;
const ALLOWED_LIBRARY = new Set(["../lib/byte-range.js", "../lib/env.js", "../lib/workspace.js"]);

function sourceFiles(): readonly string[] {
  return readdirSync(ui).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

function importsOf(name: string): readonly string[] {
  const source = readFileSync(join(ui, name), "utf8");

  return [...source.matchAll(IMPORT)].map(([, specifier]) => specifier ?? "");
}

describe("the UI module", () => {
  it("should reach the pipeline only through the CLI entry", () => {
    const offenders: string[] = [];

    for (const name of sourceFiles()) {
      for (const specifier of importsOf(name)) {
        if (specifier.startsWith("../cli/") && specifier !== "../cli/index.js") {
          offenders.push(`${name} → ${specifier}`);
        }
        if (specifier.startsWith("../lib/") && !ALLOWED_LIBRARY.has(specifier)) {
          offenders.push(`${name} → ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("should import nothing from outside the CLI, the layout and itself", () => {
    const reaching = sourceFiles().flatMap((name) =>
      importsOf(name)
        .filter((specifier) => specifier.startsWith("../") || specifier.startsWith("../../"))
        .filter((specifier) => specifier !== "../cli/index.js" && !ALLOWED_LIBRARY.has(specifier))
        .map((specifier) => `${name} → ${specifier}`)
    );

    expect(reaching).toEqual([]);
  });
});
