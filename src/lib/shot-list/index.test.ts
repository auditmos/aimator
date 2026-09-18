import { describe, expect, it } from "vitest";
import type { CastMember, ShotListSettings } from "../project/index.js";
import { buildPrompt, PROMPT_VERSION, validateShotList } from "./index.js";

/**
 * Stage 3's validator, prompt and cast binding, exercised through the module
 * entry. Everything here is pure: no filesystem, no network, no money.
 */

const SETTINGS: ShotListSettings = {
  audio: "narration",
  durationSeconds: 30,
  language: "pl",
  maxClipSeconds: 15,
  sourceNature: "law-or-idea",
  subtitles: "none",
};

const CAST: readonly CastMember[] = [
  { id: "ewa", name: "Ewa" },
  { id: "tata", name: "Tata" },
];

const SCREENPLAY_SECTIONS = [
  "Premise",
  "Logline",
  "Synopsis",
  "Beats",
  "Characters and locations",
  "Scenes",
  "Review",
];

/** Three ten-second scenes, no on-screen text unless asked for. */
function screenplay(text = "none"): string {
  const scenes = [1, 2, 3]
    .map((number) =>
      [
        `### S0${number} | 10s | salon, wieczór`,
        "",
        "- Action: Ewa odsuwa krzesło i siada przy stole.",
        "- Audio: Narrator opisuje ciszę.",
        `- Text: ${text}`,
        "- End state: Ewa przy stole, dłonie na blacie.",
        "",
      ].join("\n")
    )
    .join("\n");

  return SCREENPLAY_SECTIONS.map(
    (name) => `## ${name}\n\n${name === "Scenes" ? scenes : `Treść sekcji ${name}.`}\n`
  ).join("\n");
}

interface ClipSpec {
  readonly id: string;
  readonly range: string;
  readonly reference: string;
  readonly shots: string;
}

interface ShotSpec {
  readonly cast?: string;
  readonly clip: string;
  readonly id: string;
  readonly range: string;
  readonly scene: string;
  readonly text?: string;
}

const CLIPS: readonly ClipSpec[] = [
  { id: "C01", range: "0-15s", reference: "opening-frame", shots: "U01,U02" },
  { id: "C02", range: "15-30s", reference: "previous-end-frame", shots: "U03,U04" },
];

const SHOTS: readonly ShotSpec[] = [
  { clip: "C01", id: "U01", range: "0-10s", scene: "S01" },
  { clip: "C01", id: "U02", range: "10-15s", scene: "S02" },
  { clip: "C02", id: "U03", range: "15-20s", scene: "S02" },
  { clip: "C02", id: "U04", range: "20-30s", scene: "S03" },
];

function clipBlock(clip: ClipSpec): string {
  return [
    `### ${clip.id} | ${clip.range}`,
    "",
    `- Shots: ${clip.shots}`,
    `- Reference: ${clip.reference}`,
    "- Continuity: Ewa przy stole, dłonie na blacie, światło lampy od lewej.",
    "",
  ].join("\n");
}

function shotBlock(shot: ShotSpec): string {
  return [
    `### ${shot.id} | ${shot.scene} | ${shot.clip} | ${shot.range}`,
    "",
    "- Purpose: Pokazuje, że Ewa zostaje sama z burzą.",
    "- Frame: Plan amerykański, Ewa po prawej trzeciej kadru.",
    "- Action: Ewa odsuwa krzesło (2 s) i siada (2 s).",
    "- Expression: Zaciśnięte usta, wzrok w okno.",
    "- Camera: Statyczny kadr, cięcie na osi.",
    `- Cast: ${shot.cast ?? "ewa"}`,
    "- Audio: Deszcz o szybę, narrator kończy zdanie.",
    `- Text: ${shot.text ?? "none"}`,
    "- Start state: Ewa stoi przy krześle, obie dłonie wolne.",
    "- End state: Ewa siedzi, dłonie na blacie.",
    "",
  ].join("\n");
}

function shotList(
  overrides: { clips?: readonly ClipSpec[]; shots?: readonly ShotSpec[] } = {}
): string {
  const clips = (overrides.clips ?? CLIPS).map(clipBlock).join("\n");
  const shots = (overrides.shots ?? SHOTS).map(shotBlock).join("\n");

  return [
    "## Plan\n\nDwa klipy, cięcie na akcji, kadr 16:9.\n",
    `## Clips\n\n${clips}`,
    `## Shots\n\n${shots}`,
    "## Review\n\nSprawdzono sumy czasów i ciągłość rekwizytów. Plan wymaga oceny.\n",
  ].join("\n");
}

function validate(
  text: string,
  settings: ShotListSettings = SETTINGS,
  source = screenplay()
): ReturnType<typeof validateShotList> {
  return validateShotList({ cast: CAST, screenplay: source, settings, text });
}

function reason(result: ReturnType<typeof validateShotList>): string {
  return result.ok ? "" : result.error.message;
}

describe("validateShotList", () => {
  it("should accept a plan that covers the episode and report what it found", () => {
    const result = validate(shotList());

    expect(result.ok ? result.data.shots.length : reason(result)).toBe(4);
    expect(result.ok ? result.data.clips.length : null).toBe(2);
    expect(result.ok ? result.data.scenes.length : null).toBe(3);
    expect(result.ok ? result.data.durationSeconds : null).toBe(30);
    expect(result.ok ? result.data.longestClipSeconds : null).toBe(15);
  });

  it("should place every shot on the episode timeline", () => {
    const result = validate(shotList());
    const first = result.ok ? result.data.shots[0] : null;

    expect(first).toEqual({
      cast: ["ewa"],
      clip: "C01",
      end: 10,
      hasText: false,
      id: "U01",
      scene: "S01",
      start: 0,
    });
  });

  it("should refuse a document wrapped in a code fence", () => {
    expect(reason(validate(`\`\`\`markdown\n${shotList()}\n\`\`\``))).toContain("blok");
  });

  it("should require the four sections in order", () => {
    expect(reason(validate(shotList().replace("## Review", "## Notes")))).toContain("sekcje");
  });

  it("should refuse an empty section", () => {
    expect(
      reason(validate(shotList().replace("Dwa klipy, cięcie na akcji, kadr 16:9.", "")))
    ).toContain("pusta sekcja");
  });

  describe("time coverage", () => {
    it("should refuse a gap between shots", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U02" ? { ...shot, range: "11-15s" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("U02");
    });

    it("should refuse overlapping shots", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U03" ? { ...shot, range: "14-20s" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("U03");
    });

    it("should refuse a total that is not the episode duration", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U04" ? { ...shot, range: "20-28s" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("28");
    });

    it("should refuse a shot whose time falls outside the scene it names", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U02" ? { ...shot, scene: "S01" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("poza sceną");
    });

    it("should refuse a shot whose time falls outside the clip it names", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U03" ? { ...shot, clip: "C01" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("C01");
    });

    it("should refuse a shot that names a scene the screenplay does not have", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U04" ? { ...shot, scene: "S09" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("S09");
    });
  });

  describe("identifiers", () => {
    it("should refuse shots numbered out of order", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U02" ? { ...shot, id: "U05" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("kolejne numery");
    });

    it("should refuse clips numbered out of order", () => {
      const clips = CLIPS.map((clip) => (clip.id === "C02" ? { ...clip, id: "C07" } : clip));

      expect(reason(validate(shotList({ clips })))).toContain("kolejne numery");
    });

    it("should refuse a clip whose Shots list disagrees with the shots themselves", () => {
      const clips = CLIPS.map((clip) => (clip.id === "C01" ? { ...clip, shots: "U01" } : clip));

      expect(reason(validate(shotList({ clips })))).toContain("C01");
    });
  });

  describe("clips", () => {
    it("should refuse a clip longer than the episode's maximum", () => {
      const clips = [
        { id: "C01", range: "0-20s", reference: "opening-frame", shots: "U01,U02,U03" },
        { id: "C02", range: "20-30s", reference: "previous-end-frame", shots: "U04" },
      ];
      const shots = SHOTS.map((shot) => (shot.id === "U03" ? { ...shot, clip: "C01" } : shot));

      expect(reason(validate(shotList({ clips, shots })))).toContain("15");
    });

    it("should require the first clip to reference the opening frame", () => {
      const clips = CLIPS.map((clip) =>
        clip.id === "C01" ? { ...clip, reference: "previous-end-frame" } : clip
      );

      expect(reason(validate(shotList({ clips })))).toContain("opening-frame");
    });

    it("should refuse an unknown reference kind on a later clip", () => {
      const clips = CLIPS.map((clip) =>
        clip.id === "C02" ? { ...clip, reference: "opening-frame" } : clip
      );

      expect(reason(validate(shotList({ clips })))).toContain("C02");
    });

    it("should refuse clips that leave a hole in the episode", () => {
      const clips = CLIPS.map((clip) => (clip.id === "C02" ? { ...clip, range: "16-30s" } : clip));

      expect(reason(validate(shotList({ clips })))).toContain("C02");
    });
  });

  describe("cast", () => {
    it("should record which cast members a shot shows", () => {
      const shots = SHOTS.map((shot) =>
        shot.id === "U01" ? { ...shot, cast: "ewa, tata" } : shot
      );
      const result = validate(shotList({ shots }));

      expect(result.ok ? result.data.shots[0]?.cast : reason(result)).toEqual(["ewa", "tata"]);
      expect(result.ok ? result.data.castSeen : null).toEqual(["ewa", "tata"]);
    });

    it("should accept a shot with nobody in it", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U01" ? { ...shot, cast: "none" } : shot));
      const result = validate(shotList({ shots }));

      expect(result.ok ? result.data.shots[0]?.cast : reason(result)).toEqual([]);
    });

    it("should refuse a name that is not a cast identifier", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U01" ? { ...shot, cast: "Ewa" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("Ewa");
    });

    it("should refuse a repeated cast identifier in one shot", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U01" ? { ...shot, cast: "ewa,ewa" } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("ewa");
    });
  });

  describe("on-screen text", () => {
    const WITH_TEXT: ShotListSettings = { ...SETTINGS, subtitles: "pl" };
    const CAPTION = "Burza (0-3 s)";

    it("should refuse a caption when the episode ordered no subtitles", () => {
      const shots = SHOTS.map((shot) => (shot.id === "U01" ? { ...shot, text: CAPTION } : shot));

      expect(reason(validate(shotList({ shots })))).toContain("U01");
    });

    it("should refuse a caption in a scene the screenplay left without one", () => {
      const source = screenplay();
      const shots = SHOTS.map((shot) => (shot.id === "U01" ? { ...shot, text: CAPTION } : shot));

      expect(reason(validate(shotList({ shots }), WITH_TEXT, source))).toContain("U01");
    });

    it("should carry a caption the screenplay's scene already had", () => {
      const shots = SHOTS.map((shot) => ({ ...shot, text: CAPTION }));

      expect(validate(shotList({ shots }), WITH_TEXT, screenplay(CAPTION)).ok).toBe(true);
    });

    it("should refuse a scene whose on-screen text no shot carries", () => {
      expect(reason(validate(shotList(), WITH_TEXT, screenplay(CAPTION)))).toContain("S01");
    });
  });

  it("should require every shot field exactly once and nonempty", () => {
    const broken = shotList().replace(
      "- Purpose: Pokazuje, że Ewa zostaje sama z burzą.",
      "- Purpose: "
    );

    expect(reason(validate(broken))).toContain("Purpose");
  });
});

describe("buildPrompt", () => {
  const prompt = buildPrompt({
    aspectRatio: "16:9",
    cast: CAST,
    rules: "# Zasady\n\nEwa jest rysowana płasko.",
    screenplay: screenplay(),
    settings: { ...SETTINGS, maxClipSeconds: 15 },
  });

  it("should declare a version rather than derive one", () => {
    expect(PROMPT_VERSION).toBe(1);
  });

  it("should carry the clip limit as a production setting", () => {
    expect(prompt).toContain('"maxClipSeconds": 15');
  });

  it("should carry the cast as a closed vocabulary of identifiers", () => {
    expect(prompt).toContain('"ewa"');
    expect(prompt).toContain('"Tata"');
  });

  it("should distinguish a scene, a shot and a clip", () => {
    expect(prompt).toContain("Scene, shot and clip are three different units");
    expect(prompt).toContain("Never equate these");
  });

  it("should embed the rules and the screenplay verbatim", () => {
    expect(prompt).toContain("Ewa jest rysowana płasko.");
    expect(prompt).toContain("### S01 | 10s | salon, wieczór");
  });

  it("should be deterministic for the same inputs", () => {
    expect(
      buildPrompt({
        aspectRatio: "16:9",
        cast: CAST,
        rules: "# Zasady\n\nEwa jest rysowana płasko.",
        screenplay: screenplay(),
        settings: { ...SETTINGS, maxClipSeconds: 15 },
      })
    ).toBe(prompt);
  });
});
