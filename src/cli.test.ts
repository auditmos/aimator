import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

describe("character describe", () => {
  beforeEach(async () => {
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
  });

  it("should record that the character comes from the description", async () => {
    const result = await cli("character", "describe", "demo");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("project.md");
  });

  it("should reject an unknown character basis at init", async () => {
    const result = await cli(
      "project",
      "init",
      "inny",
      "--title",
      "Inny",
      "--character",
      "zdjecia"
    );
    expect(result.text).toContain("photographs, description");
  });
});

describe("approve", () => {
  async function readyProject(): Promise<void> {
    const path = join(scratch, "01-prawo.md");
    await writeFile(path, "Nigdy nie przyćmiewaj mistrza.\n", "utf8");
    await cli(
      "project",
      "init",
      "demo",
      "--title",
      "Demo",
      "--aspect-ratio",
      "16:9",
      "--character",
      "description"
    );
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
    expect(result.text).toContain("Etap 1");
  });

  it("should refuse to approve an incomplete stage 0", async () => {
    await cli("project", "init", "demo", "--title", "Demo", "--aspect-ratio", "16:9");
    const result = await cli("approve", "demo");
    expect(result.ok).toBe(false);
  });
});
