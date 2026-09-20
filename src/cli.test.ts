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

describe("opening-frame", () => {
  it("should be dispatched rather than read as an unknown command", async () => {
    const result = await cli(
      "opening-frame",
      "generate",
      "demo",
      "01-burza",
      "--track",
      "seedream"
    );
    expect(result.text).not.toContain("unknown command");
  });

  it("should reject a subcommand it does not have", async () => {
    const result = await cli("opening-frame", "redraw", "demo", "01-burza");
    expect(result.text).toContain("nieznane polecenie: opening-frame redraw");
  });

  it("should require the track, because each one costs separately", async () => {
    const result = await cli("opening-frame", "generate", "demo", "01-burza");
    expect(result.text).toContain("--track");
  });

  it("should require the episode", async () => {
    const result = await cli("opening-frame", "generate", "demo", "--track", "seedream");
    expect(result.text).toContain("<episode-id>");
  });

  /** One artifact, so the flag is optional — but it must still parse. */
  it("should accept --artifact opening-frame without calling it unknown", async () => {
    const result = await cli(
      "opening-frame",
      "generate",
      "demo",
      "01-burza",
      "--track",
      "seedream",
      "--artifact",
      "opening-frame"
    );

    expect(result.text).not.toContain("Unknown option");
  });

  it("should document itself in the usage text", async () => {
    const result = await run(["--help"]);
    expect(result.ok && result.data).toContain("opening-frame generate");
  });
});

describe("--stage opening-frame", () => {
  it("should be an allowed approve stage", async () => {
    const result = await cli(
      "approve",
      "demo",
      "01-burza",
      "--stage",
      "opening-frame",
      "--track",
      "seedream"
    );

    expect(result.text).not.toContain("dozwolone:");
  });

  it("should name itself among the allowed stages when another is wrong", async () => {
    const result = await cli("approve", "demo", "--stage", "montage");
    expect(result.text).toContain("opening-frame");
  });

  it("should require the track on approve", async () => {
    const result = await cli("approve", "demo", "01-burza", "--stage", "opening-frame");
    expect(result.text).toContain("--track");
  });

  it("should be an allowed check stage", async () => {
    const result = await cli(
      "check",
      "demo",
      "01-burza",
      "--stage",
      "opening-frame",
      "--track",
      "seedream"
    );

    expect(result.text).not.toContain("unknown command");
  });
});

describe("clip", () => {
  it("should be dispatched rather than read as an unknown command", async () => {
    const result = await cli("clip", "generate", "demo", "01-burza", "--track", "seedream");
    expect(result.text).not.toContain("unknown command");
  });

  it("should reject a subcommand it does not have", async () => {
    const result = await cli("clip", "render", "demo", "01-burza");
    expect(result.text).toContain("nieznane polecenie: clip render");
  });

  it("should require the track, because each one is a separate production", async () => {
    const result = await cli("clip", "generate", "demo", "01-burza");
    expect(result.text).toContain("--track");
  });

  /**
   * Two media in one command, so `--model` would not say which. Both flags are
   * named, and the bare one is refused rather than guessed at.
   */
  it("should refuse a bare --model and name the two it has", async () => {
    const result = await cli(
      "clip",
      "generate",
      "demo",
      "01-burza",
      "--track",
      "seedream",
      "--model",
      "sora"
    );

    expect(result.text).toContain("--image-model");
    expect(result.text).toContain("--video-model");
  });

  it("should accept --artifact for a clip and for an entry frame", async () => {
    const result = await cli(
      "clip",
      "generate",
      "demo",
      "01-burza",
      "--track",
      "seedream",
      "--artifact",
      "C01,entry:C02"
    );

    expect(result.text).not.toContain("Unknown option");
  });

  it("should document itself in the usage text", async () => {
    const result = await run(["--help"]);
    expect(result.ok && result.data).toContain("clip generate");
  });
});

describe("--stage clips", () => {
  it("should be an allowed approve stage", async () => {
    const result = await cli(
      "approve",
      "demo",
      "01-burza",
      "--stage",
      "clips",
      "--track",
      "seedream",
      "--artifact",
      "C01"
    );

    expect(result.text).not.toContain("dozwolone:");
  });

  it("should name itself among the allowed stages when another is wrong", async () => {
    const result = await cli("approve", "demo", "--stage", "montage");
    expect(result.text).toContain("clips");
  });

  it("should be an allowed check stage", async () => {
    const result = await cli(
      "check",
      "demo",
      "01-burza",
      "--stage",
      "clips",
      "--track",
      "seedream"
    );

    expect(result.text).not.toContain("unknown command");
  });
});

describe("assembly", () => {
  it("should be dispatched rather than read as an unknown command", async () => {
    const result = await cli("assembly", "generate", "demo", "01-burza", "--track", "seedream");
    expect(result.text).not.toContain("unknown command");
  });

  it("should reject a subcommand it does not have", async () => {
    const result = await cli("assembly", "cut", "demo", "01-burza");
    expect(result.text).toContain("nieznane polecenie: assembly cut");
  });

  /** Two tracks are two films; neither one is "the" episode. */
  it("should require the track", async () => {
    const result = await cli("assembly", "generate", "demo", "01-burza");
    expect(result.text).toContain("--track");
  });

  /**
   * The only generate command with no model flag, because it is the only one
   * that buys nothing. A flag that named a model here would be describing a
   * decision nobody has to make.
   */
  it("should not offer a model flag", async () => {
    const result = await cli(
      "assembly",
      "generate",
      "demo",
      "01-burza",
      "--track",
      "seedream",
      "--model",
      "gpt-6"
    );

    expect(result.text).toContain("Unknown option");
  });

  it("should document itself in the usage text", async () => {
    const result = await run(["--help"]);
    expect(result.ok && result.data).toContain("assembly generate");
  });
});

describe("--stage assembly", () => {
  /** One artifact per track, so the approval needs nothing to disambiguate. */
  it("should be an allowed approve stage with no --artifact", async () => {
    const result = await cli(
      "approve",
      "demo",
      "01-burza",
      "--stage",
      "assembly",
      "--track",
      "seedream"
    );

    expect(result.text).not.toContain("dozwolone:");
  });

  it("should name itself among the allowed stages when another is wrong", async () => {
    const result = await cli("approve", "demo", "--stage", "montage");
    expect(result.text).toContain("assembly");
  });

  it("should be an allowed check stage", async () => {
    const result = await cli(
      "check",
      "demo",
      "01-burza",
      "--stage",
      "assembly",
      "--track",
      "seedream"
    );

    expect(result.text).not.toContain("unknown command");
  });
});

describe("sound-design", () => {
  it("should be dispatched rather than read as an unknown command", async () => {
    const result = await cli("sound-design", "generate", "demo", "01-burza");
    expect(result.text).not.toContain("unknown command");
  });

  it("should reject a subcommand it does not have", async () => {
    const result = await cli("sound-design", "score", "demo", "01-burza");
    expect(result.text).toContain("nieznane polecenie: sound-design score");
  });

  /**
   * Three model flags, because three paid call sites: one text model writes
   * the cue sheet, one composes a bed and one renders an effect. A single
   * `--model` would mean that choosing how the score sounds quietly chose how
   * a thunderclap does, which is the refusal stage 7 already makes.
   */
  it("should name each of its three models separately", async () => {
    const result = await cli(
      "sound-design",
      "generate",
      "demo",
      "01-burza",
      "--model",
      "gpt-6",
      "--music-model",
      "music_v2",
      "--effects-model",
      "eleven_text_to_sound_v2",
      "--dry-run"
    );

    expect(result.text).not.toContain("Unknown option");
  });

  /** Two tracks are two films, and only the mix is per track. */
  it("should require the track for the mix and not for the sheet", async () => {
    const mix = await cli("sound-design", "mix", "demo", "01-burza");
    const generate = await cli("sound-design", "generate", "demo", "01-burza", "--dry-run");

    expect(mix.text).toContain("--track");
    expect(generate.text).not.toContain("--track");
  });

  it("should take the levels at the project level, with no episode", async () => {
    const result = await cli("sound-design", "levels", "demo", "--music-db", "-20", "--dry-run");
    expect(result.text).not.toContain("unknown command");
  });

  it("should document itself in the usage text", async () => {
    const result = await run(["--help"]);
    expect(result.ok && result.data).toContain("sound-design generate");
  });
});

describe("--stage sound-design", () => {
  it("should be an allowed approve stage for the shared half", async () => {
    const result = await cli(
      "approve",
      "demo",
      "01-burza",
      "--stage",
      "sound-design",
      "--artifact",
      "cues"
    );

    expect(result.text).not.toContain("dozwolone:");
  });

  it("should name itself among the allowed stages when another is wrong", async () => {
    const result = await cli("approve", "demo", "--stage", "montage");
    expect(result.text).toContain("sound-design");
  });

  it("should be an allowed check stage at both of its levels", async () => {
    const shared = await cli("check", "demo", "01-burza", "--stage", "sound-design");
    const track = await cli(
      "check",
      "demo",
      "01-burza",
      "--stage",
      "sound-design",
      "--track",
      "seedream"
    );

    expect(shared.text).not.toContain("unknown command");
    expect(track.text).not.toContain("unknown command");
  });
});

/**
 * Every decibel this stage takes is normally negative — a bed sits *under* a
 * voice — so `--music-db -22` is the ordinary case rather than an edge one.
 * `parseArgs` refuses it on its own, because it cannot tell a value starting
 * with a dash from the next option, and the `--music-db=-22` spelling that
 * does work is a trap rather than an interface.
 */
describe("a flag whose value is a negative number", () => {
  it("should take the level as a separate argument", async () => {
    const result = await cli(
      "sound-design",
      "levels",
      "demo",
      "--music-db",
      "-22",
      "--duck-db",
      "-12",
      "--dry-run"
    );

    expect(result.text).not.toContain("ambiguous");
    expect(result.text).toContain("-22");
  });

  it("should still take the joined spelling", async () => {
    const result = await cli("sound-design", "levels", "demo", "--music-db=-22", "--dry-run");

    expect(result.text).toContain("-22");
  });
});
