import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  EPISODE,
  FRAME,
  makeUpstream,
  PROJECT,
  png,
  FILM as REFERENCE,
  recorder,
} from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { approvePromptPackage } from "../prompt-package/index.js";
import { type ImageTrack, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveReferences, checkReferences, generateReferences } from "./index.js";

/**
 * Stage 5 end to end, through the module entry: the graph gate inside its own
 * results, the run that draws every ready reference at once, the preview that
 * spends nothing, the resume that costs nothing, and the approval that is never
 * implied.
 *
 * The gate is what makes this stage different from every one before it, so it
 * is exercised per track: R04 waits for R03 **on this track**, and a reference
 * accepted on gpt-image does nothing for seedream.
 *
 * Stages 0 to 4 come from `src/test/fixture`. The package is left **pending**
 * there and accepted per case by `approvePackage()` below, because one of the
 * things under test is the refusal to spend before anybody has accepted it.
 */

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/**
 * A package whose graph has two roots and one dependent, which is the shape
 * stage 5 exists to enforce: R01 and R02 need only a canonical image, R03 waits
 * for R02.
 */
function answer(): string {
  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem, Ewa po lewej.",
        referenceIds: ["hero:ewa", "hero:tata", "R01", "R03"],
      },
      {
        id: "C02",
        prompt: "Oboje na dywanie.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
    ],
    entryFrames: [{ clipId: "C02", prompt: "Dokładnie końcowe położenie z C01." }],
    opening: { prompt: "Ewa centralnie.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room — evening",
      },
      {
        dependsOn: ["hero:ewa"],
        id: "R02",
        kind: "prop",
        prompt: "Pluszowa alpaka, nieugnieciona.",
        subject: "Alpaca toy — uncompressed",
      },
      {
        dependsOn: ["R02"],
        id: "R03",
        kind: "prop",
        prompt: "Ta sama alpaka, ucho ugięte kontaktem.",
        subject: "Alpaca toy — contact-bent ear",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki przy twarzy taty.",
  });
}

/** Stages 0 to 4, with stage 4 deliberately left unaccepted. */
function upstream(): Promise<void> {
  return makeUpstream({
    answer: answer(),
    approvePackage: false,
    root,
    scratch,
    workspace,
  });
}

async function approvePackage(): Promise<void> {
  await approvePromptPackage({
    episodeId: EPISODE,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });
}

function generate(overrides: Partial<Parameters<typeof generateReferences>[0]> = {}) {
  return generateReferences({
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

function accept(artifacts: readonly string[], track: ImageTrack = "gpt-image") {
  return approveReferences({
    artifacts,
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track,
    workspace,
  });
}

function trackDir(track: ImageTrack = "gpt-image"): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE, track);
}

async function readStageFile(track: ImageTrack = "gpt-image") {
  return JSON.parse(await readFile(join(trackDir(track), "references.stage.json"), "utf8"));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-stage5-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generateReferences gates", () => {
  it("should refuse to spend until the package carries an approval", async () => {
    await upstream();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain("--stage prompt-package");
  });

  it("should refuse an artifact that belongs to a later stage", async () => {
    await upstream();
    const result = await generate({ artifacts: ["C01"] });

    expect(result.ok ? null : result.error.message).toContain("wyłącznie referencje");
  });

  it("should require an explicit target for a new charge", async () => {
    await upstream();
    const result = await generate({ regenerate: true });

    expect(result.ok ? null : result.error.message).toContain("--regenerate wymaga jawnego celu");
  });

  it("should refuse without a model nobody chose", async () => {
    await upstream();
    await approvePackage();
    const result = await generate({ model: null });

    expect(result.ok ? null : result.error.message).toContain("AIMATOR_IMAGE_MODEL_GPT_IMAGE");
  });
});

describe("generateReferences", () => {
  /**
   * The decision this stage turns on: the gates leave several roots runnable,
   * so one command draws all of them rather than picking one arbitrarily.
   */
  it("should draw every ready reference at once and say how many calls it made", async () => {
    await upstream();
    await approvePackage();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(2);
    expect(result.ok && result.data.paidCalls).toBe(2);
    expect(result.ok ? result.data.artifacts.map((one) => one.id) : null).toEqual(["R01", "R02"]);
  });

  /** R03 depends on R02, and drawing R02 is not the same as accepting it. */
  it("should leave a dependent reference blocked until its input is accepted", async () => {
    await upstream();
    await approvePackage();
    await generate();

    const blocked = await generate({ artifacts: ["R03"] });

    expect(blocked.ok && blocked.data.paidCalls).toBe(0);
    expect(blocked.ok ? blocked.data.artifacts[0]?.state : null).toBe("blocked");
    expect(blocked.ok ? blocked.data.artifacts[0]?.note : "").toContain(
      "nikt go jeszcze nie przyjął"
    );
  });

  it("should draw the dependent reference once its input is accepted", async () => {
    await upstream();
    await approvePackage();
    await generate();
    await accept(["R02"]);

    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(1);
    expect(result.ok ? result.data.artifacts.map((one) => one.id) : null).toEqual(["R03"]);
  });

  it("should publish into the track's own directory", async () => {
    await upstream();
    await approvePackage();
    await generate();

    expect(await readdir(join(trackDir(), "references"))).toEqual(["R01.png", "R02.png"]);
    expect((await readStageFile()).stage).toBe("references");
  });

  /** Rule 1: one state filename, and it is not `references-state.json`. */
  it("should keep every reference in one stage file per track", async () => {
    await upstream();
    await approvePackage();
    await generate();

    const stage = await readStageFile();

    expect(Object.keys(stage.artifacts).sort()).toEqual(["R01", "R02"]);
    expect(await readdir(trackDir())).toContain("references.stage.json");
  });

  it("should carry the approved dependency as an ordered attachment", async () => {
    await upstream();
    await approvePackage();
    await generate();
    await accept(["R02"]);

    const call = recorder();
    await generate({ artifacts: ["R03"], fetch: call.fetch });

    const archived = JSON.parse(
      await readFile(
        join(trackDir(), "runs", (await readStageFile()).artifacts.R03.runId, "request.json"),
        "utf8"
      )
    );

    expect(archived.references).toEqual([
      expect.objectContaining({ name: "R02", position: 1, sha256: sha256Of(REFERENCE) }),
    ]);
    expect(archived.size).toBe("2816x1584");
  });

  /** Rule 4: an archive references its inputs, it never copies their bytes. */
  it("should archive the prompt and the request without the reference bytes", async () => {
    await upstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const runs = join(trackDir(), "runs", (await readStageFile()).artifacts.R01.runId);
    const entries = await readdir(runs);

    expect(entries.sort()).toEqual([
      "prompt.md",
      "request.json",
      "response.json",
      "run.json",
      "transport.json",
      "validation.json",
    ]);
    expect(await readFile(join(runs, "prompt.md"), "utf8")).toContain("REFERENCE INPUTS");
  });

  it("should refuse a published image whose frame is not the film frame", async () => {
    await upstream();
    await approvePackage();
    const wrong = recorder({ image: png(1024, 1024) });
    const result = await generate({ artifacts: ["R01"], fetch: wrong.fetch });

    expect(result.ok ? null : result.error.message).toContain("1024x1024");
    expect((await readStageFile()).artifacts.R01.status).toBe("submitted");
  });

  it("should finish a submitted attempt from the saved response without paying again", async () => {
    await upstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const stage = await readStageFile();
    stage.artifacts.R01 = { ...stage.artifacts.R01, outputs: [], status: "submitted" };
    await writeFile(
      join(trackDir(), "references.stage.json"),
      `${JSON.stringify(stage, null, 2)}\n`,
      "utf8"
    );
    await rm(join(trackDir(), "references", "R01.png"));

    const second = recorder();
    const resumed = await generate({ artifacts: ["R01"], fetch: second.fetch });

    expect(second.calls).toHaveLength(0);
    expect(resumed.ok ? resumed.data.artifacts[0]?.state : resumed.error.message).toBe("resumed");
    expect((await readStageFile()).artifacts.R01.status).toBe("completed");
  });

  it("should keep a finished result until --regenerate names it", async () => {
    await upstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const again = recorder();
    const skipped = await generate({ artifacts: ["R01"], fetch: again.fetch });

    expect(again.calls).toHaveLength(0);
    expect(skipped.ok ? skipped.data.artifacts[0]?.state : null).toBe("skipped");

    const regenerated = recorder();
    await generate({ artifacts: ["R01"], fetch: regenerated.fetch, regenerate: true });

    expect(regenerated.calls).toHaveLength(1);
    expect(
      await readFile(
        join(trackDir(), "runs", (await readStageFile()).artifacts.R01.runId, "previous.png")
      )
    ).toEqual(REFERENCE);
  });

  it("should download what a seedream url points at and publish it", async () => {
    await upstream();
    await approvePackage();
    const call = recorder();
    const result = await generate({
      artifacts: ["R01"],
      fetch: call.fetch,
      model: "dola-seedream-5-0-pro-260628",
      track: "seedream",
    });

    expect(call.calls.map((entry) => entry.url)).toEqual([
      "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
      "https://download/image",
    ]);
    expect(result.ok && result.data.artifacts[0]?.state).toBe("published");
    expect((await readStageFile("seedream")).artifacts.R01.jobId).toBe("job-1");
  });

  /** Rule 2: the two tracks hold identically named files and never meet. */
  it("should not let a reference accepted on one track open the other", async () => {
    await upstream();
    await approvePackage();
    await generate();
    await accept(["R02"]);

    const other = await generate({
      artifacts: ["R03"],
      model: "dola-seedream-5-0-pro-260628",
      track: "seedream",
    });

    expect(other.ok ? other.data.artifacts[0]?.state : null).toBe("blocked");
    expect(other.ok ? other.data.artifacts[0]?.note : "").toContain("seedream");
  });
});

describe("generateReferences --dry-run", () => {
  it("should show the exact prompt, the call count and write nothing", async () => {
    await upstream();
    await approvePackage();
    const before = await readdir(join(root, "projects", PROJECT, "episodes", EPISODE));
    const call = recorder();
    const result = await generate({ apiKey: null, fetch: call.fetch, mode: "dry-run" });

    expect(call.calls).toHaveLength(0);
    expect(result.ok && result.data.paidCalls).toBe(2);
    expect(result.ok ? result.data.artifacts[0]?.prompt : null).toContain("REFERENCE INPUTS");
    expect(await readdir(join(root, "projects", PROJECT, "episodes", EPISODE))).toEqual(before);
  });

  /**
   * A preview that counted a finished result as a purchase would overstate the
   * bill for the one command a person runs precisely to find out what it costs.
   */
  it("should not count a finished reference as a call it would make", async () => {
    await upstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const result = await generate({ apiKey: null, artifacts: ["R01"], mode: "dry-run" });

    expect(result.ok && result.data.paidCalls).toBe(0);
    expect(result.ok ? result.data.artifacts[0]?.state : null).toBe("skipped");
  });

  it("should count it again once --regenerate names it", async () => {
    await upstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const result = await generate({
      apiKey: null,
      artifacts: ["R01"],
      mode: "dry-run",
      regenerate: true,
    });

    expect(result.ok && result.data.paidCalls).toBe(1);
    expect(result.ok ? result.data.artifacts[0]?.state : null).toBe("planned");
  });

  /**
   * A dry run never reads the key, so it must not claim the key is missing.
   * Saying what it did not check is the whole difference between a preview and
   * a lie about a preview.
   */
  it("should say it never looked for the key rather than that the key is absent", async () => {
    await upstream();
    await approvePackage();
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").toContain("nie był czytany");
  });

  it("should report the gate as an obstacle and still show the prompt", async () => {
    await upstream();
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").toContain("--stage prompt-package");
    expect(result.ok ? result.data.artifacts[0]?.prompt : null).toContain("REFERENCE INPUTS");
  });
});

describe("checkReferences and approveReferences", () => {
  it("should report a drawn image as pending until somebody accepts it", async () => {
    await upstream();
    await approvePackage();
    await generate();

    const status = await checkReferences({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok && status.data.approved).toBe(false);
    expect(status.ok ? status.data.artifacts[0]?.state : null).toBe("completed");
    expect(status.ok ? status.data.artifacts[0]?.approved : null).toBe(false);
    expect(status.ok ? status.data.nextStep : "").toContain("--stage references");
  });

  it("should refuse an approval that names nothing", async () => {
    await upstream();
    await approvePackage();
    await generate();

    const result = await accept([]);

    expect(result.ok ? null : result.error.message).toContain("wskaż, co zatwierdzasz");
  });

  it("should refuse to accept something that was never drawn", async () => {
    await upstream();
    await approvePackage();

    const result = await accept(["R01"]);

    expect(result.ok ? null : result.error.message).toContain("nie ma czego zatwierdzić");
  });

  it("should bind an approval to the bytes that were accepted", async () => {
    await upstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });
    await accept(["R01"]);

    await writeFile(join(trackDir(), "references", "R01.png"), png(FRAME.width, FRAME.height + 16));

    const status = await checkReferences({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok ? status.data.artifacts[0]?.approved : null).toBe(false);
    expect(status.ok ? status.data.problems.join("\n") : "").toContain("zmieniony poza narzędziem");
  });

  it("should accept one reference without touching the others", async () => {
    await upstream();
    await approvePackage();
    await generate();
    await accept(["R01"]);

    const stage = await readStageFile();

    expect(stage.artifacts.R01.review.status).toBe("approved");
    expect(stage.artifacts.R02.review.status).toBe("pending");
  });
});
