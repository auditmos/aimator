import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import {
  addCharacter,
  addCharacterSources,
  addEpisode,
  approveStage0,
  checkStage0,
  initProject,
  setCharacterBasis,
  setEpisodeSettings,
  setNarratorVoice,
  showProject,
} from "./index.js";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

const FULL_SETTINGS = {
  audio: "music-and-effects" as const,
  durationSeconds: 60,
  language: "pl",
  sourceNature: "law-or-idea" as const,
  subtitles: "pl",
};

async function tree(path: string): Promise<string[]> {
  const out: string[] = [];

  for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
    out.push(join(entry.parentPath, entry.name).slice(path.length + 1));
  }

  return out.sort();
}

/**
 * A project with one declared cast member, because that is now the smallest
 * shape stage 0 accepts: a project with nobody in it is undecided, not a
 * project holding one anonymous character.
 */
async function makeProject(
  aspectRatio: string | null = "16:9",
  basis: "description" | null = "description"
): Promise<void> {
  const result = await initProject({
    aspectRatio,
    mode: "apply",
    projectId: "demo",
    title: "Demo",
    workspace,
  });

  expect(result.ok).toBe(true);

  const cast = await addCharacter({
    characterId: "ewa",
    mode: "apply",
    name: "Ewa",
    projectId: "demo",
    workspace,
  });

  expect(cast.ok).toBe(true);

  if (basis !== null) {
    const declared = await setCharacterBasis({
      basis,
      characterId: "ewa",
      mode: "apply",
      projectId: "demo",
      workspace,
    });

    expect(declared.ok).toBe(true);
  }
}

async function readProject(): Promise<{
  characters: Record<
    string,
    { basis: string | null; name: string; sources: { originPath: string }[] }
  >;
}> {
  return JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));
}

async function makeSource(name = "01-NEVER OUTSHINE THE MASTER.md"): Promise<string> {
  const path = join(scratch, name);
  // BOM, CRLF and non-ASCII: byte preservation has to mean something.
  await writeFile(path, "﻿# Prawo\r\nNigdy nie przyćmiewaj mistrza.\n", "utf8");
  return path;
}

function fillRules(): Promise<void> {
  return writeFile(
    join(root, "projects/demo/project.md"),
    "# Demo\n\nWszystko ustalone.\n",
    "utf8"
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-src-"));
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("initProject", () => {
  it("should create the stage-0 artifacts", async () => {
    await makeProject();
    expect(await tree(root)).toEqual([
      "projects",
      "projects/demo",
      "projects/demo/prepare.stage.json",
      "projects/demo/project.json",
      "projects/demo/project.md",
    ]);
  });

  it("should not promise directories nothing has written to yet", async () => {
    await makeProject();
    const entries = await tree(root);
    expect(entries).not.toContain("projects/demo/characters/ewa/sources");
    expect(entries).not.toContain("projects/demo/episodes");
    expect(entries).not.toContain("projects/demo/characters/ewa/gpt-image");
  });

  it("should report an undecided character basis", async () => {
    await makeProject("16:9", null);
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("nie ma ustalonej podstawy");
  });

  /**
   * The silent default this whole shape exists to remove: a project with no
   * declared cast used to mean "one character, anonymous", which is how a
   * series whose rules describe two people produced one.
   */
  it("should refuse an empty cast rather than assume a single character", async () => {
    const result = await initProject({
      aspectRatio: "16:9",
      mode: "apply",
      projectId: "demo",
      title: "Demo",
      workspace,
    });

    expect(result.ok ? result.data.problems.join(" ") : null).toContain("obsada jest pusta");

    await fillRules();
    const check = await checkStage0({ projectId: "demo", workspace });
    expect(check.ok ? null : check.error.message).toContain("obsada jest pusta");
  });

  it("should scaffold rules that still carry placeholders", async () => {
    await makeProject();
    const rules = await readFile(join(root, "projects/demo/project.md"), "utf8");
    expect(rules).toContain("TODO(etap-0)");
    expect(rules).toContain("# Demo, zasady wspólne");
  });

  it("should record the project file digest in the stage record", async () => {
    await makeProject();
    const stage = JSON.parse(
      await readFile(join(root, "projects/demo/prepare.stage.json"), "utf8")
    );
    expect(stage.stage).toBe("prepare");
    expect(stage.artifacts.project.outputs[0].path).toBe("projects/demo/project.json");
    expect(stage.artifacts.project.review.status).toBe("pending");
  });

  it("should write nothing in dry-run mode", async () => {
    const result = await initProject({
      aspectRatio: "16:9",
      mode: "dry-run",
      projectId: "demo",
      title: "Demo",
      workspace,
    });
    expect(result.ok).toBe(true);
    expect(await tree(root)).toEqual([]);
  });

  it("should refuse to overwrite an existing project", async () => {
    await makeProject();
    await fillRules();
    const again = await initProject({
      aspectRatio: "16:9",
      mode: "apply",
      projectId: "demo",
      title: "Inny",
      workspace,
    });
    expect(again.ok ? null : again.error.message).toContain("już istnieje");
    expect(await readFile(join(root, "projects/demo/project.md"), "utf8")).not.toContain(
      "TODO(etap-0)"
    );
  });

  it("should reject an invalid project id", async () => {
    const result = await initProject({
      aspectRatio: null,
      mode: "apply",
      projectId: "../escape",
      title: "Demo",
      workspace,
    });
    expect(result.ok).toBe(false);
  });

  it("should reject a malformed aspect ratio", async () => {
    const result = await initProject({
      aspectRatio: "szeroki",
      mode: "apply",
      projectId: "demo",
      title: "Demo",
      workspace,
    });
    expect(result.ok ? null : result.error.message).toContain("16:9");
  });
});

describe("addEpisode", () => {
  it("should preserve the source bytes exactly", async () => {
    await makeProject();
    const source = await makeSource();
    const result = await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: source,
      workspace,
    });

    expect(result.ok).toBe(true);
    const original = await readFile(source);
    const copied = await readFile(
      join(root, "projects/demo/episodes/01-never-outshine-the-master/source.md")
    );
    expect(Buffer.compare(original, copied)).toBe(0);
  });

  it("should write settings as nulls until they are decided", async () => {
    await makeProject();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource(),
      workspace,
    });
    const episode = JSON.parse(
      await readFile(
        join(root, "projects/demo/episodes/01-never-outshine-the-master/episode.json"),
        "utf8"
      )
    );
    expect(episode.settings).toEqual({
      audio: null,
      durationSeconds: null,
      language: null,
      maxClipSeconds: null,
      sourceNature: null,
      subtitles: null,
    });
    expect(episode.number).toBe(1);
  });

  it("should accept settings supplied up front", async () => {
    await makeProject();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      sourcePath: await makeSource(),
      workspace,
    });
    const episode = JSON.parse(
      await readFile(
        join(root, "projects/demo/episodes/01-never-outshine-the-master/episode.json"),
        "utf8"
      )
    );
    expect(episode.settings.durationSeconds).toBe(60);
  });

  it("should reject a duplicate episode number", async () => {
    await makeProject();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource("01-first.md"),
      workspace,
    });
    const clash = await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource("01-second.md"),
      workspace,
    });
    expect(clash.ok ? null : clash.error.message).toContain("unikalny");
  });

  it("should reject an empty source file", async () => {
    await makeProject();
    const empty = join(scratch, "02-empty.md");
    await writeFile(empty, "", "utf8");
    const result = await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: empty,
      workspace,
    });
    expect(result.ok ? null : result.error.message).toContain("pusty");
  });

  it("should reject a source whose name carries no episode number", async () => {
    await makeProject();
    const result = await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource("intro.md"),
      workspace,
    });
    expect(result.ok ? null : result.error.message).toContain("01-");
  });

  it("should refuse when the project does not exist", async () => {
    const result = await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource(),
      workspace,
    });
    expect(result.ok ? null : result.error.message).toContain("nie istnieje");
  });

  it("should write nothing in dry-run mode", async () => {
    await makeProject();
    const before = await tree(root);
    await addEpisode({
      mode: "dry-run",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource(),
      workspace,
    });
    expect(await tree(root)).toEqual(before);
  });
});

describe("setEpisodeSettings", () => {
  const episodeId = "01-never-outshine-the-master";

  beforeEach(async () => {
    await makeProject();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource(),
      workspace,
    });
  });

  it("should merge a subset of decisions", async () => {
    const result = await setEpisodeSettings({
      episodeId,
      mode: "apply",
      projectId: "demo",
      settings: { durationSeconds: 60 },
      workspace,
    });
    expect(result.ok ? result.data.ready : null).toBe(false);
    expect(result.ok ? result.data.problems.length : null).toBe(4);
  });

  it("should report ready once every decision is made", async () => {
    const result = await setEpisodeSettings({
      episodeId,
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      workspace,
    });
    expect(result.ok ? result.data.ready : null).toBe(true);
  });

  it("should reject a duration outside 1-3600", async () => {
    const result = await setEpisodeSettings({
      episodeId,
      mode: "apply",
      projectId: "demo",
      settings: { durationSeconds: 3601 },
      workspace,
    });
    expect(result.ok ? null : result.error.message).toContain("3601");
  });

  it("should reject an unsupported audio mode", async () => {
    const result = await setEpisodeSettings({
      episodeId,
      mode: "apply",
      projectId: "demo",
      settings: { audio: "voice-over" as never },
      workspace,
    });
    expect(result.ok ? null : result.error.message).toContain("dialogue-and-narration");
  });

  it("should accept none as a subtitles value", async () => {
    const result = await setEpisodeSettings({
      episodeId,
      mode: "apply",
      projectId: "demo",
      settings: { subtitles: "none" },
      workspace,
    });
    expect(result.ok).toBe(true);
  });

  it("should refuse for an unknown episode", async () => {
    const result = await setEpisodeSettings({
      episodeId: "09-nope",
      mode: "apply",
      projectId: "demo",
      settings: { durationSeconds: 10 },
      workspace,
    });
    expect(result.ok ? null : result.error.message).toContain("nie istnieje");
  });
});

describe("addCharacterSources", () => {
  it("should copy photos and record their digests", async () => {
    await makeProject();
    const photo = join(scratch, "portret.png");
    await writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await addCharacterSources({
      characterId: "ewa",
      mode: "apply",
      projectId: "demo",
      sourcePaths: [photo],
      workspace,
    });

    expect(result.ok ? result.data.created : null).toEqual([
      "projects/demo/characters/ewa/sources/portret.png",
    ]);
    const project = JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));
    expect(project.characters.ewa.sources).toHaveLength(1);
    expect(project.characters.ewa.sources[0].originPath).toBe(photo);
  });

  it("should not record the same photo twice", async () => {
    await makeProject();
    const photo = join(scratch, "portret.png");
    await writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await addCharacterSources({
      characterId: "ewa",
      mode: "apply",
      projectId: "demo",
      sourcePaths: [photo],
      workspace,
    });
    const again = await addCharacterSources({
      characterId: "ewa",
      mode: "apply",
      projectId: "demo",
      sourcePaths: [photo],
      workspace,
    });

    expect(again.ok ? again.data.created : null).toEqual([]);
    const project = JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));
    expect(project.characters.ewa.sources).toHaveLength(1);
  });
});

describe("checkStage0", () => {
  async function readyProject(): Promise<void> {
    await makeProject();
    await fillRules();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      sourcePath: await makeSource(),
      workspace,
    });
  }

  it("should block while the rules still carry placeholders", async () => {
    await makeProject();
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("TODO(etap-0)");
  });

  it("should block while the aspect ratio is undecided", async () => {
    await makeProject(null);
    await fillRules();
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("aspectRatio");
  });

  // Stage 2 opens on the project's approval alone and never reads an episode,
  // so an episodeless project passes and says what is still missing for stage 1.
  it("should report a project with no episode without blocking on it", async () => {
    await makeProject();
    await fillRules();
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.data.problems.join("\n") : "").toContain("żadnego odcinka");
  });

  it("should approve a project that has no episode yet", async () => {
    await makeProject();
    await fillRules();
    const result = await approveStage0({
      mode: "apply",
      note: null,
      projectId: "demo",
      reviewer: "tester",
      workspace,
    });
    expect(result.ok ? result.data.approved : null).toBe(true);
    expect(result.ok ? result.data.nextStep : "").toContain("character generate");
  });

  it("should block while an episode decision is missing", async () => {
    await makeProject();
    await fillRules();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: { durationSeconds: 60 },
      sourcePath: await makeSource(),
      workspace,
    });
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("brak decyzji");
  });

  it("should pass a complete stage 0 but withhold approval", async () => {
    await readyProject();
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? result.data.ready : null).toBe(true);
    expect(result.ok ? result.data.approved : null).toBe(false);
    expect(result.ok ? result.data.nextStep : null).toContain("approve");
  });

  it("should block photographs declared with no photograph supplied", async () => {
    await makeProject("16:9", null);
    await fillRules();
    // Written straight to disk: the command refuses this state, so only a file
    // edited outside the tool can reach the check being exercised here.
    const path = join(root, "projects/demo/project.json");
    const file = JSON.parse(await readFile(path, "utf8"));
    file.characters.ewa.basis = "photographs";
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("ani jednego zdjęcia");
  });

  it("should detect project.json edited outside the tool", async () => {
    await readyProject();
    const path = join(root, "projects/demo/project.json");
    const file = JSON.parse(await readFile(path, "utf8"));
    // Still schema-valid, so only the digest can catch it.
    await writeFile(
      path,
      `${JSON.stringify({ ...file, title: "Podmieniony" }, null, 2)}\n`,
      "utf8"
    );
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("zmieniony poza narzędziem");
  });

  it("should detect a source edited outside the tool", async () => {
    await readyProject();
    await writeFile(
      join(root, "projects/demo/episodes/01-never-outshine-the-master/source.md"),
      "podmienione",
      "utf8"
    );
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("zmieniony poza narzędziem");
  });

  it("should refuse for an unknown project", async () => {
    const result = await checkStage0({ projectId: "nieznany", workspace });
    expect(result.ok ? null : result.error.message).toContain("nie istnieje");
  });
});

describe("setCharacterBasis", () => {
  it("should record that the character comes from the description", async () => {
    await makeProject("16:9", null);
    const result = await setCharacterBasis({
      basis: "description",
      characterId: "ewa",
      mode: "apply",
      projectId: "demo",
      workspace,
    });

    expect(result.ok).toBe(true);
    const project = JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));
    expect(project.characters.ewa.basis).toBe("description");
  });

  it("should refuse to declare photographs without any photograph", async () => {
    await makeProject("16:9", null);
    const result = await setCharacterBasis({
      basis: "photographs",
      characterId: "ewa",
      mode: "apply",
      projectId: "demo",
      workspace,
    });

    expect(result.ok ? null : result.error.message).toContain("pustą ręką");
  });

  it("should flip to photographs when a photo is added", async () => {
    await makeProject("16:9", "description");
    const photo = join(scratch, "portret.png");
    await writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await addCharacterSources({
      characterId: "ewa",
      mode: "apply",
      projectId: "demo",
      sourcePaths: [photo],
      workspace,
    });

    const project = JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));
    expect(project.characters.ewa.basis).toBe("photographs");
    expect(result.ok ? result.data.problems.join(" ") : null).toContain("z opisu na zdjęcia");
  });
});

/**
 * The narrator's voice is cast, not configuration.
 *
 * It recurs between episodes exactly as a character does, which is the one
 * criterion that puts somebody in `project.json` rather than in an episode or
 * in a shell. Stage 0 does not gate it: like `maxClipSeconds`, the stage that
 * consumes it is the stage that insists on it, and a project that will never
 * have a narrator must not be held hostage by a decision it never makes.
 */
describe("setNarratorVoice", () => {
  it("should record the voice on the project, beside the cast", async () => {
    await makeProject();
    const result = await setNarratorVoice({
      mode: "apply",
      projectId: "demo",
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      workspace,
    });

    expect(result.ok).toBe(true);
    const project = JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));
    expect(project.narratorVoiceId).toBe("21m00Tcm4TlvDq8ikWAM");
  });

  /**
   * Undecided is written down as undecided. A fresh project carries the key
   * with a null in it rather than leaving it out, so "nobody has chosen a
   * narrator" is a fact the file states instead of one a reader infers from an
   * absence, which is the whole of rule 7 in one field.
   */
  it("should start undecided rather than absent", async () => {
    await makeProject();
    const project = JSON.parse(await readFile(join(root, "projects/demo/project.json"), "utf8"));

    expect(project).toHaveProperty("narratorVoiceId");
    expect(project.narratorVoiceId).toBeNull();
  });

  it("should not hold stage 0 hostage to a voice nobody has chosen", async () => {
    await makeProject();
    await fillRules();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: {},
      sourcePath: await makeSource(),
      workspace,
    });
    await setEpisodeSettings({
      episodeId: "01-never-outshine-the-master",
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      workspace,
    });

    const status = await checkStage0({ projectId: "demo", workspace });

    expect(status.ok ? status.data.ready : null).toBe(true);
  });
});

describe("approveStage0", () => {
  async function readyProject(): Promise<void> {
    await makeProject();
    await fillRules();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      sourcePath: await makeSource(),
      workspace,
    });
  }

  function approve(): ReturnType<typeof approveStage0> {
    return approveStage0({
      mode: "apply",
      note: "przeczytane",
      projectId: "demo",
      reviewer: "tkow",
      workspace,
    });
  }

  it("should refuse to approve what does not validate", async () => {
    await makeProject();
    const result = await approve();
    expect(result.ok ? null : result.error.message).toContain("TODO(etap-0)");
  });

  it("should mark every stage record as approved", async () => {
    await readyProject();
    const result = await approve();

    expect(result.ok ? result.data.approved : null).toBe(true);
    const project = JSON.parse(
      await readFile(join(root, "projects/demo/prepare.stage.json"), "utf8")
    );
    const episode = JSON.parse(
      await readFile(
        join(root, "projects/demo/episodes/01-never-outshine-the-master/prepare.stage.json"),
        "utf8"
      )
    );
    expect(project.artifacts.project.review.status).toBe("approved");
    expect(project.artifacts.project.review.reviewer).toBe("tkow");
    expect(episode.artifacts.episode.review.status).toBe("approved");
  });

  it("should bind the approval to the rules as they stand", async () => {
    await readyProject();
    await approve();
    const stage = JSON.parse(
      await readFile(join(root, "projects/demo/prepare.stage.json"), "utf8")
    );
    const paths = stage.artifacts.project.outputs.map((output: { path: string }) => output.path);
    expect(paths).toContain("projects/demo/project.md");
  });

  /**
   * Rewritten rules revoke the approval the same way a changed decision does:
   * the files still validate, nobody has accepted these bytes. Treating it as
   * a validation failure instead made the lapse permanent, because `approve`
   * refuses what does not validate and is the only thing that records the new
   * digest.
   */
  it("should revoke the approval when the rules are rewritten", async () => {
    await readyProject();
    await approve();
    await writeFile(join(root, "projects/demo/project.md"), "# Demo\n\nCo innego.\n", "utf8");

    const result = await checkStage0({ projectId: "demo", workspace });

    expect(result.ok ? result.data.approved : null).toBe(false);
    expect(result.ok ? result.data.problems.join(" ") : null).toContain("po akceptacji");
  });

  it("should let rewritten rules be approved again", async () => {
    await readyProject();
    await approve();
    await writeFile(join(root, "projects/demo/project.md"), "# Demo\n\nCo innego.\n", "utf8");

    const again = await approve();

    expect(again.ok ? again.data.approved : null).toBe(true);
    const after = await checkStage0({ projectId: "demo", workspace });
    expect(after.ok ? after.data.approved : null).toBe(true);
  });

  it("should report an approval lapsed by a later decision", async () => {
    await readyProject();
    await approve();
    const result = await setEpisodeSettings({
      episodeId: "01-never-outshine-the-master",
      mode: "apply",
      projectId: "demo",
      settings: { durationSeconds: 90 },
      workspace,
    });

    expect(result.ok ? result.data.problems.join(" ") : null).toContain("wygasła");
    const after = await checkStage0({ projectId: "demo", workspace });
    expect(after.ok ? after.data.approved : null).toBe(false);
  });

  it("should hand off to stage 1 once approved", async () => {
    await readyProject();
    await approve();
    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? result.data.approved : null).toBe(true);
    expect(result.ok ? result.data.nextStep : null).toContain("screenplay generate");
    expect(result.ok ? result.data.nextStep : null).toContain("character generate");
  });

  it("should write nothing in dry-run mode", async () => {
    await readyProject();
    const result = await approveStage0({
      mode: "dry-run",
      note: null,
      projectId: "demo",
      reviewer: "tkow",
      workspace,
    });

    expect(result.ok).toBe(true);
    const stage = JSON.parse(
      await readFile(join(root, "projects/demo/prepare.stage.json"), "utf8")
    );
    expect(stage.artifacts.project.review.status).toBe("pending");
  });
});

describe("project.json written before the cast existed", () => {
  async function writeLegacy(sources: unknown[] = []): Promise<string> {
    const path = join(root, "projects/demo/project.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          aspectRatio: "16:9",
          characterBasis: "description",
          characterSources: sources,
          id: "demo",
          schemaVersion: 1,
          title: "Demo",
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    return path;
  }

  /**
   * The old basis is dropped, not carried onto whichever member is declared
   * first: it described a character nobody had named, so moving it would be
   * inventing an answer rather than migrating one.
   */
  it("should read as an empty cast rather than as one anonymous character", async () => {
    await makeProject();
    await fillRules();
    await writeLegacy();

    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("obsada jest pusta");
  });

  it("should let a named character be declared over it", async () => {
    await makeProject();
    await fillRules();
    await writeLegacy();

    const result = await addCharacter({
      characterId: "ewa",
      mode: "apply",
      name: "Ewa",
      projectId: "demo",
      workspace,
    });

    expect(result.ok).toBe(true);
    const project = await readProject();
    expect(project.characters.ewa).toEqual({ basis: null, name: "Ewa", sources: [] });
  });

  it("should refuse to convert one that already holds photographs", async () => {
    await makeProject();
    await fillRules();
    await writeLegacy([
      {
        originPath: "/tmp/portret.png",
        path: "projects/demo/character/sources/portret.png",
        sha256: "a".repeat(64),
      },
    ]);

    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("nienazwanej postaci");
  });
});

describe("layout drift", () => {
  it("should report a directory nothing has written to", async () => {
    await makeProject();
    await fillRules();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      sourcePath: await makeSource(),
      workspace,
    });
    await mkdir(join(root, "projects/demo/characters/ewa/sources"), { recursive: true });

    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("katalog nic nie zawiera");
  });

  it("should name the outermost empty directory, not every level of it", async () => {
    await makeProject();
    await fillRules();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      sourcePath: await makeSource(),
      workspace,
    });
    await mkdir(join(root, "projects/demo/characters/ewa/sources"), { recursive: true });

    const result = await checkStage0({ projectId: "demo", workspace });
    const reported = result.ok
      ? []
      : result.error.message.split("\n").filter((line) => line.includes("katalog nic nie zawiera"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("projects/demo/character");
    expect(reported[0]).not.toContain("character/sources");
  });

  it("should not count a dotfile as contents", async () => {
    await makeProject();
    await fillRules();
    await addEpisode({
      mode: "apply",
      projectId: "demo",
      settings: FULL_SETTINGS,
      sourcePath: await makeSource(),
      workspace,
    });
    await mkdir(join(root, "projects/demo/characters"), { recursive: true });
    await writeFile(join(root, "projects/demo/characters/.DS_Store"), "x", "utf8");

    const result = await checkStage0({ projectId: "demo", workspace });
    expect(result.ok ? null : result.error.message).toContain("katalog nic nie zawiera");
  });
});

/**
 * What a project is, read back: the answer every write above has no command
 * to give.
 *
 * Each stage-0 write reports what it changed, and nothing reported what the
 * project now holds, so a screen that wanted to show the cast could only have
 * read `project.json` itself, which is the private road the UI is forbidden.
 * The read is deliberately a description and not a verdict: whether stage 0
 * holds is `checkStage0`'s question, and a second answer to it here would be
 * two gates that drift.
 */
describe("showProject", () => {
  it("should say what is undecided as undecided, not leave it out", async () => {
    await initProject({
      aspectRatio: null,
      mode: "apply",
      projectId: "demo",
      title: "Demo",
      workspace,
    });

    const result = await showProject({ projectId: "demo", workspace });

    expect(result.ok ? result.data : result.error.message).toEqual({
      aspectRatio: null,
      cast: [],
      narratorVoiceId: null,
      projectId: "demo",
      title: "Demo",
    });
  });

  it("should read the cast in declaration order, each with its basis and photos", async () => {
    await makeProject();
    await addCharacter({
      characterId: "tata",
      mode: "apply",
      name: "Tata",
      projectId: "demo",
      workspace,
    });
    const photo = join(scratch, "portret.png");
    await writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await addCharacterSources({
      characterId: "tata",
      mode: "apply",
      projectId: "demo",
      sourcePaths: [photo],
      workspace,
    });
    await setNarratorVoice({ mode: "apply", projectId: "demo", voiceId: "voice-1", workspace });

    const result = await showProject({ projectId: "demo", workspace });

    expect(result.ok ? result.data : result.error.message).toEqual({
      aspectRatio: "16:9",
      cast: [
        { basis: "description", id: "ewa", name: "Ewa", sources: [] },
        {
          basis: "photographs",
          id: "tata",
          name: "Tata",
          sources: ["projects/demo/characters/tata/sources/portret.png"],
        },
      ],
      narratorVoiceId: "voice-1",
      projectId: "demo",
      title: "Demo",
    });
  });

  it("should refuse a project that does not exist, in the words every stage uses", async () => {
    const result = await showProject({ projectId: "nie-ma", workspace });

    expect(result.ok ? null : result.error.message).toContain('projekt "nie-ma" nie istnieje');
  });
});
