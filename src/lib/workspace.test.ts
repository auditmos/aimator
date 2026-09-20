import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assemblyRunPaths,
  characterPaths,
  characterTrackPaths,
  characterViewImage,
  clipFrame,
  clipVideo,
  episodeIdFromSource,
  episodePaths,
  episodeTrackPaths,
  imageRunPaths,
  narrationAudio,
  projectPaths,
  referenceImage,
  resolveWorkspace,
  runPaths,
  soundtrackRunPaths,
  videoRunPaths,
  voiceRunPaths,
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

  /**
   * Not every file here is stage 0's. `narration.json` is stage 9's own
   * decision, kept at the project level because a reading recurs between
   * episodes — and kept *beside* `project.json` rather than inside it because
   * stage 0's file is a recorded input of nearly every artifact, so a knob
   * somebody is expected to turn would lapse approvals its bytes never touched.
   */
  it("should place every project-level file under the project directory", () => {
    const result = projectPaths(workspace, "48-praw-wladzy");
    expect(result.ok ? result.data : null).toEqual({
      characters: "/srv/aimator/projects/48-praw-wladzy/characters",
      episodes: "/srv/aimator/projects/48-praw-wladzy/episodes",
      file: "/srv/aimator/projects/48-praw-wladzy/project.json",
      narration: "/srv/aimator/projects/48-praw-wladzy/narration.json",
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
      narration: `${episode}/narration`,
      narrationLock: `${episode}/narration.lock`,
      narrationScript: `${episode}/narration.md`,
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
      soundtrackStage: `${episode}/soundtrack.stage.json`,
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
      assemblyLock: `${root}/assembly.lock`,
      assemblyStage: `${root}/assembly.stage.json`,
      clips: `${root}/clips`,
      clipsLock: `${root}/clips.lock`,
      clipsStage: `${root}/clips.stage.json`,
      episodeVideo: `${root}/episode.mp4`,
      frames: `${root}/frames`,
      narratedVideo: `${root}/narrated.mp4`,
      openingFrameImage: `${root}/opening-frame.png`,
      openingFrameLock: `${root}/opening-frame.lock`,
      openingFrameStage: `${root}/opening-frame.stage.json`,
      references: `${root}/references`,
      referencesLock: `${root}/references.lock`,
      referencesStage: `${root}/references.stage.json`,
      root,
      runs: `${root}/runs`,
      soundtrackLock: `${root}/soundtrack.lock`,
      soundtrackStage: `${root}/soundtrack.stage.json`,
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

describe("stage 8 paths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");
  const paths = project.ok ? episodePaths(project.data, "01-arrival") : null;
  const track = paths?.ok ? episodeTrackPaths(paths.data, "seedream") : null;
  const root = "/srv/aimator/projects/demo/episodes/01-arrival/seedream";

  /**
   * The cut is a per-track artifact for the same reason every image below stage
   * 4 is: the two productions hold identically named files and neither needs a
   * prefix to stay out of the other's way.
   */
  it("should place the episode cut and its state file inside the track", () => {
    expect(track?.episodeVideo).toBe(`${root}/episode.mp4`);
    expect(track?.assemblyStage).toBe(`${root}/assembly.stage.json`);
    expect(track?.assemblyLock).toBe(`${root}/assembly.lock`);
  });

  /**
   * Nothing is sent, so the archive holds neither a request nor a response. It
   * holds the two things a re-run cannot reconstruct — which muxer ran, with
   * which arguments, and what it said — plus the verdict of the moment.
   */
  it("should archive a local attempt without a request or a response", () => {
    const run = track === null ? null : assemblyRunPaths(track, "20260919T110000Z-abcd1234");
    expect(run?.root).toBe(`${root}/runs/20260919T110000Z-abcd1234`);
    expect(run?.run).toBe(`${run?.root}/run.json`);
    expect(run?.transport).toBe(`${run?.root}/transport.json`);
    expect(run?.validation).toBe(`${run?.root}/validation.json`);
    expect(run?.previousVideo).toBe(`${run?.root}/previous.mp4`);
    expect(run?.list).toBe(`${run?.root}/concat.txt`);
  });
});

describe("stage 9 paths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");
  const paths = project.ok ? episodePaths(project.data, "01-arrival") : null;
  const track = paths?.ok ? episodeTrackPaths(paths.data, "seedream") : null;
  const episode = "/srv/aimator/projects/demo/episodes/01-arrival";
  const root = `${episode}/seedream`;

  /**
   * The words sit at the episode level, with no track directory, for the reason
   * the screenplay and the shot list do: they describe the story rather than
   * the pictures. The spoken bytes sit beside them because they depend on the
   * text, the voice and the speech model — and not one of those three differs
   * per track. A voice reading a sentence has no idea which of the two films it
   * will sit over, so buying it twice would be paying for a directory.
   */
  it("should keep the script and the spoken lines shared between the tracks", () => {
    expect(paths?.ok ? paths.data.narrationScript : null).toBe(`${episode}/narration.md`);
    expect(paths?.ok ? paths.data.narration : null).toBe(`${episode}/narration`);
    expect(paths?.ok ? paths.data.soundtrackStage : null).toBe(`${episode}/soundtrack.stage.json`);
    expect(paths?.ok ? paths.data.narrationLock : null).toBe(`${episode}/narration.lock`);
  });

  it("should give an utterance its own file beside the others", () => {
    const line = paths?.ok ? narrationAudio(paths.data, "N02") : null;
    expect(line?.ok ? line.data : null).toBe(`${episode}/narration/N02.wav`);
  });

  it("should reject an utterance id that is not a numbered artifact", () => {
    const line = paths?.ok ? narrationAudio(paths.data, "../escape") : null;
    expect(line?.ok).toBe(false);
  });

  /**
   * The mix is the one half of stage 9 that is per track, and it has to be:
   * it is timed against that track's own cut, whose clips came back with their
   * own drift. Two tracks are two films of one story and neither is "the
   * episode" — so neither is "the soundtrack" either.
   */
  it("should place the narrated cut and its state file inside the track", () => {
    expect(track?.narratedVideo).toBe(`${root}/narrated.mp4`);
    expect(track?.soundtrackStage).toBe(`${root}/soundtrack.stage.json`);
    expect(track?.soundtrackLock).toBe(`${root}/soundtrack.lock`);
  });

  /**
   * A bought utterance archives beside the text stages, under the episode,
   * because that is where it was bought — one `runs/` per level, and the run id
   * says which stage minted it.
   */
  it("should archive a speech attempt under the episode's shared runs directory", () => {
    const run = paths?.ok ? voiceRunPaths(paths.data, "20260919T110000Z-abcd1234") : null;
    expect(run?.root).toBe(`${episode}/runs/20260919T110000Z-abcd1234`);
    expect(run?.audio).toBe(`${run?.root}/original.wav`);
    expect(run?.previousAudio).toBe(`${run?.root}/previous.wav`);
    expect(run?.request).toBe(`${run?.root}/request.json`);
    expect(run?.response).toBe(`${run?.root}/response.json`);
    expect(run?.transport).toBe(`${run?.root}/transport.json`);
    expect(run?.validation).toBe(`${run?.root}/validation.json`);
  });

  /**
   * The mix archives what stage 8's does and one thing more: where each line
   * was laid down. The placement is arithmetic, so it could be recomputed —
   * but it is also what the engine was actually told, and an archive holding
   * the arguments without it would record half the invocation.
   */
  it("should archive a mix without a request or a response", () => {
    const run = track === null ? null : soundtrackRunPaths(track, "20260919T110000Z-abcd1234");
    expect(run?.root).toBe(`${root}/runs/20260919T110000Z-abcd1234`);
    expect(run?.run).toBe(`${run?.root}/run.json`);
    expect(run?.transport).toBe(`${run?.root}/transport.json`);
    expect(run?.validation).toBe(`${run?.root}/validation.json`);
    expect(run?.placement).toBe(`${run?.root}/placement.json`);
    expect(run?.previousVideo).toBe(`${run?.root}/previous.mp4`);
  });
});
