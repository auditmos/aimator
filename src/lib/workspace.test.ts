import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { episodeIdFromSource, episodePaths, projectPaths, resolveWorkspace } from "./workspace.js";

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
      characterSources: "/srv/aimator/projects/48-praw-wladzy/character/sources",
      episodes: "/srv/aimator/projects/48-praw-wladzy/episodes",
      file: "/srv/aimator/projects/48-praw-wladzy/project.json",
      root: "/srv/aimator/projects/48-praw-wladzy",
      rules: "/srv/aimator/projects/48-praw-wladzy/project.md",
      stage: "/srv/aimator/projects/48-praw-wladzy/prepare.stage.json",
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

describe("episodePaths", () => {
  const project = projectPaths({ root: "/srv/aimator" }, "demo");

  it("should place every episode artifact under the episode directory", () => {
    const result = project.ok ? episodePaths(project.data, "01-arrival") : null;
    expect(result?.ok ? result.data : null).toEqual({
      file: "/srv/aimator/projects/demo/episodes/01-arrival/episode.json",
      root: "/srv/aimator/projects/demo/episodes/01-arrival",
      source: "/srv/aimator/projects/demo/episodes/01-arrival/source.md",
      stage: "/srv/aimator/projects/demo/episodes/01-arrival/prepare.stage.json",
    });
  });

  it("should reject an episode id containing a path separator", () => {
    const result = project.ok ? episodePaths(project.data, "../../etc") : null;
    expect(result?.ok).toBe(false);
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
