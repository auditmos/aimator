import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_KEY, DIALOGUE, EPISODE, makeUpstream, PROJECT } from "../../test/fixture.js";
import { approveShotList } from "../shot-list/index.js";
import {
  type EpisodePaths,
  episodePaths,
  projectPaths,
  resolveWorkspace,
  type Workspace,
} from "../workspace.js";
import { approveDialogue, checkDialogue, generateDialogue } from "./index.js";

/**
 * Stage 11's script, through the module entry.
 *
 * The rule worth more than the rest is stage 9's, made complete: a line is
 * **lifted, never invented, and none is left behind**. Stage 3 wrote every line
 * a character speaks as `<cast-id>: "<line>"`, so the script can be checked in
 * both directions: each of its lines is one of those, and each of those is in
 * it exactly once.
 */

/** One attributed line as stage 3 writes it, with the separator before it. */
const ATTRIBUTED = /; [a-z]+: "[^"]*"/g;
/** Where a refused answer was kept, as the refusal says it. */
const ARCHIVED = /Odpowiedź zachowano w (\S+),/;

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** The manifest the fixture deliberately does not own: two clips, one reference. */
function answer(): string {
  return JSON.stringify({
    clips: ["C01", "C02"].map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: [{ clipId: "C02", prompt: "Pierwsza chwila klipu C02." }],
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
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/** The whole text pipeline, its cast speaking unless a test says otherwise. */
function upstream(dialogue = true): Promise<void> {
  return makeUpstream({
    answer: answer(),
    approvePackage: true,
    dialogue,
    root,
    scratch,
    workspace,
  });
}

/** A script the validator accepts, so each test can break exactly one thing. */
function script(lines: readonly string[]): string {
  return [
    "## Plan",
    "",
    "Ewa pyta dwa razy, tata odpowiada raz.",
    "",
    "## Lines",
    "",
    ...lines,
    "## Review",
    "",
    "Każda kwestia pochodzi z pola Audio swojego ujęcia.",
    "",
  ].join("\n");
}

function line(id: string, shot: string, cast: string, at: string, text: string): string[] {
  return [`### ${id} | ${shot} | ${cast} | ${at}`, "", text, ""];
}

/** Every attributed line of the fixture's plan, once, in order. */
const LIFTED = [
  ...line("D01", "U01", "ewa", "2s", DIALOGUE.U01.text),
  ...line("D02", "U03", "ewa", "16s", DIALOGUE.U03.text),
  ...line("D03", "U04", "tata", "22s", DIALOGUE.U04.text),
];

interface Calls {
  readonly fetch: typeof fetch;
  /** Every text request, as the prompt it carried. */
  readonly text: string[];
}

/** A text provider that answers every request with `answered`. */
function transport(answered = ""): Calls {
  const text: string[] = [];

  return {
    fetch: ((_url: string | URL, init?: RequestInit) => {
      text.push((JSON.parse(String(init?.body ?? "{}")) as { input?: string }).input ?? "");

      return Promise.resolve(
        Response.json({
          id: `resp_${text.length}`,
          output: [
            {
              content: [{ text: answered, type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
        })
      );
    }) as unknown as typeof fetch,
    text,
  };
}

function generate(calls: Calls, overrides: Partial<Parameters<typeof generateDialogue>[0]> = {}) {
  return generateDialogue({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: calls.fetch,
    maxOutputTokens: 8000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    workspace,
    ...overrides,
  });
}

/** Where the episode's files are, which is `workspace.ts`'s business alone. */
function episode(): EpisodePaths {
  const project = projectPaths(workspace, PROJECT);
  const paths = project.ok ? episodePaths(project.data, EPISODE) : null;

  if (!paths?.ok) {
    throw new Error("nie ma ścieżek odcinka");
  }

  return paths.data;
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

describe("generateDialogue", () => {
  it("should preview one paid call and the exact prompt it would send", async () => {
    await upstream();
    const calls = transport();
    const result = await generate(calls, { mode: "dry-run" });

    expect(result.ok ? result.data.problems : result.error.message).toEqual([]);
    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(result.ok ? result.data.prompt : null).toContain(`ewa: "${DIALOGUE.U01.text}"`);
    expect(calls.text).toHaveLength(0);
  });

  /**
   * A hand correction lapses the plan's approval, which is the plainest way to
   * hold an episode whose shot list nobody has accepted in its current form.
   */
  it("should name an unaccepted shot list as the obstacle and buy nothing", async () => {
    await upstream();
    const paths = episode();
    await writeFile(paths.shotList, `${await readFile(paths.shotList, "utf8")}\n`, "utf8");
    const calls = transport();
    const preview = await generate(calls, { mode: "dry-run" });
    const result = await generate(calls);

    expect(preview.ok ? preview.data.paidCalls : null).toBe(0);
    expect(preview.ok ? preview.data.problems.join("\n") : null).toContain("--stage shot-list");
    expect(result.ok ? null : result.error.message).toContain("--stage shot-list");
    expect(calls.text).toHaveLength(0);
  });

  it("should publish the script beside the shot list, pending a human's yes", async () => {
    await upstream();
    const calls = transport(script(LIFTED));
    const result = await generate(calls);
    const stage = JSON.parse(await readFile(episode().dialogueStage, "utf8")) as {
      readonly artifacts: {
        readonly script: { producer: { promptVersion: number }; review: { status: string } };
      };
      readonly stage: string;
    };

    expect(
      result.ok ? result.data.verdict?.lines.map((one) => one.id) : result.error.message
    ).toEqual(["D01", "D02", "D03"]);
    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(await readFile(episode().dialogueScript, "utf8")).toBe(script(LIFTED));
    expect(stage.stage).toBe("dialogue");
    expect(stage.artifacts.script.review.status).toBe("pending");
    expect(stage.artifacts.script.producer.promptVersion).toBe(1);
    expect(calls.text).toHaveLength(1);
  });

  describe("lifted, not invented, nothing left behind", () => {
    /** The message the paid call failed with, after the provider answered `lines`. */
    async function refusal(lines: readonly string[]): Promise<string> {
      await upstream();
      const result = await generate(transport(script(lines)));

      return result.ok ? "" : result.error.message;
    }

    it("should refuse a line the shot does not hold, keeping the answer in the archive", async () => {
      const invented = "Tato, kupisz mi kucyka?";
      const message = await refusal([
        ...line("D01", "U01", "ewa", "2s", invented),
        ...LIFTED.slice(4),
      ]);
      const [, archived = ""] = ARCHIVED.exec(message) ?? [];

      expect(message).toContain("D01: tej kwestii nie ma w ujęciu U01");
      expect(await readFile(join(root, archived), "utf8")).toContain(invented);
      await expect(readFile(episode().dialogueScript, "utf8")).rejects.toThrow();
    });

    it("should refuse a script that leaves an attributed line out, naming the shot and the line", async () => {
      const message = await refusal([
        ...line("D01", "U01", "ewa", "2s", DIALOGUE.U01.text),
        ...line("D02", "U04", "tata", "22s", DIALOGUE.U04.text),
      ]);

      expect(message).toContain(`U03: pominięto kwestię ewa: "${DIALOGUE.U03.text}"`);
    });

    it("should refuse a line given to a character other than the one the shot names", async () => {
      const message = await refusal([
        ...line("D01", "U01", "tata", "2s", DIALOGUE.U01.text),
        ...LIFTED.slice(4),
      ]);

      expect(message).toContain("D01: w ujęciu U01 tę kwestię mówi ewa, nie tata");
    });

    it("should refuse an anchor outside the shot the line belongs to", async () => {
      const message = await refusal([
        ...line("D01", "U01", "ewa", "12s", DIALOGUE.U01.text),
        ...LIFTED.slice(4),
      ]);

      expect(message).toContain("D01: kotwica 12s leży poza ujęciem U01 (0-10s)");
    });

    it("should refuse a line said twice, because the film would hear it twice", async () => {
      const message = await refusal([
        ...LIFTED,
        ...line("D04", "U04", "tata", "25s", DIALOGUE.U04.text),
      ]);

      expect(message).toContain("D04: kwestia powtórzona, w ujęciu U04 pada raz");
    });

    it("should refuse lines out of the order the film runs in", async () => {
      const message = await refusal([
        ...line("D01", "U01", "ewa", "2s", DIALOGUE.U01.text),
        ...line("D02", "U04", "tata", "22s", DIALOGUE.U04.text),
        ...line("D03", "U03", "ewa", "16s", DIALOGUE.U03.text),
      ]);

      expect(message).toContain("D03: zaczyna się w 16s, czyli nie później niż D02 w 22s");
    });

    /** A voice from outside the shot is a real line with no face to move. */
    it("should report a speaker the shot does not show, without refusing", async () => {
      await upstream();
      const result = await generate(transport(script(LIFTED)));

      expect(result.ok ? result.data.notices : result.error.message).toEqual([
        "D02: ewa mówi spoza kadru U03 (głos zza kadru), lip-sync tę kwestię pominie",
      ]);
    });
  });

  /**
   * A plan accepted before stage 3 wrote lines with their speaker holds none,
   * and the remedy is to regenerate it, not to buy a script that says so.
   */
  it("should refuse to spend on a plan that attributes no line", async () => {
    await upstream();
    const { shotList } = episode();
    const plain = (await readFile(shotList, "utf8")).replaceAll(ATTRIBUTED, "");
    await writeFile(shotList, plain, "utf8");
    await approveShotList({
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
    const preview = await generate(transport(), { mode: "dry-run" });

    expect(preview.ok ? preview.data.problems.join("\n") : null).toContain(
      "lista ujęć nie przypisuje żadnej kwestii postaci"
    );
  });

  it("should refuse an episode without dialogue", async () => {
    await upstream(false);
    const calls = transport();
    const preview = await generate(calls, { mode: "dry-run" });
    const result = await generate(calls);

    expect(preview.ok ? preview.data.problems.join("\n") : null).toContain("nie ma dialogu");
    expect(result.ok ? null : result.error.message).toContain("nie ma dialogu");
    expect(calls.text).toHaveLength(0);
  });
});

describe("approveDialogue", () => {
  function approve(artifacts: readonly string[]) {
    return approveDialogue({
      artifacts,
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
  }

  it("should accept the script a human read, bound to its bytes", async () => {
    await upstream();
    await generate(transport(script(LIFTED)));
    const before = await checkDialogue({ episodeId: EPISODE, projectId: PROJECT, workspace });
    const result = await approve(["script"]);

    expect(before.ok ? before.data.approved : before.error.message).toBe(false);
    expect(result.ok ? result.data.approved : result.error.message).toBe(true);
    expect(result.ok ? result.data.script.state : null).toBe("completed");
  });

  /** Accepting the script will authorise buying every line in it. */
  it("should refuse an approval that names nothing", async () => {
    await upstream();
    await generate(transport(script(LIFTED)));
    const result = await approve([]);

    expect(result.ok ? null : result.error.message).toContain("--artifact jest wymagane");
  });

  it("should refuse a hand correction that invents a line", async () => {
    await upstream();
    await generate(transport(script(LIFTED)));
    const { dialogueScript } = episode();
    const text = await readFile(dialogueScript, "utf8");
    await writeFile(dialogueScript, text.replace(DIALOGUE.U04.text, "Śpij już."), "utf8");
    const status = await checkDialogue({ episodeId: EPISODE, projectId: PROJECT, workspace });
    const result = await approve(["script"]);

    expect(status.ok ? status.data.problems.join("\n") : null).toContain("tej kwestii nie ma");
    expect(result.ok ? null : result.error.message).toContain("nie przechodzi walidacji");
  });

  it("should report a script nobody has bought yet as absent", async () => {
    await upstream();
    const status = await checkDialogue({ episodeId: EPISODE, projectId: PROJECT, workspace });

    expect(status.ok ? status.data.script.state : status.error.message).toBe("absent");
    expect(status.ok ? status.data.nextStep : null).toContain("aimator dialogue generate");
  });
});
