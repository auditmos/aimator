import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EPISODE, makeHero, makeUpstream, PROJECT, RULES } from "../../test/fixture.js";
import { type imageTracks, resolveWorkspace, type Workspace } from "../workspace.js";
import { type PlannedArtifact, readSendPlan, type SendPlan } from "./index.js";

/**
 * What a model actually receives, composed once and read by two callers: the
 * free `prompt-package show` and the stage that pays.
 *
 * Stages 0 to 4 come from `src/test/fixture`, built through their own entries
 * rather than by writing artifacts. What this file keeps for itself is the
 * manifest: its `answer` grows extra references on demand, because the thing
 * under test here is what happens when a package plans more attachments than a
 * track will carry.
 */

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** A package the validator accepts, as the model would return it. */
function answer(extraReferences = 0): string {
  const extra = Array.from({ length: extraReferences }, (_, index) => ({
    dependsOn: ["R01"],
    id: `R${String(index + 3).padStart(2, "0")}`,
    kind: "prop" as const,
    prompt: `Rekwizyt numer ${index + 3}, odizolowany.`,
    subject: `Rekwizyt ${index + 3}`,
  }));
  const ids = ["R01", "R02", ...extra.map((one) => one.id)];

  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem, Ewa po lewej, tata na kanapie.",
        referenceIds: ["hero:ewa", "hero:tata", ...ids],
      },
      {
        id: "C02",
        prompt: "Oboje na dywanie, alpaka przy policzku Ewy.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
    ],
    entryFrames: [{ clipId: "C02", prompt: "Dokładnie końcowe położenie z C01." }],
    opening: {
      prompt: "Ewa centralnie na bursztynowym tle, cała sylwetka.",
      referenceIds: ["hero:ewa", "R01"],
    },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą i zamkniętym oknem po lewej.",
        subject: "Living room — evening",
      },
      {
        dependsOn: ["hero:tata", "R01"],
        id: "R02",
        kind: "prop",
        prompt: "Pluszowa alpaka, ucho ugięte kontaktem z policzkiem.",
        subject: "Alpaca toy — contact-bent ear",
      },
      ...extra,
    ],
    review: "Do rozstrzygnięcia: skala alpaki przy twarzy taty.",
  });
}

/**
 * Stages 0 to 4. `approvePackage` defaults to accepted here — unlike stage 5's
 * fixture, which leaves it pending — because most of what this module does is
 * only reachable once somebody has accepted the package.
 */
function upstream(
  options: { approvePackage?: boolean; extraReferences?: number } = {}
): Promise<void> {
  return makeUpstream({
    answer: answer(options.extraReferences ?? 0),
    approvePackage: options.approvePackage !== false,
    root,
    scratch,
    workspace,
  });
}

async function plan(
  track: (typeof imageTracks)[number] = "gpt-image",
  targets: readonly string[] = []
): Promise<SendPlan> {
  const result = await readSendPlan({
    episodeId: EPISODE,
    projectId: PROJECT,
    targets,
    track,
    workspace,
  });

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

function artifact(sent: SendPlan, name: string): PlannedArtifact {
  const found = sent.artifacts.find((one) => one.name === name);

  if (found === undefined) {
    throw new Error(`brak artefaktu ${name}`);
  }

  return found;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-compose-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("readSendPlan", () => {
  it("should list every artifact the package plans, in production order", async () => {
    await upstream();
    const sent = await plan();

    expect(sent.artifacts.map((one) => one.name)).toEqual([
      "R01",
      "R02",
      "opening-frame",
      "C01",
      "entry:C02",
      "C02",
    ]);
  });

  it("should compose nothing until an artifact is named", async () => {
    await upstream();
    const sent = await plan();

    expect(sent.artifacts.every((one) => one.text === null)).toBe(true);
  });

  /** Rule 8: the text addresses a position, and the position is generated here. */
  it("should number the attachments in the order the manifest assigned them", async () => {
    await upstream();
    const sent = await plan("gpt-image", ["R02"]);
    const { text } = artifact(sent, "R02");

    expect(text).toContain("REFERENCE INPUTS — IN THIS ORDER");
    expect(text).toContain("Image 1 = hero:tata — the canonical image of Tata");
    expect(text).toContain("Image 2 = R01 — location reference: Living room — evening");
  });

  it("should put the numbered block ahead of the direction that names those ids", async () => {
    await upstream();
    const { text } = artifact(await plan("gpt-image", ["R02"]), "R02");
    const block = text?.indexOf("Image 1 = hero:tata") ?? -1;
    const direction = text?.indexOf("# R02 — Alpaca toy — contact-bent ear") ?? -1;

    expect(block).toBeGreaterThanOrEqual(0);
    expect(direction).toBeGreaterThan(block);
  });

  it("should quote the project rules verbatim at the end", async () => {
    await upstream();
    const { text } = artifact(await plan("gpt-image", ["R01"]), "R01");

    expect(text?.endsWith(RULES)).toBe(true);
  });

  it("should state the film frame derived from the project's aspect ratio", async () => {
    await upstream();
    const sent = await plan("gpt-image", ["R01"]);

    expect(sent.size).toBe("2816x1584");
    expect(artifact(sent, "R01").text).toContain("2816x1584 pixels — the 16:9 film frame");
  });

  it("should draw both tracks in the same frame, so the two results compare", async () => {
    await upstream();

    expect((await plan("seedream")).size).toBe((await plan("gpt-image")).size);
  });

  /** A reference is an asset, not a frame of the film, so it is in no shot. */
  it("should attach no shot-list entries to a reference", async () => {
    await upstream();
    const { text } = artifact(await plan("gpt-image", ["R01"]), "R01");

    expect(text).not.toContain("AUTHORITATIVE SHOTS");
  });

  it("should attach the clip and its shots verbatim to a clip", async () => {
    await upstream();
    const { text } = artifact(await plan("gpt-image", ["C01"]), "C01");

    expect(text).toContain("AUTHORITATIVE SHOTS");
    expect(text).toContain("### C01 | 0-15s");
    expect(text).toContain("### U01 | S01 | C01 | 0-10s");
    expect(text).toContain("### U02 | S02 | C01 | 10-15s");
    expect(text).not.toContain("### U03");
  });

  it("should give an entry frame the references and the shots of its own clip", async () => {
    await upstream();
    const entry = artifact(await plan("gpt-image", ["entry:C02"]), "entry:C02");

    expect(entry.attachments.map((one) => one.id)).toEqual(["hero:ewa", "hero:tata", "R01"]);
    expect(entry.text).toContain("### C02 | 15-30s");
  });

  /** Rule 2, at the last possible moment: one manifest, two sets of files. */
  it("should resolve the same identifiers to a different file on each track", async () => {
    await upstream();
    const gpt = artifact(await plan("gpt-image", []), "R02");
    const seed = artifact(await plan("seedream", []), "R02");

    expect(gpt.attachments[0]?.path).toContain("/gpt-image/hero.png");
    expect(seed.attachments[0]?.path).toContain("/seedream/hero.png");
  });

  it("should report a reference that has not been drawn on this track", async () => {
    await upstream();
    const { attachments, blockers } = artifact(await plan("gpt-image"), "R02");

    expect(attachments.find((one) => one.id === "R01")?.state).toBe("absent");
    expect(blockers.join("\n")).toContain("jeszcze nie powstał na torze gpt-image");
  });

  /**
   * The package is shared and its own gate asks both tracks, so the divergence
   * only appears afterwards: one track's acceptance is withdrawn and the other
   * keeps drawing.
   */
  it("should block only the track whose canonical image is no longer accepted", async () => {
    await upstream();
    await makeHero({ approved: false, characterId: "ewa", root, track: "seedream" });

    expect(artifact(await plan("gpt-image"), "R01").blockers).toEqual([]);
    expect(artifact(await plan("seedream"), "R01").blockers.join("\n")).toContain(
      "--stage character --track seedream"
    );
  });

  /**
   * Decision: a set a track cannot carry is refused on that track, not trimmed,
   * and not refused for both by the stricter of the two.
   */
  it("should refuse an over-long reference set on the track that cannot carry it", async () => {
    await upstream({ extraReferences: 9 });
    const seed = artifact(await plan("seedream"), "C01");
    const gpt = artifact(await plan("gpt-image"), "C01");

    expect(seed.attachments.length).toBe(13);
    expect(seed.blockers.join("\n")).toContain("tor seedream przyjmuje najwyżej 10");
    expect(gpt.blockers.join("\n")).not.toContain("przyjmuje najwyżej");
  });

  it("should report an unapproved package as a plan-level obstacle", async () => {
    await upstream({ approvePackage: false });
    const sent = await plan();

    expect(sent.problems.join("\n")).toContain("--stage prompt-package");
  });

  it("should still compose the prompt while the package is unapproved", async () => {
    await upstream({ approvePackage: false });
    const { text } = artifact(await plan("gpt-image", ["R01"]), "R01");

    expect(text).toContain("REFERENCE INPUTS");
  });

  it("should record what one call consumes, with a digest for each file", async () => {
    await upstream();
    const { inputs } = artifact(await plan("gpt-image", ["R01"]), "R01");
    const paths = inputs.map((one) => one.path);

    expect(paths).toContain(`projects/${PROJECT}/project.md`);
    expect(paths).toContain(`projects/${PROJECT}/episodes/${EPISODE}/prompt-package.json`);
    expect(paths).toContain(`projects/${PROJECT}/episodes/${EPISODE}/prompts/references/R01.md`);
    expect(paths).toContain(`projects/${PROJECT}/characters/ewa/gpt-image/hero.png`);
    expect(inputs.every((one) => one.sha256.length === 64)).toBe(true);
  });

  /** A reference quotes no shots, so it must not claim the shot list as input. */
  it("should record the shot list only where the prompt actually quotes it", async () => {
    await upstream();
    const sent = await plan("gpt-image", []);
    const shotListPath = `projects/${PROJECT}/episodes/${EPISODE}/shot-list.md`;

    expect(artifact(sent, "R01").inputs.map((one) => one.path)).not.toContain(shotListPath);
    expect(artifact(sent, "C01").inputs.map((one) => one.path)).toContain(shotListPath);
  });

  it("should refuse a name this package does not plan", async () => {
    await upstream();
    const result = await readSendPlan({
      episodeId: EPISODE,
      projectId: PROJECT,
      targets: ["R09"],
      track: "gpt-image",
      workspace,
    });

    expect(result.ok ? null : result.error.message).toContain("R01, R02, opening-frame");
  });
});
