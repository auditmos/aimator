import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  EPISODE,
  FILM,
  FRAME,
  makeUpstream,
  PROJECT,
  png,
  recorder,
} from "../../test/fixture.js";
import { approveReferences, generateReferences } from "../references/index.js";
import { type ImageTrack, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveOpeningFrame, checkOpeningFrame, generateOpeningFrame } from "./index.js";

/**
 * Stage 6 end to end, through the module entry.
 *
 * It is the first stage whose gate reads another stage's per-track results: the
 * opening frame waits for the references its manifest entry names, accepted on
 * this track and no other. It is also the first with exactly one artifact, so
 * the flags stage 5 needed to disambiguate a set, `--artifact` on a regenerate,
 * on an approval, have nothing here to disambiguate, and their absence is a
 * tested promise rather than an oversight.
 *
 * Stages 0 to 4 come from `src/test/fixture`, built through their own entries.
 * Stage 5 is run here, by the real command, because the thing under test is
 * what stage 6 does with an accepted reference and what it refuses to do
 * without one.
 */

/** What this episode's `opening.referenceIds` names, beside `hero:ewa`. */
const OPENING_NEEDS = "R01";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/**
 * The opening frame depends on `hero:ewa` and `R01`, so stage 6's gate has one
 * thing to wait for that stage 5 had to draw first, which is the whole point
 * of the stage's position in the pipeline.
 */
function answer(): string {
  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem, Ewa po lewej.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
      {
        id: "C02",
        prompt: "Oboje na dywanie.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
    ],
    entryFrames: [{ clipId: "C02", prompt: "Dokładnie końcowe położenie z C01." }],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki przy twarzy taty.",
  });
}

/** Stages 0 to 4, ending with a package this stage is allowed to read. */
function upstream(): Promise<void> {
  return makeUpstream({
    answer: answer(),
    approvePackage: true,
    root,
    scratch,
    workspace,
  });
}

/** Stage 5 on one track, up to and including the human's acceptance of R01. */
async function makeReferences(track: ImageTrack): Promise<void> {
  await generateReferences({
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track,
    workspace,
  });
  await approveReferences({
    artifacts: [OPENING_NEEDS],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track,
    workspace,
  });
}

function generate(overrides: Partial<Parameters<typeof generateOpeningFrame>[0]> = {}) {
  return generateOpeningFrame({
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

function accept(overrides: Partial<Parameters<typeof approveOpeningFrame>[0]> = {}) {
  return approveOpeningFrame({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

function inspect(track: ImageTrack = "gpt-image") {
  return checkOpeningFrame({ episodeId: EPISODE, projectId: PROJECT, track, workspace });
}

function trackDir(track: ImageTrack = "gpt-image"): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE, track);
}

async function readStageFile(track: ImageTrack = "gpt-image") {
  return JSON.parse(await readFile(join(trackDir(track), "opening-frame.stage.json"), "utf8"));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-stage6-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generateOpeningFrame gates", () => {
  it("should refuse to spend until the reference it names is approved on this track", async () => {
    await upstream();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain(OPENING_NEEDS);
  });

  /**
   * The gate reads this track's own results. A reference accepted on gpt-image
   * says nothing about seedream, exactly as stage 5's own graph gate does.
   */
  it("should not let an approval on one track open the other", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch, track: "seedream" });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain(OPENING_NEEDS);
  });

  it("should refuse a model nobody chose", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch, model: null });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain("--model");
  });

  it("should refuse an --artifact that is not the opening frame", async () => {
    await upstream();
    const call = recorder();
    const result = await generate({ artifacts: ["R01"], fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain("etap 6");
  });
});

describe("generateOpeningFrame --dry-run", () => {
  it("should show the whole prompt, count one call and spend nothing", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch, mode: "dry-run" });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(result.ok ? result.data.size : null).toBe(`${FRAME.width}x${FRAME.height}`);
    expect(result.ok ? result.data.artifact.prompt : null).toContain("Image 1 =");
  });

  /** A dry run never reads the key, so it must not claim the key is missing. */
  it("should say the key was not read rather than that it is absent", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : null).toContain("nie był czytany");
  });

  it("should report the gate as an obstacle and still show the prompt", async () => {
    await upstream();
    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.paidCalls : null).toBe(0);
    expect(result.ok ? result.data.artifact.state : null).toBe("blocked");
  });
});

describe("generateOpeningFrame", () => {
  it("should buy exactly one image and publish it under the track", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(call.calls).toHaveLength(1);

    const stage = await readStageFile();
    expect(stage.stage).toBe("opening-frame");
    expect(stage.artifacts["opening-frame"].status).toBe("completed");
    expect(stage.artifacts["opening-frame"].review.status).toBe("pending");
    expect(await readFile(join(trackDir(), "opening-frame.png"))).toEqual(FILM);
  });

  /** Rule 8: the text addresses its attachments by position in the list. */
  it("should send the attachment block ahead of the task", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const call = recorder();
    await generate({ fetch: call.fetch });

    const prompt = call.calls[0]?.prompt ?? "";
    expect(prompt).toContain("Image 1 = hero:ewa");
    expect(prompt).toContain(`Image 2 = ${OPENING_NEEDS}`);
    expect(prompt.indexOf("Image 1 =")).toBeLessThan(prompt.indexOf("Ewa centralnie"));
  });

  it("should record the shot list, because the opening frame carries its shots", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();

    const stage = await readStageFile();
    const inputs = stage.artifacts["opening-frame"].inputs.map((one: { path: string }) => one.path);
    expect(inputs.some((path: string) => path.endsWith("shot-list.md"))).toBe(true);
  });

  it("should not redraw a finished frame without --regenerate", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? result.data.paidCalls : null).toBe(0);
  });

  /**
   * With one artifact there is nothing for `--artifact` to disambiguate, so a
   * bare `--regenerate` is unambiguous and must work. Stage 5 needs the flag
   * because it has six candidates; copying that ceremony here would be asking
   * for an answer that has only one possible value.
   */
  it("should accept a bare --regenerate and draw again", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    const call = recorder();
    const result = await generate({ fetch: call.fetch, regenerate: true });

    expect(call.calls).toHaveLength(1);
    expect(result.ok ? result.data.paidCalls : null).toBe(1);
  });

  it("should keep the previous frame when it regenerates", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    await generate({ regenerate: true });

    const stage = await readStageFile();
    const { runId } = stage.artifacts["opening-frame"];
    expect(await readFile(join(trackDir(), "runs", runId, "previous.png"))).toEqual(FILM);
  });

  it("should refuse to publish an image in the wrong frame", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const call = recorder({ image: png(1024, 1024) });
    const result = await generate({ fetch: call.fetch });

    expect(result.ok).toBe(false);

    const stage = await readStageFile();
    expect(stage.artifacts["opening-frame"].status).toBe("submitted");
  });
});

describe("checkOpeningFrame", () => {
  it("should report a drawn frame as pending and write nothing", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    const before = await readStageFile();
    const status = await inspect();

    expect(status.ok ? status.data.approved : null).toBe(false);
    expect(status.ok ? status.data.artifact.state : null).toBe("completed");
    expect(await readStageFile()).toEqual(before);
  });

  it("should report a frame that was never drawn", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const status = await inspect();

    expect(status.ok ? status.data.artifact.state : null).toBe("absent");
  });
});

describe("approveOpeningFrame", () => {
  /** One artifact, so the command itself is the naming, no flag to repeat. */
  it("should accept the frame without an --artifact flag", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    const result = await accept();

    expect(result.ok ? result.data.approved : null).toBe(true);

    const stage = await readStageFile();
    expect(stage.artifacts["opening-frame"].review.status).toBe("approved");
    expect(stage.artifacts["opening-frame"].review.reviewer).toBe("tester");
  });

  it("should still accept an explicit --artifact opening-frame", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    const result = await accept({ artifacts: ["opening-frame"] });

    expect(result.ok ? result.data.approved : null).toBe(true);
  });

  it("should refuse an --artifact naming something else", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    const result = await accept({ artifacts: ["R01"] });

    expect(result.ok ? null : result.error.message).toContain("opening-frame");
  });

  it("should refuse to accept a frame that does not exist", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const result = await accept();

    expect(result.ok).toBe(false);
  });

  /** Acceptance is bound to bytes: editing the image revokes it. */
  it("should stop reporting an approval once the bytes change", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    await accept();
    await writeFile(join(trackDir(), "opening-frame.png"), png(FRAME.width, FRAME.height + 16));
    const status = await inspect();

    expect(status.ok ? status.data.approved : null).toBe(false);
  });

  /**
   * Input drift is an expiry of consent, not a validation failure: the frame is
   * exactly what stage 6 produced, drawn from a reference that has since been
   * redrawn. `approve` re-records the digests, because the person who typed it
   * is the one who looked at both.
   */
  it("should let an approval re-record a reference that drifted", async () => {
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    await accept();
    await generateReferences({
      apiKey: API_KEY,
      artifacts: [OPENING_NEEDS],
      episodeId: EPISODE,
      // Same frame, different bytes: a redrawn R01 that still validates.
      fetch: recorder({ image: png(FRAME.width, FRAME.height, 7) }).fetch,
      mode: "apply",
      model: "gpt-image-2.5-sunburst",
      projectId: PROJECT,
      regenerate: true,
      track: "gpt-image",
      workspace,
    });
    await approveReferences({
      artifacts: [OPENING_NEEDS],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "tester",
      track: "gpt-image",
      workspace,
    });

    const drifted = await inspect();
    expect(drifted.ok ? drifted.data.approved : null).toBe(false);
    expect(drifted.ok ? drifted.data.artifact.inputsChanged.length : 0).toBeGreaterThan(0);

    const again = await accept();
    expect(again.ok ? again.data.approved : null).toBe(true);
  });
});
