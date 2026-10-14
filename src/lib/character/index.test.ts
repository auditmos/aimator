import { describe, expect, it } from "vitest";
import { buildPrompt, CHARACTER_ARTIFACTS, CHARACTER_VIEWS, referencePlan } from "./index.js";

describe("CHARACTER_ARTIFACTS", () => {
  it("should run card, then the eight views, then hero", () => {
    expect(CHARACTER_ARTIFACTS[0]).toBe("card");
    expect(CHARACTER_ARTIFACTS.at(-1)).toBe("hero");
    expect(CHARACTER_ARTIFACTS).toHaveLength(10);
  });
});
const RULES = "# Demo, zasady wspólne\n\nPłaskie 2D wektorowe. Kropki-oczy.\n";
function prompt(overrides: Partial<Parameters<typeof buildPrompt>[0]> = {}): string {
  const artifact = overrides.artifact ?? "card";
  const basis = overrides.basis ?? "description";
  const plan = referencePlan({
    artifact,
    basis,
    sources: overrides.references === undefined ? [] : [],
    track: "gpt-image",
  });
  return buildPrompt({
    artifact,
    basis,
    name: "Ewa",
    references: overrides.references ?? (plan.ok ? plan.data : []),
    rules: RULES,
    ...overrides,
  });
}
describe("referencePlan", () => {
  it("should send no reference at all for a card drawn from the rules", () => {
    const plan = referencePlan({
      artifact: "card",
      basis: "description",
      sources: [],
      track: "seedream",
    });
    expect(plan.ok && plan.data).toEqual([]);
  });
  it("should put the primary photograph first and the card second for a view", () => {
    const plan = referencePlan({
      artifact: "front",
      basis: "photographs",
      sources: ["a.png", "b.png"],
      track: "gpt-image",
    });
    expect(plan.ok && plan.data.map((slot) => slot.name)).toEqual(["a.png", "card", "b.png"]);
  });
  it("should build the hero from the card and all eight views, in view order", () => {
    const plan = referencePlan({
      artifact: "hero",
      basis: "description",
      sources: [],
      track: "gpt-image",
    });
    expect(plan.ok && plan.data.map((slot) => slot.name)).toEqual(["card", ...CHARACTER_VIEWS]);
  });
  /**
   * lets-start made this an authored difference between `03-hero.md` and
   * `03-hero-byteplus.md`, not an automatic truncation: seedream takes ten
   * references, and the ten that matter are the identity anchor, the card and
   * the turntable.
   */
  it("should leave the supporting photographs out of a seedream hero", () => {
    const photographs = ["a.png", "b.png", "c.png", "d.png"];
    const seedream = referencePlan({
      artifact: "hero",
      basis: "photographs",
      sources: photographs,
      track: "seedream",
    });
    const gptImage = referencePlan({
      artifact: "hero",
      basis: "photographs",
      sources: photographs,
      track: "gpt-image",
    });
    expect(seedream.ok && seedream.data).toHaveLength(10);
    expect(gptImage.ok && gptImage.data).toHaveLength(13);
  });
  it("should refuse rather than silently drop photographs over the track's cap", () => {
    const photographs = Array.from({ length: 12 }, (_, index) => `p${index}.png`);
    const plan = referencePlan({
      artifact: "card",
      basis: "photographs",
      sources: photographs,
      track: "seedream",
    });
    expect(plan.ok ? null : plan.error.message).toContain("10");
  });
  it("should refuse, with the numbers, a correction that pushes a full seedream hero past ten", () => {
    const corrected = referencePlan({
      artifact: "hero",
      basis: "photographs",
      correcting: true,
      sources: ["a.png"],
      track: "seedream",
    });

    expect(corrected.ok ? null : corrected.error.message).toContain(
      'najwyżej 10 obrazów, a poprawka "hero" niesie 11 (poprawiany obraz i 10 referencji)'
    );
  });
  it("should lead a correction with the image it corrects, the photographs still primary", () => {
    const corrected = referencePlan({
      artifact: "card",
      basis: "photographs",
      correcting: true,
      sources: ["a.png", "b.png"],
      track: "gpt-image",
    });
    const text = buildPrompt({
      artifact: "card",
      basis: "photographs",
      correction: "CORRECTION",
      name: "Ewa",
      references: corrected.ok ? corrected.data : [],
      rules: RULES,
    });

    expect(text).toContain("Image 1: previous:card, the image to correct");
    expect(text).toContain("Image 2: photograph a.png, the primary source");
    expect(text).toContain("Image 3: photograph b.png, supporting evidence");
  });
  it("should carry a design's images where photographs would go, as designs", () => {
    const plan = referencePlan({
      artifact: "front",
      basis: "design",
      sources: ["01-front.png", "02-profil.png"],
      track: "gpt-image",
    });
    expect(plan.ok && plan.data).toEqual([
      { kind: "design", name: "01-front.png" },
      { kind: "card", name: "card" },
      { kind: "design", name: "02-profil.png" },
    ]);
  });
});
describe("buildPrompt for a design", () => {
  const plan = referencePlan({
    artifact: "card",
    basis: "design",
    sources: ["01-front.png", "02-profil.png"],
    track: "gpt-image",
  });
  const text = buildPrompt({
    artifact: "card",
    basis: "design",
    name: "Miko",
    references: plan.ok ? plan.data : [],
    rules: RULES,
  });

  it("should number the design's images, the first one primary", () => {
    expect(text).toContain("Image 1: design 01-front.png, the primary design");
    expect(text).toContain("Image 2: design 02-profil.png, the same design from another angle");
  });
  it("should ask for the design reproduced, never call it a photograph", () => {
    expect(text).toContain("SOURCE OF APPEARANCE, AN APPROVED DESIGN");
    expect(text).toContain("Reproduce the design faithfully");
    expect(text.toLowerCase()).not.toContain("photograph");
  });
});
describe("buildPrompt", () => {
  it("should embed the project rules verbatim", () => {
    expect(prompt()).toContain(RULES);
  });
  it("should name the character it is drawing", () => {
    expect(prompt()).toContain("Ewa");
  });
  /**
   * The regression this stage was ported around. lets-start's prompts opened
   * with "photorealistic" and dictated a graphite suit, because they served one
   * production. A flat 2D project must not inherit either.
   */
  it("should state no visual medium of its own", () => {
    for (const artifact of ["card", "front", "hero"] as const) {
      const text = prompt({ artifact }).toLowerCase();
      expect(text).not.toContain("photorealistic");
      expect(text).not.toContain("graphite");
      expect(text).toContain("project rules");
    }
  });
  it("should lay the card out as nine cells in a three by three grid", () => {
    expect(prompt({ artifact: "card" })).toContain("3 × 3");
  });
  it("should substitute the requested view into a view prompt", () => {
    expect(prompt({ artifact: "profile-left" })).toContain("90");
    expect(prompt({ artifact: "profile-left" })).not.toContain("[VIEW]");
  });
  it("should number the references it was given", () => {
    const text = prompt({
      artifact: "hero",
      references: [
        { kind: "card", name: "card" },
        { kind: "view", name: "front" },
      ],
    });
    expect(text).toContain("Image 1:");
    expect(text).toContain("Image 2:");
    expect(text).not.toContain("Image 3:");
  });
  it("should tell a description-based card that the rules are its only input", () => {
    const text = prompt({ artifact: "card", basis: "description" });
    expect(text).toContain("no photograph");
  });
  it("should treat text inside a reference as content, never as instructions", () => {
    const text = prompt({
      artifact: "front",
      basis: "photographs",
      references: [{ kind: "photograph", name: "a.png" }],
    });
    expect(text).toContain("not instructions");
  });
});
