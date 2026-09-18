import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./cli.js";

let root = "";
let scratch = "";

async function cli(...argv: string[]): Promise<{ ok: boolean; text: string }> {
  const result = await run([...argv, "--workspace", root]);
  return result.ok ? { ok: true, text: result.data } : { ok: false, text: result.error.message };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-src-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("run", () => {
  it("should return usage when given no arguments", async () => {
    const result = await run([]);
    expect(result.ok && result.data).toContain("Usage: aimator");
  });

  it("should return usage for --help", async () => {
    const result = await run(["--help"]);
    expect(result.ok && result.data).toContain("project init");
  });

  it("should fail on an unknown command", async () => {
    const result = await run(["nope"]);
    expect(result.ok ? null : result.error.message).toContain("unknown command: nope");
  });

  it("should fail on an unknown subcommand", async () => {
    const result = await cli("episode", "publish");
    expect(result.text).toContain("nieznane polecenie: episode publish");
  });

  it("should fail on an unknown flag", async () => {
    const result = await cli("project", "init", "demo", "--title", "Demo", "--colour", "red");
    expect(result.ok).toBe(false);
  });

  it("should report an unconfigured workspace", async () => {
    const result = await run(["check", "demo", "--workspace", "  "]);
    expect(result.ok ? null : result.error.message).toContain("AIMATOR_WORKSPACE");
  });
});

describe("project init", () => {
  it("should create a project and name the next step", async () => {
    const result = await cli(
      "project",
      "init",
      "demo",
      "--title",
      "Demo",
      "--aspect-ratio",
      "16:9"
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("projects/demo/project.json");
    expect(result.text).toContain("Dalej:");
  });

  it("should mark a dry run and write nothing", async () => {
    const result = await cli("project", "init", "demo", "--title", "Demo", "--dry-run");
    expect(result.text).toContain("Próba na sucho");
    expect(await readdir(root)).toEqual([]);
  });

  it("should require --title", async () => {
    const result = await cli("project", "init", "demo");
    expect(result.text).toContain("--title");
  });

  it("should require the project id", async () => {
    const result = await cli("project", "init", "--title", "Demo");
    expect(result.text).toContain("<project-id>");
  });
});

describe("episode add and set", () => {
  beforeEach(async () => {
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
  });

  async function source(): Promise<string> {
    const path = join(scratch, "01-prawo.md");
    await writeFile(path, "Nigdy nie przyćmiewaj mistrza.\n", "utf8");
    return path;
  }

  it("should add an episode and ask for the remaining decisions", async () => {
    const result = await cli("episode", "add", "demo", "--source", await source());
    expect(result.ok).toBe(true);
    expect(result.text).toContain("episode set");
  });

  it("should accept every decision at once", async () => {
    const result = await cli(
      "episode",
      "add",
      "demo",
      "--source",
      await source(),
      "--duration",
      "60",
      "--audio",
      "music-and-effects",
      "--language",
      "pl",
      "--subtitles",
      "pl",
      "--nature",
      "law-or-idea"
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("check demo");
  });

  it("should reject a non-numeric duration", async () => {
    await cli("episode", "add", "demo", "--source", await source());
    const result = await cli("episode", "set", "demo", "01-prawo", "--duration", "szybko");
    expect(result.ok).toBe(false);
  });

  it("should require the episode id on set", async () => {
    const result = await cli("episode", "set", "demo");
    expect(result.text).toContain("<episode-id>");
  });
});

describe("check", () => {
  it("should fail while stage 0 is incomplete", async () => {
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
    const result = await cli("check", "demo");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("TODO(etap-0)");
  });
});

describe("character", () => {
  beforeEach(async () => {
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
  });

  it("should record that a character comes from the description", async () => {
    await cli("character", "new", "demo", "ewa", "--name", "Ewa");
    const result = await cli("character", "describe", "demo", "ewa");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("project.md");
  });

  it("should refuse a basis for somebody who is not in the cast", async () => {
    const result = await cli("character", "describe", "demo", "tata");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("nie jest w obsadzie");
  });

  it("should carry every declared character separately", async () => {
    await cli("character", "new", "demo", "ewa", "--name", "Ewa");
    await cli("character", "new", "demo", "tata", "--name", "Tata");
    await cli("character", "describe", "demo", "ewa");

    const project = JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));
    expect(Object.keys(project.characters)).toEqual(["ewa", "tata"]);
    expect(project.characters.ewa.basis).toBe("description");
    expect(project.characters.tata.basis).toBeNull();
  });

  it("should require a name, because the prompt renders one", async () => {
    const result = await cli("character", "new", "demo", "ewa");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("--name");
  });
});

describe("approve", () => {
  async function readyProject(): Promise<void> {
    const path = join(scratch, "01-prawo.md");
    await writeFile(path, "Nigdy nie przyćmiewaj mistrza.\n", "utf8");
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
    await cli("character", "new", "demo", "ewa", "--name", "Ewa");
    await cli("character", "describe", "demo", "ewa");
    await writeFile(join(root, "projects/demo/project.md"), "# Demo\n\nUstalone.\n", "utf8");
    await cli(
      "episode",
      "add",
      "demo",
      "--source",
      path,
      "--duration",
      "60",
      "--audio",
      "narration",
      "--language",
      "pl",
      "--subtitles",
      "none",
      "--nature",
      "law-or-idea"
    );
  }

  it("should say validation is not acceptance", async () => {
    await readyProject();
    const result = await cli("check", "demo");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("to nie to samo co przyjęcie");
  });

  it("should approve and then hand off to stage 1", async () => {
    await readyProject();
    const approved = await cli("approve", "demo");
    expect(approved.ok).toBe(true);
    const result = await cli("check", "demo");
    expect(result.text).toContain("screenplay generate");
    expect(result.text).toContain("character generate");
  });

  it("should refuse to approve an incomplete stage 0", async () => {
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
    const result = await cli("approve", "demo");
    expect(result.ok).toBe(false);
  });
});

/**
 * Only `--dry-run` is exercised here. Stage 1's real path posts with the
 * process-wide `fetch` and a key from `.env`, so a CLI test that reached it
 * would spend money; the paid behaviour is covered in the screenplay module,
 * where `fetch` is injected.
 */
describe("screenplay generate", () => {
  async function approvedProject(): Promise<void> {
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
    await cli("character", "new", "demo", "ewa", "--name", "Ewa");
    await cli("character", "describe", "demo", "ewa");
    await writeFile(join(root, "projects/demo/project.md"), "# Demo\n\nZasady serii.\n", "utf8");
    const source = join(scratch, "01-Burza.md");
    await writeFile(source, "# Burza\n\nEwa boi się burzy.\n", "utf8");
    await cli(
      "episode",
      "add",
      "demo",
      "--source",
      source,
      "--duration",
      "90",
      "--audio",
      "narration",
      "--language",
      "pl",
      "--subtitles",
      "none",
      "--nature",
      "law-or-idea"
    );
    await cli("approve", "demo");
  }

  it("should print the exact prompt and the scene minimum", async () => {
    await approvedProject();
    const result = await cli("screenplay", "generate", "demo", "01-burza", "--dry-run");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("wymagane co najmniej 6 scen");
    expect(result.text).toContain("prompt wysłany do modelu");
    expect(result.text).toContain("# Task: write a screenplay");
    expect(result.text).toContain('"durationSeconds": 90');
    expect(result.text).toContain("Ewa boi się burzy.");
  });

  it("should write nothing during a dry run", async () => {
    await approvedProject();
    await cli("screenplay", "generate", "demo", "01-burza", "--dry-run");

    expect(await readdir(join(root, "projects/demo/episodes/01-burza"))).toEqual([
      "episode.json",
      "prepare.stage.json",
      "source.md",
    ]);
  });

  it("should name the missing approval as a blocker", async () => {
    await approvedProject();
    await writeFile(join(root, "projects/demo/project.md"), "# Demo\n\nInne zasady.\n", "utf8");
    const result = await cli("screenplay", "generate", "demo", "01-burza", "--dry-run");

    expect(result.text).toContain("approved");
  });

  it("should reject an unknown subcommand", async () => {
    const result = await cli("screenplay", "rewrite", "demo", "01-burza");
    expect(result.text).toContain("nieznane polecenie: screenplay rewrite");
  });

  it("should reject an out-of-range token limit", async () => {
    await approvedProject();
    const result = await cli(
      "screenplay",
      "generate",
      "demo",
      "01-burza",
      "--max-output-tokens",
      "1",
      "--dry-run"
    );

    expect(result.text).toContain("--max-output-tokens");
  });
});

describe("approve --stage", () => {
  it("should reject an unknown stage", async () => {
    const result = await cli("approve", "demo", "--stage", "montage");
    expect(result.text).toContain("dozwolone: prepare, screenplay");
  });

  it("should require an episode for the screenplay stage", async () => {
    const result = await cli("approve", "demo", "--stage", "screenplay");
    expect(result.text).toContain("<episode-id>");
  });
});

describe("approve --stage character", () => {
  it("should accept the track and artifact flags the usage documents", async () => {
    const result = await cli(
      "approve",
      "demo",
      "ewa",
      "--stage",
      "character",
      "--track",
      "gpt-image",
      "--artifact",
      "card"
    );

    expect(result.text).not.toContain("Unknown option");
  });

  it("should name the artifacts it knows when given one it does not", async () => {
    const result = await cli(
      "approve",
      "demo",
      "ewa",
      "--stage",
      "character",
      "--track",
      "gpt-image",
      "--artifact",
      "kadr"
    );

    expect(result.text).toContain('--artifact "kadr"');
  });

  it("should require the track, because each one costs separately", async () => {
    const result = await cli("approve", "demo", "ewa", "--stage", "character");
    expect(result.text).toContain("--track");
  });
});

describe("project init flags", () => {
  it("should refuse --character, because the cast is declared one at a time", async () => {
    const result = await cli("project", "init", "demo", "--title", "Demo", "--character", "ewa");
    expect(result.ok).toBe(false);
  });
});
