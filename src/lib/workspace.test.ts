import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  characterPaths,
  characterTrackPaths,
  characterViewImage,
  clipFrame,
  clipVideo,
  episodeIdFromSource,
  episodePaths,
  episodeTrackPaths,
  imageRunPaths,
  projectPaths,
  referenceImage,
  resolveWorkspace,
  runPaths,
  videoRunPaths,
} from "./workspace.js";

describe("resolveWorkspace", () => {
  it("should keep an absolute path", () => {
    expect(resolveWorkspace("/srv/aimator")).toEqual({ data: { root: "/srv/aimator" }, ok: true });
  });

  it("should expand a leading tilde", () => {
    const result = resolveWorkspace("~/Video/aimator");
    expect(result.ok ? result.data.root : null).toBe(`${homedir()}/Video/aimator`);
  });

  it("should resolve a relative path against the current directory", () => {
    const result = resolveWorkspace("./ws");
    expect(result.ok ? result.data.root : null).toBe(`${process.cwd()}/ws`);
  });

  it("should fail when no root is configured", () => {
    const result = resolveWorkspace(undefined);
    expect(result.ok ? null : result.error.message).toContain("AIMATOR_WORKSPACE");
  });

  it("should name --workspace as the other remedy", () => {
    const result = resolveWorkspace("   ");
    expect(result.ok ? null : result.error.message).toContain("--workspace");
  });
});

describe("projectPaths", () => {
  const workspace = { root: "/srv/aimator" };

  it("should place every stage-0 artifact under the project directory", () => {
    const result = projectPaths(workspace, "48-praw-wladzy");
    expect(result.ok ? result.data : null).toEqual({
      characters: "/srv/aimator/projects/48-praw-wladzy/characters",
      episodes: "/srv/aimator/projects/48-praw-wladzy/episodes",
      file: "/srv/aimator/projects/48-praw-wladzy/project.json",
      prepareStage: "/srv/aimator/projects/48-praw-wladzy/prepare.stage.json",
      root: "/srv/aimator/projects/48-praw-wladzy",
      rules: "/srv/aimator/projects/48-praw-wladzy/project.md",
    });
  });

  it("should accept an id starting with a digit", () => {
    expect(projectPaths(workspace, "48laws").ok).toBe(true);
  });

  it("should reject an id that does not start with a letter or digit", () => {
    const result = projectPaths(workspace, "-nope");
    expect(result.ok ? null : result.error.message).toContain("-nope");
  });

  it("should reject an id containing a path separator", () => {
    expect(projectPaths(workspace, "../escape").ok).toBe(false);
  });

  it("should reject an id containing non-ASCII letters", () => {
    expect(projectPaths(workspace, "władza").ok).toBe(false);
  });
});

describe("characterPaths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");

  it("should give each cast member its own directory and sources", () => {
    const result = project.ok ? characterPaths(project.data, "ewa") : null;
    expect(result?.ok ? result.data : null).toEqual({
      root: "/srv/aimator/projects/demo/characters/ewa",
      sources: "/srv/aimator/projects/demo/characters/ewa/sources",
    });
  });

  it("should reject a character id that could escape the project", () => {
    expect(project.ok ? characterPaths(project.data, "../..").ok : null).toBe(false);
  });
});

describe("characterTrackPaths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");
  const character = project.ok ? characterPaths(project.data, "ewa") : null;
  const track = character?.ok ? characterTrackPaths(character.data, "seedream") : null;
  const root = "/srv/aimator/projects/demo/characters/ewa/seedream";

  it("should hold the whole track under one directory", () => {
    expect(track).toEqual({
      card: `${root}/card.png`,
      hero: `${root}/hero.png`,
      lock: `${root}/character.lock`,
      root,
      runs: `${root}/runs`,
      stage: `${root}/character.stage.json`,
      views: `${root}/views`,
    });
  });

  /** Rule 2: the track is a directory level, never a filename prefix. */
  it("should name the two tracks identically inside their own directories", () => {
    const other = character?.ok ? characterTrackPaths(character.data, "gpt-image") : null;
    expect(other?.card.endsWith("/gpt-image/card.png")).toBe(true);
    expect(track?.card.endsWith("/seedream/card.png")).toBe(true);
  });

  it("should place a view inside the track's views directory", () => {
    const view = track === null ? null : characterViewImage(track, "three-quarter-left");
    expect(view?.ok ? view.data : null).toBe(`${root}/views/three-quarter-left.png`);
  });

  it("should reject a view name that is not a plain identifier", () => {
    expect(track === null ? null : characterViewImage(track, "../hero").ok).toBe(false);
  });

  it("should keep one run archive per track, keyed by run id", () => {
    const run = track === null ? null : imageRunPaths(track, "20260918T110000Z-abcd1234");
    expect(run?.root).toBe(`${root}/runs/20260918T110000Z-abcd1234`);
    expect(run?.image).toBe(`${root}/runs/20260918T110000Z-abcd1234/original.png`);
  });
});

describe("episodePaths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");
  const episode = "/srv/aimator/projects/demo/episodes/01-arrival";

  it("should place every episode artifact under the episode directory", () => {
    const result = project.ok ? episodePaths(project.data, "01-arrival") : null;
    expect(result?.ok ? result.data : null).toEqual({
      file: `${episode}/episode.json`,
      prepareStage: `${episode}/prepare.stage.json`,
      promptPackage: `${episode}/prompt-package.json`,
      promptPackageLock: `${episode}/prompt-package.lock`,
      promptPackageStage: `${episode}/prompt-package.stage.json`,
      prompts: `${episode}/prompts`,
      root: episode,
      runs: `${episode}/runs`,
      screenplay: `${episode}/screenplay.md`,
      screenplayLock: `${episode}/screenplay.lock`,
      screenplayStage: `${episode}/screenplay.stage.json`,
      shotList: `${episode}/shot-list.md`,
      shotListLock: `${episode}/shot-list.lock`,
      shotListStage: `${episode}/shot-list.stage.json`,
      source: `${episode}/source.md`,
    });
  });

  it("should reject an episode id containing a path separator", () => {
    const result = project.ok ? episodePaths(project.data, "../../etc") : null;
    expect(result?.ok).toBe(false);
  });

  it("should archive an attempt under the episode's shared runs directory", () => {
    const paths = project.ok ? episodePaths(project.data, "01-arrival") : null;
    const run = paths?.ok ? runPaths(paths.data, "20260918T090000Z-abcd1234") : null;

    expect(run?.root).toBe(`${episode}/runs/20260918T090000Z-abcd1234`);
    expect(run?.prompt).toBe(`${run?.root}/prompt.md`);
    expect(run?.run).toBe(`${run?.root}/run.json`);
  });
});

describe("episodeTrackPaths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");
  const paths = project.ok ? episodePaths(project.data, "01-arrival") : null;
  const track = paths?.ok ? episodeTrackPaths(paths.data, "seedream") : null;
  const root = "/srv/aimator/projects/demo/episodes/01-arrival/seedream";

  it("should place every per-track artifact under the track directory", () => {
    expect(track).toEqual({
      clips: `${root}/clips`,
      clipsLock: `${root}/clips.lock`,
      clipsStage: `${root}/clips.stage.json`,
      frames: `${root}/frames`,
      openingFrameImage: `${root}/opening-frame.png`,
      openingFrameLock: `${root}/opening-frame.lock`,
      openingFrameStage: `${root}/opening-frame.stage.json`,
      references: `${root}/references`,
      referencesLock: `${root}/references.lock`,
      referencesStage: `${root}/references.stage.json`,
      root,
      runs: `${root}/runs`,
    });
  });

  /**
   * Rule 1: one state filename per stage, `<stage>.stage.json`. The track
   * directory holds more than one stage from stage 6 on, so neither file may be
   * the unqualified `stage` it was when stage 5 was the only writer here.
   */
  it("should give each stage its own state file and lock", () => {
    expect(track?.referencesStage.endsWith("/references.stage.json")).toBe(true);
    expect(track?.openingFrameStage.endsWith("/opening-frame.stage.json")).toBe(true);
    expect(track?.referencesLock).not.toBe(track?.openingFrameLock);
  });

  /** Rule 2: the track is a directory level, never a filename prefix. */
  it("should name the two tracks identically inside their own directories", () => {
    const other = paths?.ok ? episodeTrackPaths(paths.data, "gpt-image") : null;
    expect(other?.referencesStage.endsWith("/gpt-image/references.stage.json")).toBe(true);
    expect(track?.referencesStage.endsWith("/seedream/references.stage.json")).toBe(true);
    expect(other?.openingFrameImage.endsWith("/gpt-image/opening-frame.png")).toBe(true);
    expect(track?.openingFrameImage.endsWith("/seedream/opening-frame.png")).toBe(true);
  });

  it("should give a reference its own file inside the track", () => {
    const image = track === null ? null : referenceImage(track, "R07");
    expect(image?.ok ? image.data : null).toBe(`${root}/references/R07.png`);
  });

  it("should reject a reference id that is not a numbered artifact", () => {
    expect(track === null ? null : referenceImage(track, "../hero").ok).toBe(false);
  });

  it("should archive an attempt under the track's own runs directory", () => {
    const run = track === null ? null : imageRunPaths(track, "20260918T110000Z-abcd1234");
    expect(run?.root).toBe(`${root}/runs/20260918T110000Z-abcd1234`);
    expect(run?.response).toBe(`${run?.root}/response.json`);
  });
});

describe("episodeIdFromSource", () => {
  it("should derive id and number from the source filename", () => {
    const result = episodeIdFromSource("01-NEVER OUTSHINE THE MASTER.md");
    expect(result.ok ? result.data : null).toEqual({
      id: "01-never-outshine-the-master",
      number: 1,
    });
  });

  it("should strip Polish diacritics", () => {
    const result = episodeIdFromSource("07-Zdobądź Władzę.md");
    expect(result.ok ? result.data.id : null).toBe("07-zdobadz-wladze");
  });

  it("should keep the number padded exactly as written", () => {
    const result = episodeIdFromSource("003-Trzeci.md");
    expect(result.ok ? result.data : null).toEqual({ id: "003-trzeci", number: 3 });
  });

  it("should accept an underscore separator", () => {
    expect(episodeIdFromSource("02_Second.md").ok).toBe(true);
  });

  it("should reject a filename that does not start with a number", () => {
    const result = episodeIdFromSource("intro.md");
    expect(result.ok ? null : result.error.message).toContain("01-");
  });

  it("should reject a non-markdown source", () => {
    expect(episodeIdFromSource("01-intro.txt").ok).toBe(false);
  });

  it("should reject episode number zero", () => {
    expect(episodeIdFromSource("00-zero.md").ok).toBe(false);
  });

  it("should reject a title that slugifies to nothing", () => {
    expect(episodeIdFromSource("01-!!!.md").ok).toBe(false);
  });
});

describe("stage 7 paths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");
  const paths = project.ok ? episodePaths(project.data, "01-arrival") : null;
  const track = paths?.ok ? episodeTrackPaths(paths.data, "seedream") : null;
  const root = "/srv/aimator/projects/demo/episodes/01-arrival/seedream";

  /** Rule 1: one state file per stage, and stage 7 writes both media into it. */
  it("should give the clips stage its own state file and lock", () => {
    expect(track?.clipsStage).toBe(`${root}/clips.stage.json`);
    expect(track?.clipsLock).toBe(`${root}/clips.lock`);
  });

  it("should place a clip's video under the track's clips directory", () => {
    const video = track === null ? null : clipVideo(track, "C03");
    expect(video?.ok ? video.data : null).toBe(`${root}/clips/C03.mp4`);
  });

  /**
   * A clip's frames are a directory because there are two of them: the entry
   * frame stage 7 draws and the end frame the finished clip hands back.
   */
  it("should give each clip its own frame directory", () => {
    const entry = track === null ? null : clipFrame(track, "C03", "entry");
    const end = track === null ? null : clipFrame(track, "C03", "end");
    expect(entry?.ok ? entry.data : null).toBe(`${root}/frames/C03/entry.png`);
    expect(end?.ok ? end.data : null).toBe(`${root}/frames/C03/end.png`);
  });

  it("should reject a clip id that is not a numbered artifact", () => {
    expect(track === null ? null : clipVideo(track, "../C03").ok).toBe(false);
    expect(track === null ? null : clipFrame(track, "entry:C03", "entry").ok).toBe(false);
  });

  /**
   * A video attempt archives the same six files an image attempt does, plus the
   * two the provider hands back: the clip itself and its final frame.
   */
  it("should archive a video attempt beside the image attempts of this track", () => {
    const run = track === null ? null : videoRunPaths(track, "20260919T110000Z-abcd1234");
    expect(run?.root).toBe(`${root}/runs/20260919T110000Z-abcd1234`);
    expect(run?.video).toBe(`${run?.root}/original.mp4`);
    expect(run?.endFramePng).toBe(`${run?.root}/last-frame.png`);
    expect(run?.endFrameJpeg).toBe(`${run?.root}/last-frame.jpg`);
    expect(run?.previousVideo).toBe(`${run?.root}/previous.mp4`);
    expect(run?.response).toBe(`${run?.root}/response.json`);
  });
});
