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
  type ShotListShape,
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
function answer(opening: readonly string[] = ["hero:ewa", "R01"]): string {
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
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: opening },
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
function upstream(shotList?: ShotListShape, opening?: readonly string[]): Promise<void> {
  return makeUpstream({
    answer: answer(opening),
    approvePackage: true,
    root,
    scratch,
    workspace,
    ...(shotList === undefined ? {} : { shotList }),
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
    checks: "all",
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

/** The opening frame is a film frame, so it carries the series' style frames. */
describe("style frames", () => {
  function styled(style: "undecided" | readonly Buffer[]): Promise<void> {
    return makeUpstream({
      answer: answer(),
      approvePackage: true,
      root,
      scratch,
      style,
      workspace,
    });
  }

  it("should refuse to spend while nobody has decided the style frames", async () => {
    await styled("undecided");
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain(
      `aimator project style ${PROJECT} --none`
    );
  });

  it("should show the style frames in a dry run, at the end of the list", async () => {
    await styled([png(64, 64, 1)]);
    await makeReferences("gpt-image");
    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.artifact.prompt : null).toContain(
      "Image 3 = style:S01 — style frame"
    );
    expect(result.ok ? result.data.artifact.attachments.at(-1)?.path : null).toBe(
      `projects/${PROJECT}/style/sources/S01.png`
    );
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

  it("should correct the opening frame under --instruction, with no --artifact", async () => {
    const note = "Zostaw noc, przyciemnij lampę.";
    await upstream();
    await makeReferences("gpt-image");
    await generate();
    const preview = await generate({ instruction: note, mode: "dry-run", regenerate: true });
    const call = recorder();
    const result = await generate({ fetch: call.fetch, instruction: note, regenerate: true });
    const record = (await readStageFile()).artifacts["opening-frame"];
    const form = call.calls[0]?.body as FormData;
    const [first] = form.getAll("image[]") as File[];

    expect(preview.ok ? preview.data.artifact.prompt : "").toContain(
      "REFERENCE INPUTS, IN THIS ORDER\nImage 1 = previous:opening-frame — "
    );
    expect(result.ok).toBe(true);
    expect(call.calls[0]?.prompt).toContain(
      `----- BEGIN NOTE -----\n${note}\n----- END NOTE -----`
    );
    expect(Buffer.from(await (first as File).arrayBuffer())).toEqual(FILM);
    expect(record.instruction).toBe(note);
    expect(record.inputs.map((entry: { path: string }) => entry.path)).toContainEqual(
      `projects/${PROJECT}/episodes/${EPISODE}/gpt-image/runs/${record.runId}/previous.png`
    );
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

  /** The next step is a command that works, so it carries the checklist it is judged by. */
  it("should name the criteria to judge by in the next step of a pending frame", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const drawn = await generate();
    const status = await inspect();

    for (const step of [
      drawn.ok ? drawn.data.nextStep : "",
      status.ok ? status.data.nextStep : "",
    ]) {
      expect(step).toContain("--checks anatomy,master,style,continuity,props");
    }
  });

  /** A screen builds its checklist from this, not from the sentence above. */
  it("should list the criteria a yes on the frame is given against", async () => {
    await upstream();
    await makeReferences("gpt-image");
    const absent = await inspect();
    await generate();
    const drawn = await inspect();

    for (const status of [absent, drawn]) {
      expect(status.ok ? status.data.artifact.checks : null).toEqual([
        "anatomy",
        "master",
        "style",
        "continuity",
        "props",
      ]);
    }
  });

  it("should leave master off the list of a frame that attaches no hero", async () => {
    await upstream("empty-opening", [OPENING_NEEDS]);
    await makeReferences("gpt-image");
    await generate();
    const status = await inspect();

    expect(status.ok ? status.data.artifact.checks : null).toEqual([
      "anatomy",
      "style",
      "continuity",
      "props",
    ]);
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

  /**
   * `master` compares the drawing with a cast member's canonical image. An
   * opening shot with nobody from the cast in it attaches no `hero:`, so there
   * is nothing to compare, and the checklist it is accepted against has four.
   */
  it("should not require master of a frame that attaches no hero", async () => {
    await upstream("empty-opening", [OPENING_NEEDS]);
    await makeReferences("gpt-image");
    await generate();
    const refused = await accept({ checks: null });
    const result = await accept({ checks: ["anatomy", "style", "continuity", "props"] });

    expect(refused.ok ? null : refused.error.message).toContain(
      "anatomy, style, continuity, props (albo --checks all)"
    );
    expect(result.ok ? result.data.approved : result.error.message).toBe(true);

    const stage = await readStageFile();
    expect(stage.artifacts["opening-frame"].review.checks).toEqual([
      "anatomy",
      "style",
      "continuity",
      "props",
    ]);
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
