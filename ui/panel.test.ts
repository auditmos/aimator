import { describe, expect, it } from "vitest";
import { asMedia } from "./clips";
import { asDialogue } from "./dialogue";
import { approvable, asImages } from "./panel";
import type { DrawnReport, FinalFilm, MediaReport, TextStatus } from "./types";
import { acceptableFilm, asFilm, asVersions } from "./versions";

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
 * Stage 7's, and the one notice that exists only before a purchase: a clip
 * about to be rendered by another model than the track's accepted ones. The
 * status block never says it, because it depends on the model in the field.
 */
describe("stage 7's reader", () => {
  const MIXED: MediaReport = {
    artifacts: [{ id: "C02", prompt: "Ewa podchodzi do okna." }],
    notices: [
      "zatwierdzone klipy toru seedream pochodzą z innego modelu: C01 (dreamina-seedance-2-5-260628)",
    ],
    paidImages: 0,
    paidVideos: 1,
    problems: [],
  };

  it("should carry what the purchase says without refusing, beside the bill", () => {
    expect(asMedia(MIXED).notices).toEqual(MIXED.notices);
  });
});

/**
 * Stage 11's reader, which reads one shape two ways. A text call, the
 * script's or the translation's, has a prompt and no lines and is billed in
 * calls; a purchase of lines is billed in calls **and** characters, because the
 * speech provider charges for characters, and the two are never summed.
 */
describe("stage 11's reader", () => {
  it("should bill a text call in calls, with the prompt it would send", () => {
    const priced = asDialogue({
      characters: 0,
      lines: [],
      notices: [],
      paidCalls: 1,
      problems: [],
      prompt: "# Task: translate",
    });

    expect(priced.billed.map((line) => [line.count, line.unit[2]])).toEqual([
      [1, "płatnych wywołań tekstowych"],
    ]);
    expect(priced.prompts).toEqual([
      { label: "Prompt, który poleci do modelu tekstowego", text: "# Task: translate" },
    ]);
  });

  it("should bill lines in lines and characters, apart", () => {
    const priced = asDialogue({
      characters: 42,
      lines: [
        { cast: "ewa", characters: 20, id: "en:D01", note: "gotowa do kupienia", state: "planned" },
        {
          cast: "tata",
          characters: 22,
          id: "en:D02",
          note: "gotowa do kupienia",
          state: "planned",
        },
      ],
      notices: [],
      paidCalls: 2,
      problems: [],
      prompt: null,
    });

    expect(priced.billed.map((line) => [line.count, line.unit[2]])).toEqual([
      [2, "kwestii"],
      [42, "znaków"],
    ]);
    expect(priced.prompts).toEqual([]);
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
    amended: [],
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

  /**
   * A file a person corrected by hand is the same kind of problem as drift: a
   * lapsed consent, one sentence per path in `amended`, and `approve` is what
   * accepts it. Counted as a refusal, it hid "Zatwierdź" on the one screen a
   * correction is meant to be accepted from.
   */
  const AMENDED: TextStatus = {
    amended: ["projects/dzielna-ewa/episodes/01-burza/screenplay.md"],
    approved: false,
    inputsChanged: [],
    problems: [
      "projects/dzielna-ewa/episodes/01-burza/screenplay.md: poprawiony ręcznie po generacji, tej wersji nikt jeszcze nie przyjął; przeczytaj i zatwierdź: aimator approve dzielna-ewa 01-burza --stage screenplay",
    ],
    status: "completed",
  };

  it("should offer an approval whose only problem is a hand correction", () => {
    expect(approvable(AMENDED)).toBe(true);
    expect(
      approvable({
        ...AMENDED,
        inputsChanged: DRIFTED.inputsChanged,
        problems: [...DRIFTED.problems, ...AMENDED.problems],
      })
    ).toBe(true);
  });

  it("should refuse a hand correction that fails validation", () => {
    expect(
      approvable({
        ...AMENDED,
        problems: [
          "screenplay.md: suma czasów scen to 32 s, a odcinek ma 30 s",
          ...AMENDED.problems,
        ],
      })
    ).toBe(false);
  });
});

/**
 * Stage 12's reader, which reads two reports. A face call is billed in face
 * calls; a lip-sync in face calls **and** jobs, apart, because a second speaker
 * in a clip costs a face call beside its job. What a lip-sync would send is a
 * plan rather than a prompt, so its jobs stand where a prompt would.
 */
describe("stage 12's reader", () => {
  it("should bill a face call in face calls, with nothing to read", () => {
    const priced = asVersions({ clip: "C01", faces: [], notices: [], paidCalls: 1, problems: [] });

    expect(priced.billed.map((line) => [line.count, line.unit[2]])).toEqual([
      [1, "rozpoznań twarzy"],
    ]);
    expect(priced.prompts).toEqual([]);
  });

  it("should bill a lip-sync in face calls and jobs, apart, with every job it would run", () => {
    const priced = asVersions({
      clips: [
        {
          id: "C01",
          jobs: [
            {
              cast: "ewa",
              end: 3000,
              face: "0",
              key: "C01:ewa",
              lines: ["en:D01"],
              start: 1000,
              state: "planned",
            },
            {
              cast: "tata",
              end: 9000,
              face: "1",
              key: "C01",
              lines: ["en:D02"],
              start: 6000,
              state: "planned",
            },
          ],
          problems: [],
        },
      ],
      notices: [],
      paidFaces: 1,
      paidLipSyncs: 2,
      problems: [],
    });

    expect(priced.billed.map((line) => [line.count, line.unit[2]])).toEqual([
      [1, "rozpoznań twarzy"],
      [2, "zadań lip-sync"],
    ]);
    expect(priced.prompts[0]?.text).toBe(
      [
        "C01:ewa: ewa, twarz 0, od 1000 ms do 3000 ms, en:D01, do kupienia",
        "C01: tata, twarz 1, od 6000 ms do 9000 ms, en:D02, do kupienia",
      ].join("\n")
    );
  });
});

/**
 * Stage 12's two films, which buy nothing. What a panel reads off them is when
 * "Zatwierdź" stands beside one, which has to be exactly when `approve` would
 * take it, and what a dry run says the film would be laid from: each clip of
 * the picture with where it came from, and each sound with where it lands.
 */
describe("stage 12's films", () => {
  const LAID: FinalFilm = {
    approved: false,
    checks: ["animation", "timing", "acting", "lip-sync", "continuity"],
    id: "en",
    inputsChanged: [],
    note: "próba 2026-10-13T19-00-00Z",
    state: "completed",
  };

  it("should offer a yes on a film that is laid and not yet accepted", () => {
    expect(acceptableFilm(LAID)).toBe(true);
    expect(acceptableFilm({ ...LAID, checks: [], id: "pl" })).toBe(true);
  });

  /** A film whose inputs moved is refused by `approve`; its remedy is laying it again. */
  it("should refuse one that is absent, accepted, or laid from inputs that have since changed", () => {
    expect(acceptableFilm({ ...LAID, state: "absent" })).toBe(false);
    expect(acceptableFilm({ ...LAID, approved: true })).toBe(false);
    expect(
      acceptableFilm({
        ...LAID,
        inputsChanged: ["projects/dzielna-ewa/episodes/01-burza/gpt-image/versions/clips/C01.mp4"],
      })
    ).toBe(false);
  });

  it("should read the picture and every sound of a planned film, nothing re-derived", () => {
    const read = asFilm({
      actualSeconds: 30,
      engine: "ffmpeg 7.1",
      language: "en",
      nextStep: "",
      notices: [],
      picture: [
        { id: "C01", source: "lip-sync" },
        { id: "C02", source: "clips" },
      ],
      problems: [],
      sounds: [
        { atSeconds: 0, id: "M01", kind: "music", plannedSeconds: 0, seconds: 30 },
        { atSeconds: 3.5, id: "en:D01", kind: "speech", plannedSeconds: 3, seconds: 2 },
        { atSeconds: 21, id: "E01", kind: "effect", plannedSeconds: 21, seconds: 1 },
      ],
      state: "planned",
    });

    expect(read.picture).toEqual(["C01 · po lip-syncu", "C02 · przyjęty klip etapu 7"]);
    expect(read.sounds).toEqual([
      "M01 · muzyka · od 0s (plan 0s) · 30s",
      "en:D01 · mowa · od 3.5s (plan 3s) · 2s",
      "E01 · efekt · od 21s (plan 21s) · 1s",
    ]);
  });
});
