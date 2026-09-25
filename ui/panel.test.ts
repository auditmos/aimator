import { describe, expect, it } from "vitest";
import { approvable, asImages } from "./panel";
import type { DrawnReport, TextStatus } from "./types";

/**
 * How a panel reads its own stage's report, and the one thing it must not do.
 *
 * The client has no second opinion about anything in this tool, so a reader
 * here is a translation and never a computation: a bill the CLI already
 * counted, and the prompts the CLI already wrote, put where a person can read
 * them before deciding to spend. What it owes is therefore narrow and total,
 * and this file says it: **every picture a paid call would draw has to appear
 * under the name its own stage gave it.**
 *
 * That is not one shape, and the three image stages are the reason. Stage 2
 * draws the named views of one character, so its word for a picture is
 * `artifact`; stage 5 draws references the prompt package gave ids to, so its
 * word is `id`; stage 6 draws the one frame the film opens on and has no
 * plural at all, so its report names a single `artifact` rather than a set.
 * The CLI is the contract, so the reader learns all three spellings; asking a
 * stage to rename a field so the browser could share one function would be the
 * panel writing the terminal's dictionary.
 *
 * The shapes below are what those commands really print under
 * `generate --dry-run --json`, trimmed to the fields a reader touches.
 */

/** Stage 2's: named views of one character, under `artifact`. */
const VIEWS: DrawnReport = {
  artifacts: [
    { artifact: "card", prompt: "# Task: character reference sheet" },
    { artifact: "front", prompt: "# Task: one view" },
    { artifact: "hero", prompt: null },
  ],
  paidCalls: 2,
  problems: [],
};

/** Stage 5's: references the package named, under `id`. */
const REFERENCES: DrawnReport = {
  artifacts: [{ id: "R01", prompt: "REFERENCE INPUT" }],
  paidCalls: 1,
  problems: [],
};

/** Stage 6's: exactly one frame, named in the singular. */
const OPENING: DrawnReport = {
  artifact: { id: "opening-frame", prompt: "Ewa centralnie, burza za oknem." },
  paidCalls: 1,
  problems: [],
};

describe("an image stage's reader", () => {
  it("should label stage 2's prompts with the word that stage uses", () => {
    expect(asImages(VIEWS).prompts).toEqual([
      { label: "Prompt card", text: "# Task: character reference sheet" },
      { label: "Prompt front", text: "# Task: one view" },
    ]);
  });

  it("should label stage 5's prompts with the ids the package gave them", () => {
    expect(asImages(REFERENCES).prompts).toEqual([
      { label: "Prompt R01", text: "REFERENCE INPUT" },
    ]);
  });

  it("should read stage 6's one artifact, which has no plural", () => {
    expect(asImages(OPENING).prompts).toEqual([
      { label: "Prompt opening-frame", text: "Ewa centralnie, burza za oknem." },
    ]);
  });

  /**
   * A picture nobody is going to draw has no prompt, and no line on the page.
   * The bill stays the CLI's number either way: what is billed is what the
   * stage said it would spend, never a count of the texts printed under it.
   */
  it("should bill what the stage counted, not what it printed", () => {
    expect(asImages(VIEWS).billed).toEqual([{ count: 2, unit: ["obraz", "obrazy", "obrazów"] }]);
  });
});

/**
 * When a text stage's "Zatwierdź" is offered, which has to be exactly when
 * `approve` would take it. Drift is reported among the problems, one sentence
 * per changed input after every blocking one, and its remedy is the approval
 * itself, so a screen that read every problem as a refusal hid the one button
 * the stage was asking for.
 */
describe("a text stage's approval", () => {
  const DRIFTED: TextStatus = {
    approved: false,
    inputsChanged: ["projects/dzielna-ewa/project.json"],
    problems: [
      "projects/dzielna-ewa/project.json: zmienił się od czasu ułożenia pakietu, tych wejść nikt jeszcze nie przyjął; przeczytaj pakiet jeszcze raz i zatwierdź go ponownie: aimator approve dzielna-ewa 01-burza --stage prompt-package",
    ],
    status: "completed",
  };

  it("should offer an approval whose only problem is drift, which approve settles", () => {
    expect(approvable(DRIFTED)).toBe(true);
  });

  it("should refuse one that also fails validation", () => {
    expect(
      approvable({ ...DRIFTED, problems: ["R02: brak zależności", ...DRIFTED.problems] })
    ).toBe(false);
  });

  it("should refuse what is absent or already approved", () => {
    expect(approvable({ ...DRIFTED, status: "absent" })).toBe(false);
    expect(approvable({ ...DRIFTED, approved: true })).toBe(false);
  });
});
