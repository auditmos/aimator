import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideStyle,
  EPISODE,
  PROJECT as FIXTURE,
  makeTrack,
  makeUpstream,
  png,
} from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { checkClips } from "../clips/index.js";
import { checkOpeningFrame } from "../opening-frame/index.js";
import { checkPromptPackage } from "../prompt-package/index.js";
import { checkReferences } from "../references/index.js";
import { checkScreenplay } from "../screenplay/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import {
  addCharacter,
  approveStage0,
  checkStage0,
  initProject,
  setCharacterBasis,
  setStyle,
  showProject,
} from "./index.js";

/**
 * The project's style frames: a stage-0 decision with three answers, of which
 * this file tests the two that need no model, images brought in and "none".
 *
 * Assumptions it encodes, stated before the first test:
 *
 * - **The decision lives in `style.json`, never in `project.json`.** The latter
 *   is a recorded input of nearly every artifact, and a style frame is an input
 *   of film frames alone.
 * - **A supplied image is renamed `Snn.png` in the order it was brought**, and
 *   the same bytes brought twice are one image, as with a character's photos.
 * - **Absent `style.json` means undecided**, which is a fact to report, not a
 *   default to apply.
 */

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

const PROJECT = "demo";

/** One reference and two clips: the smallest package with a frame at every stage. */
const MANIFEST = JSON.stringify({
  clips: ["C01", "C02"].map((id) => ({
    id,
    prompt: `Akcja klipu ${id}.`,
    referenceIds: ["hero:ewa", "hero:tata", "R01"],
  })),
  entryFrames: [{ clipId: "C02", prompt: "Pierwsza chwila klipu C02." }],
  opening: { prompt: "Ewa centralnie.", referenceIds: ["hero:ewa", "R01"] },
  references: [
    {
      dependsOn: ["hero:ewa"],
      id: "R01",
      kind: "location",
      prompt: "Salon z niską kanapą.",
      subject: "Living room, evening",
    },
  ],
  review: "Do rozstrzygnięcia: nic.",
});

async function makeProject(): Promise<void> {
  await initProject({
    aspectRatio: "16:9",
    mode: "apply",
    projectId: PROJECT,
    title: "Demo",
    workspace,
  });
  await addCharacter({
    characterId: "ewa",
    mode: "apply",
    name: "Ewa",
    projectId: PROJECT,
    workspace,
  });
  await setCharacterBasis({
    basis: "description",
    characterId: "ewa",
    mode: "apply",
    projectId: PROJECT,
    workspace,
  });
}

async function image(name: string, fill: number): Promise<string> {
  const path = join(scratch, name);

  await writeFile(path, png(64, 64, fill));

  return path;
}

async function readStyleFile(): Promise<unknown> {
  return JSON.parse(await readFile(join(root, "projects", PROJECT, "style.json"), "utf8"));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-style-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
  await makeProject();
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("setStyle", () => {
  it("copies a supplied image to style/sources/S01.png and records its digest", async () => {
    const source = await image("a.png", 1);
    const result = await setStyle({
      decision: { basis: "supplied", sourcePaths: [source] },
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });

    expect(result.ok).toBe(true);

    const copied = await readFile(join(root, "projects", PROJECT, "style", "sources", "S01.png"));

    expect(copied.equals(png(64, 64, 1))).toBe(true);
    expect(await readStyleFile()).toEqual({
      basis: "supplied",
      schemaVersion: 1,
      sources: [
        {
          id: "S01",
          originPath: source,
          path: `projects/${PROJECT}/style/sources/S01.png`,
          sha256: sha256Of(png(64, 64, 1)),
        },
      ],
    });
  });

  it("numbers a second image S02 and keeps the same bytes brought twice as one", async () => {
    const first = await image("a.png", 1);
    const second = await image("b.png", 2);

    await setStyle({
      decision: { basis: "supplied", sourcePaths: [first] },
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });
    const again = await setStyle({
      decision: { basis: "supplied", sourcePaths: [second, first] },
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });

    expect(again.ok && again.data.created).toEqual([`projects/${PROJECT}/style/sources/S02.png`]);
    expect(again.ok && again.data.reused).toEqual([`projects/${PROJECT}/style/sources/S01.png`]);
    expect(await readStyleFile()).toMatchObject({
      basis: "supplied",
      sources: [{ id: "S01" }, { id: "S02" }],
    });
  });

  it("records an explicit none", async () => {
    const result = await setStyle({
      decision: { basis: "none" },
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });

    expect(result.ok).toBe(true);
    expect(await readStyleFile()).toEqual({ basis: "none", schemaVersion: 1, sources: [] });
  });

  it("refuses a file that is not a PNG, because it would land as Snn.png", async () => {
    const path = join(scratch, "a.jpg");

    await writeFile(path, "not an image", "utf8");

    const result = await setStyle({
      decision: { basis: "supplied", sourcePaths: [path] },
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("nie jest plikiem PNG");
  });

  it("writes nothing on a dry run", async () => {
    const result = await setStyle({
      decision: { basis: "supplied", sourcePaths: [await image("a.png", 1)] },
      mode: "dry-run",
      projectId: PROJECT,
      workspace,
    });

    expect(result.ok).toBe(true);
    await expect(readStyleFile()).rejects.toThrow();
  });

  it("is described by showProject, undecided as undecided", async () => {
    const before = await showProject({ projectId: PROJECT, workspace });

    expect(before.ok && before.data.style).toEqual({ basis: null, images: 0, sources: [] });

    await setStyle({
      decision: {
        basis: "supplied",
        sourcePaths: [await image("a.png", 1), await image("b.png", 2)],
      },
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });

    const after = await showProject({ projectId: PROJECT, workspace });

    expect(after.ok && after.data.style).toEqual({
      basis: "supplied",
      images: 2,
      sources: [
        `projects/${PROJECT}/style/sources/S01.png`,
        `projects/${PROJECT}/style/sources/S02.png`,
      ],
    });
  });

  it("is a stage-0 output: it survives a cast change, lapses approval and is verified", async () => {
    await writeFile(join(root, "projects", PROJECT, "project.md"), "# Demo\n\nUstalone.\n", "utf8");
    await approveStage0({
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "t",
      workspace,
    });

    const added = await setStyle({
      decision: { basis: "supplied", sourcePaths: [await image("a.png", 1)] },
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });

    expect(added.ok && added.data.problems.join("\n")).toContain("akceptacja projektu wygasła");

    await addCharacter({
      characterId: "tata",
      mode: "apply",
      name: "Tata",
      projectId: PROJECT,
      workspace,
    });
    await setCharacterBasis({
      basis: "description",
      characterId: "tata",
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });
    await approveStage0({
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "t",
      workspace,
    });

    const checked = await checkStage0({ projectId: PROJECT, workspace });

    expect(checked.ok && checked.data.approved).toBe(true);

    await writeFile(join(root, "projects", PROJECT, "style", "sources", "S01.png"), png(64, 64, 9));

    const tampered = await checkStage0({ projectId: PROJECT, workspace });

    expect(tampered.ok ? "" : tampered.error.message).toContain(
      `projects/${PROJECT}/style/sources/S01.png nie zgadza się z zapisanym hashem`
    );
  });
});

/** The decision as the stages that consume it see it, on the whole fixture. */
describe("style frames downstream", { timeout: 45_000 }, () => {
  /**
   * Where a decision lives decides what changing it invalidates. `style.json`
   * is recorded by film frames alone, so a new style frame lapses every frame
   * of stages 5 to 7, and the screenplay, which never read it, stays accepted.
   * A clip stays too: it was rendered from a frame whose bytes did not change.
   */
  it("lapses the frames of stages 5 to 7 when it changes, and not the screenplay", async () => {
    await makeUpstream({
      answer: MANIFEST,
      approvePackage: true,
      root,
      scratch,
      style: [png(64, 64, 1)],
      workspace,
    });
    await makeTrack({ root, track: "gpt-image", workspace });

    const scope = {
      episodeId: EPISODE,
      projectId: FIXTURE,
      track: "gpt-image" as const,
      workspace,
    };
    const before = await checkClips(scope);

    expect(before.ok && before.data.approved).toBe(true);

    await decideStyle([png(64, 64, 2)], scratch, workspace);

    const references = await checkReferences(scope);
    const opening = await checkOpeningFrame(scope);
    const clips = await checkClips(scope);
    const screenplay = await checkScreenplay(scope);
    const clip = (id: string) =>
      clips.ok ? clips.data.artifacts.find((one) => one.id === id) : null;

    expect(references.ok && references.data.artifacts[0]?.inputsChanged).toContain(
      `projects/${FIXTURE}/style.json`
    );
    expect(references.ok && references.data.approved).toBe(false);
    expect(opening.ok && opening.data.approved).toBe(false);
    expect(clip("entry:C02")?.approved).toBe(false);
    expect(clip("C01")?.approved).toBe(true);
    expect(screenplay.ok && screenplay.data.approved).toBe(true);
  });

  /** Each stage gates the decisions it consumes, and no stage before 5 draws a frame. */
  it("asks nothing of stages 0 to 4 while undecided", async () => {
    await makeUpstream({
      answer: MANIFEST,
      approvePackage: true,
      root,
      scratch,
      style: "undecided",
      workspace,
    });

    const stage0 = await checkStage0({ projectId: FIXTURE, workspace });
    const stage4 = await checkPromptPackage({ episodeId: EPISODE, projectId: FIXTURE, workspace });

    expect(stage0.ok && stage0.data.approved).toBe(true);
    expect(stage4.ok && stage4.data.approved).toBe(true);
    expect(stage4.ok && stage4.data.problems).toEqual([]);
  });
});
