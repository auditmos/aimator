import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateReferences } from "../lib/references/index.js";
import { resolveWorkspace, type Workspace } from "../lib/workspace.js";
import { API_KEY, EPISODE, makeTrack, makeUpstream, PROJECT, recorder } from "../test/fixture.js";
import { run } from "./index.js";

/**
 * `reject`: a "no" with a reason, written where `approve` writes a "yes".
 *
 * Assumptions: the record gets `review.status: "rejected"`, the note verbatim,
 * the reviewer and the moment; a rejected artifact is as unapproved as a
 * pending one to every gate; the note is what the next `--regenerate` corrects
 * by unless `--instruction` says otherwise. Not tested here: the UI.
 */

vi.mock("../lib/env.js", () => ({ env: {} }));

const TRACK = "gpt-image";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** Two references drawn from the cast alone, so both exist without a yes. */
function answer(): string {
  return JSON.stringify({
    clips: ["C01", "C02"].map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: [{ clipId: "C02", prompt: "Pierwsza chwila klipu C02." }],
    opening: {
      prompt: "Ewa centralnie, burza za oknem.",
      referenceIds: ["hero:ewa", "R01", "R02"],
    },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
      {
        dependsOn: ["hero:ewa"],
        id: "R02",
        kind: "prop",
        prompt: "Pluszowa Chmurka w dłoni Ewy.",
        subject: "Plush cloud in Ewa's hand",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/** The manifest a finished track is built from: everything waits on R01 alone. */
function chainAnswer(): string {
  return JSON.stringify({
    ...JSON.parse(answer()),
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: JSON.parse(answer()).references.slice(0, 1),
  });
}

function reject(...flags: readonly string[]) {
  return run(["reject", PROJECT, EPISODE, ...flags, "--workspace", root]);
}

/** The free preview of redrawing R02, as a person reads it. */
async function regenerateR02(...flags: readonly string[]): Promise<string> {
  const result = await run([
    "reference",
    "generate",
    PROJECT,
    EPISODE,
    "--track",
    TRACK,
    "--artifact",
    "R02",
    "--regenerate",
    "--model",
    "gpt-image-2.5-sunburst",
    "--dry-run",
    ...flags,
    "--workspace",
    root,
  ]);

  return result.ok ? result.data : result.error.message;
}

async function referenceRecord(id: string): Promise<{
  readonly review: {
    readonly failed?: readonly string[];
    readonly note: string | null;
    readonly reviewedAt: string | null;
    readonly reviewer: string | null;
    readonly status: string;
  };
}> {
  const path = join(root, "projects", PROJECT, "episodes", EPISODE, TRACK, "references.stage.json");

  return JSON.parse(await readFile(path, "utf8")).artifacts[id];
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-reject-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  await generateReferences({
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track: TRACK,
    workspace,
  });
}, 120_000);

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("reject", () => {
  it("should record a no with its reason, who said it and when", async () => {
    const result = await reject(
      "--stage",
      "references",
      "--track",
      TRACK,
      "--artifact",
      "R02",
      "--note",
      "brak ręki Chmurki",
      "--reviewer",
      "qc"
    );

    expect(result.ok ? null : result.error.message).toBeNull();

    const { review } = await referenceRecord("R02");

    expect(review).toMatchObject({ note: "brak ręki Chmurki", reviewer: "qc", status: "rejected" });
    expect(Number.isNaN(Date.parse(review.reviewedAt ?? ""))).toBe(false);
  });

  it("should refuse a no without --note as a usage error", async () => {
    const result = await reject("--stage", "references", "--track", TRACK, "--artifact", "R02");

    expect(result.ok ? null : result.error).toMatchObject({ name: "UsageError" });
    expect(result.ok ? null : result.error.message).toContain("--note");
  });

  it("should print the stage's own object under --json, with command and stage", async () => {
    const result = await reject(
      "--stage",
      "references",
      "--track",
      TRACK,
      "--artifact",
      "R02",
      "--note",
      "za ciemno",
      "--json"
    );
    const check = await run([
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "references",
      "--track",
      TRACK,
      "--json",
      "--workspace",
      root,
    ]);
    const { command: _, ...stage } = JSON.parse(check.ok ? check.data : "{}");

    expect(JSON.parse(result.ok ? result.data : "{}")).toEqual({ ...stage, command: "reject" });
  });

  it.each([
    ["on a reference, which has no checklist", "anatomy", "--fail"],
    ["outside the vocabulary", "colour", '"colour"'],
  ])("should refuse --fail %s", async (_case, fail, named) => {
    const result = await reject(
      "--stage",
      "references",
      "--track",
      TRACK,
      "--artifact",
      "R02",
      "--note",
      "nie",
      "--fail",
      fail
    );

    expect(result.ok ? null : result.error.message).toContain(named);
  });

  /**
   * The point of writing the reason down: the next attempt corrects by it.
   * Assumptions: without `--instruction`, a rejected artifact's note travels as
   * the edit-mode note, previous image first; the preview says where it came
   * from; an explicit `--instruction` wins over it.
   */
  it("should correct a rejected reference by its note, and say so", async () => {
    await reject(
      "--stage",
      "references",
      "--track",
      TRACK,
      "--artifact",
      "R02",
      "--note",
      "brak ręki Chmurki"
    );
    const preview = await regenerateR02();

    expect(preview).toContain("Image 1 = previous:R02");
    expect(preview).toContain("----- BEGIN NOTE -----\nbrak ręki Chmurki\n----- END NOTE -----");
    expect(preview).toContain("uwaga z odrzucenia R02 (review.note)");
  });

  it("should let an explicit --instruction win over the rejection's note", async () => {
    await reject(
      "--stage",
      "references",
      "--track",
      TRACK,
      "--artifact",
      "R02",
      "--note",
      "brak ręki Chmurki"
    );
    const preview = await regenerateR02("--instruction", "zostaw noc");

    expect(preview).toContain("----- BEGIN NOTE -----\nzostaw noc\n----- END NOTE -----");
    expect(preview).not.toContain("brak ręki Chmurki");
    expect(preview).toContain("uwaga z --instruction");
  });

  it("should refuse to send one rejection's note to several references", async () => {
    await reject("--stage", "references", "--track", TRACK, "--artifact", "R02", "--note", "nie");
    const result = await run([
      "reference",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--artifact",
      "R01,R02",
      "--regenerate",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--workspace",
      root,
    ]);

    expect(result.ok ? null : result.error.message).toContain(
      "uwaga z odrzucenia ma jednego adresata"
    );
  });

  it("should let approve change its mind after a reject", async () => {
    await reject("--stage", "references", "--track", TRACK, "--artifact", "R02", "--note", "nie");
    const approved = await run([
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "references",
      "--track",
      TRACK,
      "--artifact",
      "R02",
      "--reviewer",
      "rethink",
      "--workspace",
      root,
    ]);

    expect(approved.ok ? null : approved.error.message).toBeNull();
    expect((await referenceRecord("R02")).review).toMatchObject({
      note: null,
      reviewer: "rethink",
      status: "approved",
    });
  });
});

/**
 * The same scopes `approve` takes: an episode, a character, a track, one
 * artifact implied when the stage has only one. Stage 0 is the exception,
 * because its records are a person's own decisions rather than anything made
 * for them.
 */
describe("reject, across the scopes approve takes", () => {
  const EPISODE_DIR = () => join(root, "projects", PROJECT, "episodes", EPISODE);

  it.each([
    ["screenplay", [], () => join(EPISODE_DIR(), "screenplay.stage.json"), "screenplay"],
    ["shot-list", [], () => join(EPISODE_DIR(), "shot-list.stage.json"), "shot-list"],
    [
      "character",
      ["--track", TRACK, "--artifact", "hero"],
      () => join(root, "projects", PROJECT, "characters", "ewa", TRACK, "character.stage.json"),
      "hero",
    ],
  ] as const)(
    "should reject --stage %s where approve would accept it",
    async (stage, flags, file, key) => {
      const scope = stage === "character" ? "ewa" : EPISODE;
      const result = await run([
        "reject",
        PROJECT,
        scope,
        "--stage",
        stage,
        ...flags,
        "--note",
        `nie ${stage}`,
        "--workspace",
        root,
      ]);

      expect(result.ok ? null : result.error.message).toBeNull();

      const record = JSON.parse(await readFile(file(), "utf8")).artifacts[key];

      expect(record.review).toMatchObject({ note: `nie ${stage}`, status: "rejected" });
    }
  );

  /** Text stages correct by it too: the mechanism is `lib/text-model`'s, so one stage proves the five. */
  it("should correct a rejected screenplay by its note in the preview", async () => {
    await run([
      "reject",
      PROJECT,
      EPISODE,
      "--stage",
      "screenplay",
      "--note",
      "skróć dialog w S03",
      "--workspace",
      root,
    ]);
    const preview = await run([
      "screenplay",
      "generate",
      PROJECT,
      EPISODE,
      "--regenerate",
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--workspace",
      root,
    ]);
    const text = preview.ok ? preview.data : preview.error.message;

    expect(text).toContain("----- BEGIN NOTE -----\nskróć dialog w S03\n----- END NOTE -----");
    expect(text).toContain("uwaga z odrzucenia screenplay (review.note)");
  });

  /**
   * The fixture's hero is forged with no views behind it, so the gate keeps its
   * prompt from being composed; what the preview can still say is which note
   * the attempt would carry. `lib/character` proves the note reaches the card.
   */
  it("should say a rejected character image would be corrected by its note", async () => {
    await run([
      "reject",
      PROJECT,
      "ewa",
      "--stage",
      "character",
      "--track",
      TRACK,
      "--artifact",
      "hero",
      "--note",
      "uszy za duże",
      "--workspace",
      root,
    ]);
    const preview = await run([
      "character",
      "generate",
      PROJECT,
      "ewa",
      "--track",
      TRACK,
      "--artifact",
      "hero",
      "--regenerate",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--workspace",
      root,
    ]);
    const text = preview.ok ? preview.data : preview.error.message;

    expect(text).toContain("uwaga z odrzucenia hero (review.note)");
  });

  it("should refuse stage 0 and name the stages it takes", async () => {
    const result = await reject("--stage", "prepare", "--note", "nie");

    expect(result.ok ? null : result.error.message).toContain("dozwolone: assembly, character");
  });

  it("should refuse an artifact the stage file does not hold", async () => {
    const result = await reject(
      "--stage",
      "references",
      "--track",
      TRACK,
      "--artifact",
      "R09",
      "--note",
      "nie"
    );

    expect(result.ok ? null : result.error.message).toContain("nie ma czego odrzucić: R09");
  });
});

/**
 * Stage 7's chain, finished and accepted, so a no lands on something a gate
 * already relied on. Assumptions: `--fail` names criteria of the QC checklist
 * and only a frame with one (the opening frame, an entry frame) takes it; the
 * gate on the clip an entry frame starts treats the no as no yes.
 */
describe("reject --stage clips", () => {
  let chain = "";

  beforeAll(async () => {
    chain = await mkdtemp(join(tmpdir(), "aimator-reject-chain-"));
    const sources = await mkdtemp(join(tmpdir(), "aimator-reject-chain-src-"));
    const resolved = resolveWorkspace(chain);

    if (!resolved.ok) {
      throw resolved.error;
    }

    await makeUpstream({
      answer: chainAnswer(),
      approvePackage: true,
      root: chain,
      scratch: sources,
      workspace: resolved.data,
    });
    await makeTrack({ root: chain, track: TRACK, workspace: resolved.data });
    await rm(sources, { force: true, recursive: true });
  }, 120_000);

  afterAll(async () => {
    await rm(chain, { force: true, recursive: true });
  });

  function inChain(...argv: readonly string[]) {
    return run([...argv, "--workspace", chain]);
  }

  async function clipRecord(id: string): Promise<{ readonly review: { failed?: string[] } }> {
    const path = join(chain, "projects", PROJECT, "episodes", EPISODE, TRACK, "clips.stage.json");

    return JSON.parse(await readFile(path, "utf8")).artifacts[id];
  }

  it("should record the failed criteria of an entry frame", async () => {
    const result = await inChain(
      "reject",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      TRACK,
      "--artifact",
      "entry:C02",
      "--note",
      "brak ręki Chmurki",
      "--fail",
      "anatomy,props"
    );

    expect(result.ok ? null : result.error.message).toBeNull();
    expect((await clipRecord("entry:C02")).review.failed).toEqual(["anatomy", "props"]);
  });

  it("should refuse --fail on a clip, which has no checklist", async () => {
    const result = await inChain(
      "reject",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      TRACK,
      "--artifact",
      "C01",
      "--note",
      "za szybko",
      "--fail",
      "anatomy"
    );

    expect(result.ok ? null : result.error.message).toContain("C01");
  });

  it("should close the gate on the clip a rejected entry frame starts", async () => {
    await inChain(
      "reject",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      TRACK,
      "--artifact",
      "entry:C02",
      "--note",
      "kadr ucięty"
    );
    const result = await inChain(
      "clip",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--artifact",
      "C02",
      "--regenerate",
      "--image-model",
      "gpt-image-2.5-sunburst",
      "--video-model",
      "dreamina-seedance-2-5-260628",
      "--dry-run",
      "--json"
    );
    const report = JSON.parse(result.ok ? result.data : "{}") as {
      artifacts: readonly { readonly note: string; readonly state: string }[];
      paidVideos: number;
    };

    expect(report.paidVideos).toBe(0);
    expect(report.artifacts[0]?.note).toContain("entry:C02");
  });

  /** The free preview of buying one named link of the chain again. */
  async function regenerateClip(artifact: string): Promise<string> {
    const result = await inChain(
      "clip",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--artifact",
      artifact,
      "--regenerate",
      "--image-model",
      "gpt-image-2.5-sunburst",
      "--video-model",
      "dreamina-seedance-2-5-260628",
      "--dry-run"
    );

    return result.ok ? result.data : result.error.message;
  }

  it("should correct a rejected entry frame by its note and failed criteria", async () => {
    await inChain(
      "reject",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      TRACK,
      "--artifact",
      "entry:C02",
      "--note",
      "brak ręki Chmurki",
      "--fail",
      "anatomy"
    );
    const preview = await regenerateClip("entry:C02");

    expect(preview).toContain("Image 1 = previous:entry:C02");
    expect(preview).toContain(
      "----- BEGIN NOTE -----\nbrak ręki Chmurki\n\nFailed QC criteria: anatomy\n----- END NOTE -----"
    );
    expect(preview).toContain("uwaga z odrzucenia entry:C02 (review.note)");
  });

  it("should render a rejected clip again with its note, as a new generation", async () => {
    await inChain(
      "reject",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      TRACK,
      "--artifact",
      "C01",
      "--note",
      "Wanda ma zostać w łóżku"
    );
    const preview = await regenerateClip("C01");

    expect(preview).toContain(
      "----- BEGIN NOTE -----\nWanda ma zostać w łóżku\n----- END NOTE -----"
    );
    expect(preview).toContain("uwaga z odrzucenia C01 (review.note)");
  });

  it("should reject the one opening frame without --artifact, with its failed criteria", async () => {
    const result = await inChain(
      "reject",
      PROJECT,
      EPISODE,
      "--stage",
      "opening-frame",
      "--track",
      TRACK,
      "--note",
      "paleta poza Style Bible",
      "--fail",
      "style"
    );
    const path = join(
      chain,
      "projects",
      PROJECT,
      "episodes",
      EPISODE,
      TRACK,
      "opening-frame.stage.json"
    );
    const record = JSON.parse(await readFile(path, "utf8")).artifacts["opening-frame"];

    expect(result.ok ? null : result.error.message).toBeNull();
    expect(record.review).toMatchObject({ failed: ["style"], status: "rejected" });

    const preview = await inChain(
      "opening-frame",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--regenerate",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run"
    );
    const text = preview.ok ? preview.data : preview.error.message;

    expect(text).toContain("Image 1 = previous:opening-frame");
    expect(text).toContain("paleta poza Style Bible\n\nFailed QC criteria: style");
    expect(text).toContain("uwaga z odrzucenia opening-frame (review.note)");
  });

  /**
   * `status` keeps five states: a rejected result is one waiting for a person,
   * like any unaccepted one, and the cell says why rather than growing a sixth.
   */
  it("should show a rejected cell as waiting for review, with the reason", async () => {
    const result = await inChain("status", PROJECT, EPISODE, "--json");
    const { cells } = JSON.parse(result.ok ? result.data : "{}") as {
      cells: readonly { id: string; reason: string | null; state: string }[];
    };
    const opening = cells.find((cell) => cell.id === `6/${TRACK}`);

    expect(opening).toMatchObject({
      reason: "odrzucone: paleta poza Style Bible",
      state: "review",
    });
  });
});
