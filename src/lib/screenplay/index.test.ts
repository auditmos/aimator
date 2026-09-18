import { describe, expect, it } from "vitest";
import type { EpisodeSettings } from "../project/index.js";
import { buildPrompt, PROMPT_VERSION, validateScreenplay } from "./index.js";

const SETTINGS: EpisodeSettings = {
  audio: "narration",
  durationSeconds: 30,
  language: "pl",
  sourceNature: "law-or-idea",
  subtitles: "none",
};

const SECTIONS = [
  "Premise",
  "Logline",
  "Synopsis",
  "Beats",
  "Characters and locations",
  "Scenes",
  "Review",
] as const;

function scene(number: number, seconds: number, text = "none"): string {
  return [
    `### S${String(number).padStart(2, "0")} | ${seconds}s | kuchnia, wieczór`,
    "",
    "- Action: Ewa siada przy stole i patrzy w okno.",
    "- Audio: Narrator opisuje ciszę przed burzą.",
    `- Text: ${text}`,
    "- End state: Ewa przy stole, dłonie na kolanach.",
    "",
  ].join("\n");
}

/** Every section filled, scenes supplied by the caller. */
function document(scenes: string, overrides: Partial<Record<string, string>> = {}): string {
  return SECTIONS.map((name) => {
    const body = overrides[name] ?? (name === "Scenes" ? scenes : `Treść sekcji ${name}.`);
    return `## ${name}\n\n${body}\n`;
  }).join("\n");
}

/** Three scenes of ten seconds: the shortest draft that satisfies the defaults. */
function valid(text = "none"): string {
  return document([scene(1, 10, text), scene(2, 10, text), scene(3, 10, text)].join("\n"));
}

function reject(text: string, settings: EpisodeSettings = SETTINGS): string {
  const result = validateScreenplay(text, settings);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error.message;
}

describe("validateScreenplay", () => {
  it("should accept a draft whose scenes sum to the ordered duration", () => {
    const result = validateScreenplay(valid(), SETTINGS);

    expect(result.ok ? result.data : null).toEqual({
      durationSeconds: 30,
      longestSceneSeconds: 10,
      maxSceneSeconds: 15,
      minimumScenes: 2,
      scenes: 3,
    });
  });

  it("should reject a draft wrapped in a code fence", () => {
    expect(reject(`\`\`\`markdown\n${valid()}\n\`\`\`\n`)).toContain("blokiem kodu");
  });

  it("should reject a missing section", () => {
    const text = valid().replace("## Beats\n\nTreść sekcji Beats.\n", "");
    expect(reject(text)).toContain("sekcje");
  });

  it("should reject sections in the wrong order", () => {
    const text = valid()
      .replace("## Premise", "## PLACEHOLDER")
      .replace("## Logline", "## Premise")
      .replace("## PLACEHOLDER", "## Logline");

    expect(reject(text)).toContain("sekcje");
  });

  it("should reject an empty section", () => {
    const text = valid().replace("Treść sekcji Review.", "   ");
    expect(reject(text)).toContain("Review");
  });

  it("should reject a scene heading that does not match the contract", () => {
    const text = valid().replace("### S01 | 10s | kuchnia, wieczór", "### Scena pierwsza");
    expect(reject(text)).toContain("nagłówek sceny");
  });

  it("should reject scenes numbered out of sequence", () => {
    const text = document([scene(1, 10), scene(3, 10), scene(2, 10)].join("\n"));
    expect(reject(text)).toContain("kolejne numery");
  });

  it("should reject a scene longer than fifteen seconds", () => {
    const text = document([scene(1, 16), scene(2, 14)].join("\n"));
    expect(reject(text)).toContain("15");
  });

  it("should reject a total that does not equal durationSeconds", () => {
    const text = document([scene(1, 10), scene(2, 10)].join("\n"));
    const message = reject(text);

    expect(message).toContain("20");
    // The scene minimum is arithmetic, not a separate rule: with every scene
    // capped at 15s, a correct sum cannot be reached by too few scenes. It is
    // reported here because it tells the reader what a fix has to look like.
    expect(message).toContain("2 scen");
  });

  it.each(["Action", "Audio", "Text", "End state"])("should reject a missing %s field", (label) => {
    const text = valid().replace(new RegExp(`^- ${label}:.*\\n`, "m"), "");
    expect(reject(text)).toContain(label);
  });

  it.each(["Action", "Audio", "Text", "End state"])("should reject an empty %s field", (label) => {
    const text = valid().replace(new RegExp(`^- ${label}:.*$`, "m"), `- ${label}: `);
    expect(reject(text)).toContain(label);
  });

  it("should reject a duplicated field even when the duplicate is empty", () => {
    const text = valid().replace("- Text: none", "- Text: none\n- Text: ");
    expect(reject(text)).toContain("Text");
  });

  it("should accept a field written without a Markdown bullet", () => {
    const text = valid().replaceAll("- Action:", "Action:");
    expect(validateScreenplay(text, SETTINGS).ok).toBe(true);
  });

  it("should reject on-screen text when subtitles are none", () => {
    expect(reject(valid("BURZA"))).toContain("subtitles=none");
  });

  // A full stop after `none` is punctuation, not on-screen text. Rejecting it
  // threw away a paid response that had obeyed the rule in every scene.
  it.each(["none.", "None", "NONE", "none;"])("should accept `%s` as no text", (written) => {
    expect(validateScreenplay(valid(written), SETTINGS).ok).toBe(true);
  });

  it("should reject a draft with no on-screen text when subtitles were ordered", () => {
    const settings = { ...SETTINGS, subtitles: "pl" };
    expect(reject(valid(), settings)).toContain("napis");
  });

  it("should accept on-screen text when subtitles were ordered", () => {
    const settings = { ...SETTINGS, subtitles: "pl" };
    const text = document([scene(1, 10, "BURZA (0–2 s)"), scene(2, 10), scene(3, 10)].join("\n"));

    expect(validateScreenplay(text, settings).ok).toBe(true);
  });

  it("should tolerate CRLF line endings", () => {
    expect(validateScreenplay(valid().replaceAll("\n", "\r\n"), SETTINGS).ok).toBe(true);
  });
});

describe("buildPrompt", () => {
  const RULES = "# Dzielna Ewa\n\nBurza nigdy nie staje się postacią.\n";
  const SOURCE = "# Burza\n\nEwa boi się burzy.\n";

  function prompt(settings: EpisodeSettings = SETTINGS): string {
    return buildPrompt({ aspectRatio: "16:9", rules: RULES, settings, source: SOURCE });
  }

  it("should carry every heading the output contract requires", () => {
    const text = prompt();

    for (const section of SECTIONS) {
      expect(text).toContain(`## ${section}`);
    }
  });

  it("should state the scene format and the hard per-scene limit", () => {
    const text = prompt();

    expect(text).toContain("### S01 | 15s | location and time of day");
    expect(text).toContain("between 1 and 15 seconds inclusive");
    expect(text).toContain("ceil(durationSeconds / 15)");
  });

  it("should carry the rules for all four audio modes", () => {
    const text = prompt();

    for (const mode of ["music-and-effects", "dialogue", "narration", "dialogue-and-narration"]) {
      expect(text).toContain(`\`${mode}\``);
    }
  });

  it("should carry the subtitles rules, including what none forbids", () => {
    const text = prompt();

    expect(text).toContain("`subtitles = none`");
    expect(text).toContain("prop text");
  });

  it("should tell the model that sourceNature is a decision, not a guess", () => {
    expect(prompt()).toContain("`sourceNature` states whether");
  });

  it("should embed every production setting the episode decided", () => {
    const text = prompt();

    expect(text).toContain('"durationSeconds": 30');
    expect(text).toContain('"audio": "narration"');
    expect(text).toContain('"language": "pl"');
    expect(text).toContain('"subtitles": "none"');
    expect(text).toContain('"sourceNature": "law-or-idea"');
    expect(text).toContain('"aspectRatio": "16:9"');
  });

  it("should embed the project rules and the episode source verbatim", () => {
    const text = prompt();

    expect(text).toContain(RULES);
    expect(text).toContain(SOURCE);
  });

  it("should be deterministic for the same inputs", () => {
    expect(prompt()).toBe(prompt());
  });

  it("should change when a decision changes", () => {
    expect(prompt()).not.toBe(prompt({ ...SETTINGS, durationSeconds: 45 }));
  });

  it("should declare its version explicitly rather than hashing its own source", () => {
    expect(PROMPT_VERSION).toBe(1);
  });
});
