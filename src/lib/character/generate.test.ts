import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCharacter,
  addEpisode,
  approveStage0,
  initProject,
  setCharacterBasis,
  setEpisodeSettings,
} from "../project/index.js";
import { type ImageTrack, resolveWorkspace, type Workspace } from "../workspace.js";
import {
  approveCharacter,
  CHARACTER_VIEWS,
  type CharacterArtifact,
  checkCharacter,
  generateCharacter,
} from "./index.js";

const PROJECT = "dzielna-ewa";
const CHARACTER = "ewa";

let root = "";
let workspace: Workspace = { root: "" };

/** A PNG as far as the validator reads one, at the size the request asked for. */
function png(width: number, height: number, colorType = 6): Buffer {
  const head = Buffer.alloc(26);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(colorType, 25);

  const tail = Buffer.alloc(12);
  tail.write("IEND", 4, "ascii");

  return Buffer.concat([head, Buffer.alloc(64), tail]);
}

const CARD = png(1920, 1920, 2);
const VIEW = png(1536, 1536);
const HERO = png(1536, 2304, 2);

function imageFor(artifact: CharacterArtifact): Buffer {
  if (artifact === "card") {
    return CARD;
  }

  return artifact === "hero" ? HERO : VIEW;
}

interface Recorder {
  readonly calls: { body: unknown; url: string }[];
  readonly fetch: typeof fetch;
}

/**
 * A provider that answers correctly, counting every request. The count is the
 * assertion that matters most here: this stage bills per call, so "did it send
 * one" and "did it send another" are the questions the tests exist to answer.
 */
function recorder(options: { readonly order?: readonly CharacterArtifact[] } = {}): Recorder {
  const calls: { body: unknown; url: string }[] = [];
  let index = 0;
  const order = options.order ?? [];

  const impl = ((url: string | URL, init?: RequestInit) => {
    const href = String(url);

    if (href.startsWith("https://download/")) {
      calls.push({ body: null, url: href });
      const downloaded = href.slice("https://download/".length) as CharacterArtifact;

      return Promise.resolve(new Response(imageFor(downloaded), { status: 200 }));
    }

    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ body, url: href });

    const artifact = order[index] ?? "card";

    index += 1;

    return Promise.resolve(
      href.includes("bytepluses.com")
        ? Response.json({ data: [{ url: `https://download/${artifact}` }], id: "job-1" })
        : Response.json({ data: [{ b64_json: imageFor(artifact).toString("base64") }] })
    );
  }) as unknown as typeof fetch;

  return { calls, fetch: impl };
}

function generate(overrides: Partial<Parameters<typeof generateCharacter>[0]> = {}) {
  return generateCharacter({
    apiKey: "sk-test",
    artifacts: [],
    characterId: CHARACTER,
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

async function makeStage0(approve = true): Promise<void> {
  await initProject({
    aspectRatio: "16:9",
    mode: "apply",
    projectId: PROJECT,
    title: "Dzielna Ewa",
    workspace,
  });
  await addCharacter({
    characterId: CHARACTER,
    mode: "apply",
    name: "Ewa",
    projectId: PROJECT,
    workspace,
  });
  await setCharacterBasis({
    basis: "description",
    characterId: CHARACTER,
    mode: "apply",
    projectId: PROJECT,
    workspace,
  });
  await writeFile(
    join(root, "projects", PROJECT, "project.md"),
    "# Ewa\n\nPłaskie 2D wektorowe. Kropki-oczy.\n",
    "utf8"
  );

  // Stage 0 is approved project-wide, and a project with no episode is not a
  // finished stage 0 — even though stage 2 itself never reads an episode.
  const source = join(root, "01-Burza.md");
  await writeFile(source, "# Burza\n\nEwa boi się burzy.\n", "utf8");
  await addEpisode({
    mode: "apply",
    projectId: PROJECT,
    settings: {},
    sourcePath: source,
    workspace,
  });
  await setEpisodeSettings({
    episodeId: "01-burza",
    mode: "apply",
    projectId: PROJECT,
    settings: {
      audio: "narration",
      durationSeconds: 30,
      language: "pl",
      sourceNature: "law-or-idea",
      subtitles: "none",
    },
    workspace,
  });

  if (approve) {
    await approveStage0({
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "tester",
      workspace,
    });
  }
}

async function accept(artifacts: readonly CharacterArtifact[], track: ImageTrack = "gpt-image") {
  return await approveCharacter({
    artifacts,
    characterId: CHARACTER,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track,
    workspace,
  });
}

function stagePath(track: ImageTrack = "gpt-image"): string {
  return join(root, "projects", PROJECT, "characters", CHARACTER, track, "character.stage.json");
}

async function readStageFile(track: ImageTrack = "gpt-image") {
  return JSON.parse(await readFile(stagePath(track), "utf8"));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-char-"));
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("generateCharacter --dry-run", () => {
  it("should show the exact prompt and write nothing", async () => {
    await makeStage0();
    const before = await readdir(join(root, "projects", PROJECT));
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok && result.data.artifacts[0]?.artifact).toBe("card");
    expect(result.ok && result.data.artifacts[0]?.prompt).toContain("3 × 3");
    expect(result.ok && result.data.ready).toBe(true);
    expect(await readdir(join(root, "projects", PROJECT))).toEqual(before);
  });

  /**
   * A dry run never reads the key, so it must not claim the key is missing.
   * Saying what it did not check is the whole difference between a preview and
   * a lie about a preview.
   */
  it("should say it never looked for the key rather than that the key is absent", async () => {
    await makeStage0();
    const result = await generate({ apiKey: null, mode: "dry-run" });
    const problems = result.ok ? result.data.problems.join(" ") : "";

    expect(problems).toContain("nie był czytany");
    expect(problems).not.toContain("brak OPENAI_API_KEY");
  });

  it("should report an unapproved stage 0 as an obstacle and still show the prompt", async () => {
    await makeStage0(false);
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok && result.data.ready).toBe(false);
    expect(result.ok ? result.data.problems.join(" ") : "").toContain('review.status = "approved"');
    expect(result.ok && result.data.artifacts[0]?.prompt).not.toBeNull();
  });

  it("should carry the character's name and the whole project rules into the prompt", async () => {
    await makeStage0();
    const result = await generate({ apiKey: null, mode: "dry-run" });
    const prompt = result.ok ? (result.data.artifacts[0]?.prompt ?? "") : "";

    expect(prompt).toContain("Draw Ewa, and only Ewa");
    expect(prompt).toContain("Płaskie 2D wektorowe");
  });
});

describe("generateCharacter gates", () => {
  it("should refuse a paid call while stage 0 is unapproved", async () => {
    await makeStage0(false);
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(result.ok).toBe(false);
    expect(call.calls).toHaveLength(0);
  });

  it("should draw the card first and nothing else", async () => {
    await makeStage0();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(1);
    expect(result.ok && result.data.artifacts.map((a) => a.artifact)).toEqual(["card"]);
  });

  it("should hold the eight views until a human accepts the card", async () => {
    await makeStage0();
    const call = recorder();
    await generate({ fetch: call.fetch });

    const blocked = await generate({ artifacts: ["front"], fetch: call.fetch });

    expect(call.calls).toHaveLength(1);
    expect(blocked.ok && blocked.data.artifacts[0]?.state).toBe("blocked");
    expect(blocked.ok ? blocked.data.problems.join(" ") : "").toContain("zatwierdzenie karty");
  });

  it("should draw all eight views once the card is accepted", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });
    await accept(["card"]);

    const call = recorder({ order: CHARACTER_VIEWS });
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(8);
    expect(result.ok && result.data.artifacts.map((a) => a.artifact)).toEqual([...CHARACTER_VIEWS]);
  });

  it("should hold the hero until every view is accepted", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });
    await accept(["card"]);
    await generate({ fetch: recorder({ order: CHARACTER_VIEWS }).fetch });
    await accept(CHARACTER_VIEWS.slice(0, 7));

    const call = recorder();
    const result = await generate({ artifacts: ["hero"], fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? result.data.problems.join(" ") : "").toContain("rear");
  });
});

describe("generateCharacter provenance", () => {
  it("should record the result as pending review, never as accepted", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const stage = await readStageFile();
    expect(stage.stage).toBe("character");
    expect(stage.artifacts.card.status).toBe("completed");
    expect(stage.artifacts.card.review.status).toBe("pending");
    expect(stage.artifacts.card.producer.promptVersion).toBe(1);
  });

  /**
   * The run archive never copies an input. For an image stage that is not only
   * a rule: a seedream hero carries ten base64 PNGs, and an archive that kept
   * them would write tens of megabytes per attempt for files already on disk.
   */
  it("should archive the request without any image bytes", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const stage = await readStageFile();
    const runs = join(
      root,
      "projects",
      PROJECT,
      "characters",
      CHARACTER,
      "gpt-image",
      "runs",
      stage.artifacts.card.runId
    );
    const request = JSON.parse(await readFile(join(runs, "request.json"), "utf8"));

    expect(JSON.stringify(request)).not.toContain("base64");
    expect(request.references).toEqual([]);
    expect(await readFile(join(runs, "prompt.md"), "utf8")).toContain("3 × 3");
  });

  it("should write submitted before the post, so an interrupted attempt is visible", async () => {
    await makeStage0();
    const failing = (() => Promise.reject(new Error("sieć padła"))) as unknown as typeof fetch;

    const result = await generate({ fetch: failing });

    expect(result.ok).toBe(false);
    const stage = await readStageFile();
    expect(stage.artifacts.card.status).toBe("submitted");
    expect(stage.artifacts.card.outputs).toEqual([]);
  });

  it("should do nothing more until the result is reviewed", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const call = recorder();
    const again = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(again.ok && again.data.artifacts).toEqual([]);
    expect(again.ok ? again.data.problems.join(" ") : "").toContain("czekają na ocenę");
  });

  it("should refuse to start a second paid attempt over a finished one", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const call = recorder();
    const again = await generate({ artifacts: ["card"], fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(again.ok && again.data.artifacts[0]?.state).toBe("skipped");
    expect(again.ok ? again.data.artifacts[0]?.note : "").toContain("--regenerate");
  });

  it("should refuse a bare --regenerate, because a new charge names its target", async () => {
    await makeStage0();
    const call = recorder();
    const result = await generate({ fetch: call.fetch, regenerate: true });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain("--artifact");
  });

  it("should keep the previous image in the archive when --regenerate replaces it", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const call = recorder();
    await generate({ artifacts: ["card"], fetch: call.fetch, regenerate: true });

    const stage = await readStageFile();
    const runs = join(
      root,
      "projects",
      PROJECT,
      "characters",
      CHARACTER,
      "gpt-image",
      "runs",
      stage.artifacts.card.runId
    );

    expect(call.calls).toHaveLength(1);
    expect(await readFile(join(runs, "previous.png"))).toEqual(CARD);
  });
});

describe("generateCharacter resume", () => {
  /**
   * An answer that reached disk is bought and paid for. Re-deriving a result
   * from it must cost nothing, or a bug in the validator becomes billable.
   */
  it("should finish a submitted attempt from the saved response without paying again", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    // Exactly the state a crash between the POST and publication leaves: the
    // response is archived, the stage file still says submitted, nothing is
    // published. Reconstructed rather than mocked, because the moment the
    // process dies is not something a fake `fetch` can place.
    const stage = await readStageFile();
    const dir = join(root, "projects", PROJECT, "characters", CHARACTER, "gpt-image");
    stage.artifacts.card = { ...stage.artifacts.card, outputs: [], status: "submitted" };
    await writeFile(stagePath(), `${JSON.stringify(stage, null, 2)}\n`, "utf8");
    await rm(join(dir, "card.png"));

    const second = recorder();
    const resumed = await generate({ fetch: second.fetch });

    expect(second.calls).toHaveLength(0);
    expect(resumed.ok && resumed.data.artifacts[0]?.state).toBe("resumed");
    expect(resumed.ok ? resumed.data.artifacts[0]?.note : "").toContain("bez drugiej opłaty");
    expect((await readStageFile()).artifacts.card.status).toBe("completed");
  });
});

describe("generateCharacter seedream", () => {
  it("should download the image the url points at and publish it", async () => {
    await makeStage0();
    const call = recorder();
    const result = await generate({
      fetch: call.fetch,
      model: "dola-seedream-5-0-pro-260628",
      track: "seedream",
    });

    expect(call.calls.map((entry) => entry.url)).toEqual([
      "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
      "https://download/card",
    ]);
    expect(result.ok && result.data.artifacts[0]?.state).toBe("published");
    expect((await readStageFile("seedream")).artifacts.card.jobId).toBe("job-1");
  });

  /**
   * seedream has no background switch, so a view's transparency is asked for
   * in the prompt and can simply not arrive. The image is already paid for, so
   * the missing channel is named for the reviewer rather than thrown away.
   */
  it("should publish a view with no alpha channel and say so", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch, model: "seedream-pro", track: "seedream" });
    await accept(["card"], "seedream");

    const opaque = png(1536, 1536, 2);
    const flat = ((url: string | URL) =>
      Promise.resolve(
        String(url).startsWith("https://download/")
          ? new Response(opaque, { status: 200 })
          : Response.json({ data: [{ url: "https://download/front" }], id: "job-2" })
      )) as unknown as typeof fetch;

    const result = await generate({
      artifacts: ["front"],
      fetch: flat,
      model: "seedream-pro",
      track: "seedream",
    });

    expect(result.ok && result.data.artifacts[0]?.state).toBe("published");
    expect(result.ok ? result.data.artifacts[0]?.note : "").toContain("bez kanału alfa");
    expect(result.ok && result.data.artifacts[0]?.verdict?.alpha).toBe(false);
  });

  it("should reject an image whose dimensions the request never asked for", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });
    await accept(["card"]);

    const result = await generate({
      artifacts: ["front"],
      fetch: recorder({ order: ["card"] }).fetch,
    });

    expect(result.ok ? null : result.error.message).toContain("1920x1920");
  });
});

describe("approveCharacter", () => {
  it("should refuse without an explicit artifact", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const result = await accept([]);
    expect(result.ok ? null : result.error.message).toContain("--artifact");
  });

  it("should bind the approval to the bytes that were verified", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });
    expect((await accept(["card"])).ok).toBe(true);

    const cardPath = join(
      root,
      "projects",
      PROJECT,
      "characters",
      CHARACTER,
      "gpt-image",
      "card.png"
    );
    await writeFile(cardPath, png(1920, 1920, 4));

    const status = await checkCharacter({
      characterId: CHARACTER,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok && status.data.approved).toBe(false);
    expect(status.ok ? status.data.problems.join(" ") : "").toContain("zmieniony poza narzędziem");
  });

  it("should leave the other nine artifacts untouched", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });
    await accept(["card"]);

    const stage = await readStageFile();
    expect(stage.artifacts.card.review.status).toBe("approved");
    expect(stage.artifacts.card.review.reviewer).toBe("tester");
    expect(Object.keys(stage.artifacts)).toEqual(["card"]);
  });

  it("should refuse to approve something that never finished", async () => {
    await makeStage0();
    const result = await accept(["card"]);

    expect(result.ok ? null : result.error.message).toContain("nie ma czego zatwierdzić");
  });
});

describe("checkCharacter", () => {
  it("should write nothing", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });
    const before = await readFile(stagePath(), "utf8");

    await checkCharacter({
      characterId: CHARACTER,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(await readFile(stagePath(), "utf8")).toBe(before);
  });

  it("should report each of the ten separately", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const status = await checkCharacter({
      characterId: CHARACTER,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok && status.data.artifacts).toHaveLength(10);
    expect(status.ok && status.data.artifacts[0]?.state).toBe("completed");
    expect(status.ok && status.data.artifacts[1]?.state).toBe("absent");
    expect(status.ok ? status.data.nextStep : "").toContain("--artifact card");
  });

  it("should keep the two tracks independent", async () => {
    await makeStage0();
    await generate({ fetch: recorder().fetch });

    const seedream = await checkCharacter({
      characterId: CHARACTER,
      projectId: PROJECT,
      track: "seedream",
      workspace,
    });

    expect(seedream.ok && seedream.data.artifacts.every((entry) => entry.state === "absent")).toBe(
      true
    );
  });
});

describe("generateCharacter refusals", () => {
  function rejecting(status: number, body: unknown): typeof fetch {
    return (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status,
        })
      )) as unknown as typeof fetch;
  }

  async function runDir(): Promise<string> {
    const stage = await readStageFile();

    return join(
      root,
      "projects",
      PROJECT,
      "characters",
      CHARACTER,
      "gpt-image",
      "runs",
      stage.artifacts.card.runId
    );
  }

  /**
   * The diagnostics are the whole value of a refusal. Judging the answer before
   * archiving it threw the body away, which is how a 400 became "check the
   * model, access and balance" and nothing else.
   */
  it("should archive the body of a rejected call before reporting it", async () => {
    await makeStage0();
    const result = await generate({
      fetch: rejecting(400, { error: { code: "model_not_found", message: "no such model" } }),
    });

    expect(result.ok).toBe(false);
    const dir = await runDir();
    const saved = JSON.parse(await readFile(join(dir, "response.json"), "utf8"));
    expect(saved.error.message).toBe("no such model");
    expect(JSON.parse(await readFile(join(dir, "transport.json"), "utf8")).httpStatus).toBe(400);
  });

  it("should put the provider's own words in the error", async () => {
    await makeStage0();
    const result = await generate({
      fetch: rejecting(400, { error: { code: "model_not_found", message: "no such model" } }),
    });

    expect(result.ok ? null : result.error.message).toContain("no such model");
    expect(result.ok ? null : result.error.message).toContain("model_not_found");
  });

  /**
   * A 4xx is the provider declining to do the work, so nothing was charged.
   * Demanding `--regenerate` afterwards would make a rejected request look
   * like a paid one.
   */
  it("should let a plain re-run follow a refusal that cannot have been billed", async () => {
    await makeStage0();
    await generate({ fetch: rejecting(400, { error: { message: "no such model" } }) });

    const call = recorder();
    const again = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(1);
    expect(again.ok && again.data.artifacts[0]?.state).toBe("published");
  });

  it("should keep the --regenerate rule after a status that may have been billed", async () => {
    await makeStage0();
    await generate({ fetch: rejecting(503, { error: { message: "overloaded" } }) });

    const call = recorder();
    const again = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(again.ok ? null : again.error.message).toContain("HTTP 503");
    expect(again.ok ? null : again.error.message).toContain("--regenerate");
  });
});
