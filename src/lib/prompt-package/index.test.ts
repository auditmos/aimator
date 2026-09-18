import { describe, expect, it } from "vitest";
import type { CastMember } from "../project/index.js";
import { type ShotList, validateShotList } from "../shot-list/index.js";
import { buildPrompt, validatePromptPackage } from "./index.js";

/**
 * Stage 4's offline half, through the module entry: the wiring verdict, and the
 * prompt a paid call would carry.
 *
 * Every case here is about the binding to the shot list, because that is what
 * the stage exists to establish — the plan already said who is on screen in
 * which clip, and a package that contradicts it plans images nobody can draw.
 */

const CAST: readonly CastMember[] = [
  { id: "ewa", name: "Ewa" },
  { id: "tata", name: "Tata" },
];

const RULES = "# Zasady\n\nPłaskie 2D, dziesięć barw, alpaka w pudrowym różu.\n";

const SETTINGS = {
  audio: "narration",
  durationSeconds: 30,
  language: "pl",
  maxClipSeconds: 15,
  sourceNature: "law-or-idea",
  subtitles: "none",
} as const;

function screenplay(): string {
  const scenes = [1, 2, 3]
    .map((number) =>
      [
        `### S0${number} | 10s | salon, wieczór`,
        "",
        "- Action: Ewa siada przy stole.",
        "- Audio: Narrator opisuje ciszę.",
        "- Text: none",
        "- End state: Ewa przy stole.",
        "",
      ].join("\n")
    )
    .join("\n");

  return ["Premise", "Logline", "Synopsis", "Beats", "Characters and locations", "Scenes", "Review"]
    .map((name) => `## ${name}\n\n${name === "Scenes" ? scenes : `Treść sekcji ${name}.`}\n`)
    .join("\n");
}

function shot(id: string, scene: string, clip: string, range: string, cast: string): string {
  return [
    `### ${id} | ${scene} | ${clip} | ${range}`,
    "",
    "- Purpose: Pokazuje, że Ewa zostaje sama z burzą.",
    "- Frame: Plan amerykański, Ewa po lewej.",
    "- Action: Ewa odsuwa krzesło i siada.",
    "- Expression: Zaciśnięte usta.",
    "- Camera: Statyczny kadr.",
    `- Cast: ${cast}`,
    "- Audio: Deszcz o szybę.",
    "- Text: none",
    "- Start state: Ewa stoi przy krześle.",
    "- End state: Ewa siedzi.",
    "",
  ].join("\n");
}

function shotListText(): string {
  return [
    "## Plan\n\nDwa klipy, kadr 16:9.\n",
    [
      "## Clips",
      "",
      "### C01 | 0-15s",
      "",
      "- Shots: U01,U02",
      "- Reference: opening-frame",
      "- Continuity: Ewa przy stole.",
      "",
      "### C02 | 15-30s",
      "",
      "- Shots: U03,U04",
      "- Reference: previous-end-frame",
      "- Continuity: Ewa siedzi, tata obok.",
      "",
    ].join("\n"),
    [
      "## Shots",
      "",
      shot("U01", "S01", "C01", "0-10s", "ewa"),
      shot("U02", "S02", "C01", "10-15s", "ewa,tata"),
      shot("U03", "S02", "C02", "15-20s", "tata"),
      shot("U04", "S03", "C02", "20-30s", "ewa,tata"),
    ].join("\n"),
    "## Review\n\nSprawdzono sumy czasów. Plan wymaga oceny.\n",
  ].join("\n");
}

function plan(): ShotList {
  const verdict = validateShotList({
    cast: CAST,
    screenplay: screenplay(),
    settings: SETTINGS,
    text: shotListText(),
  });

  if (!verdict.ok) {
    throw verdict.error;
  }

  return verdict.data;
}

/** A package that satisfies every rule; each test breaks exactly one thing. */
function manifest(): Record<string, unknown> {
  return {
    clips: [
      { id: "C01", referenceIds: ["hero:ewa", "hero:tata", "R01", "R02"] },
      { id: "C02", referenceIds: ["hero:ewa", "hero:tata", "R01"] },
    ],
    opening: { referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        subject: "Salon wieczorem, niska kanapa po prawej",
      },
      { dependsOn: ["R01"], id: "R02", kind: "prop", subject: "Alpaka, ucho ugięte" },
    ],
    review: "Do rozstrzygnięcia: skala alpaki przy twarzy taty.",
  };
}

function judge(value: Record<string, unknown>): ReturnType<typeof validatePromptPackage> {
  return validatePromptPackage({ cast: CAST, shotList: plan(), value });
}

function reasonOf(value: Record<string, unknown>): string {
  const verdict = judge(value);

  return verdict.ok ? "" : verdict.error.message;
}

describe("validatePromptPackage", () => {
  it("should accept a well-wired package and return it as data", () => {
    const verdict = judge(manifest());

    expect(verdict.ok ? verdict.data.references.length : null).toBe(2);
    expect(verdict.ok ? verdict.data.heroes : null).toEqual(["ewa", "tata"]);
  });

  it("should require reference ids to run consecutively from R01", () => {
    const value = manifest();
    const references = value.references as { id: string }[];
    references[1] = { ...references[1], id: "R03" } as (typeof references)[number];

    expect(reasonOf(value)).toContain("kolejne numery od R01");
  });

  it("should refuse a dependency on a later reference, which is how a cycle would start", () => {
    const value = manifest();
    const references = value.references as { dependsOn: string[] }[];
    references[0] = { ...references[0], dependsOn: ["R02"] } as (typeof references)[number];

    expect(reasonOf(value)).toContain("R01: dependsOn");
  });

  it("should refuse a clip missing the canonical image of somebody its shots show", () => {
    const value = manifest();
    const clips = value.clips as { referenceIds: string[] }[];
    clips[1] = { ...clips[1], referenceIds: ["hero:ewa", "R01"] } as (typeof clips)[number];

    expect(reasonOf(value)).toContain("hero:tata");
  });

  it("should refuse a frame that names no space to widen into", () => {
    const value = manifest();
    value.opening = { referenceIds: ["hero:ewa", "R02"] };

    expect(reasonOf(value)).toContain("przestrzeni");
  });

  it("should require the clips to be exactly the shot list's clips, in order", () => {
    const value = manifest();
    value.clips = (value.clips as unknown[]).slice(0, 1);

    expect(reasonOf(value)).toContain("C01,C02");
  });

  it("should refuse a reference no frame and no other reference points at", () => {
    const value = manifest();
    const clips = value.clips as { referenceIds: string[] }[];
    clips[0] = {
      ...clips[0],
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    } as (typeof clips)[number];
    const references = value.references as { dependsOn: string[] }[];
    references[1] = { ...references[1], dependsOn: ["hero:ewa"] } as (typeof references)[number];

    expect(reasonOf(value)).toContain("R02");
  });

  it("should refuse the same reference assigned twice to one frame", () => {
    const value = manifest();
    value.opening = { referenceIds: ["hero:ewa", "R01", "R01"] };

    expect(reasonOf(value)).toContain("dwa razy");
  });

  it("should refuse a package that carries no review of its own", () => {
    const value = manifest();
    value.review = "   ";

    expect(reasonOf(value)).toContain("review");
  });

  it("should refuse a subject that is a description rather than a label", () => {
    const value = manifest();
    const references = value.references as { subject: string }[];
    references[0] = {
      ...references[0],
      subject: "Salon\nz niską kanapą",
    } as (typeof references)[number];

    expect(reasonOf(value)).toContain("jedną niepustą linią");
  });

  it("should refuse an unknown key rather than ignore it", () => {
    const value = { ...manifest(), imageModel: "seedream" };

    expect(reasonOf(value)).toContain("niepoprawny kształt");
  });
});

describe("buildPrompt", () => {
  const prompt = buildPrompt({
    aspectRatio: "16:9",
    cast: CAST,
    heroes: ["ewa", "tata"],
    rules: RULES,
    settings: SETTINGS,
    shotList: shotListText(),
  });

  it("should embed the project rules and the shot list verbatim", () => {
    expect(prompt).toContain(RULES);
    expect(prompt).toContain(shotListText());
  });

  it("should declare the closed vocabulary of canonical-image ids", () => {
    expect(prompt).toContain('"hero:ewa"');
    expect(prompt).toContain('"hero:tata"');
  });

  it("should name no image track, because one package serves both", () => {
    expect(prompt).not.toContain("gpt-image");
    expect(prompt).not.toContain("seedream");
  });

  it("should forbid restating the shot list inside a prompt", () => {
    expect(prompt).toContain("second copy of the shot list");
  });

  /**
   * The planner writes ids into prose an image model will read. That is only
   * legitimate because the sending stage promises to print the list those ids
   * appear in — so the promise has to be in the prompt, not merely honoured
   * later by whoever assembles the request.
   */
  it("should show the planner the attachment list its ids will be read beside", () => {
    expect(prompt).toContain("REFERENCE INPUTS — IN THIS ORDER");
    expect(prompt).toContain("Image 1 = hero:ewa");
  });

  it("should forbid a filename, a path or a track name in the prose", () => {
    expect(prompt).toContain("Never write a filename, a path or a track name");
  });
});
