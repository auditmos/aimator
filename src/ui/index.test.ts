import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../cli/index.js";
import { episodePaths, projectPaths, resolveWorkspace, type Workspace } from "../lib/workspace.js";
import {
  EPISODE,
  makeCut,
  makeNarration,
  makeSoundDesign,
  makeUpstream,
  PROJECT,
  VOICE,
} from "../test/fixture.js";
import { INTENTS } from "./commands.js";
import { createUi } from "./index.js";

/**
 * The server, tested by calling it rather than by opening a port.
 *
 * What it promises is small and the tests say exactly it: **the CLI is the only
 * contract.** Every answer here is a `run(argv)` this tool already had, so
 * there is nothing for the server to get right except the argv it builds and
 * the envelope it puts the answer in. If a route ever computes a verdict of
 * its own, the UI has become the second road this project exists not to build.
 *
 * Assumptions this file encodes:
 *
 * - **The workspace is injected**, exactly as `lib/assembly` takes its muxer,
 *   which is what lets these tests run on a fixture and the process entry read
 *   `AIMATOR_WORKSPACE` without either knowing about the other.
 * - **A refusal keeps its words.** `Result` carries the message a terminal
 *   would print, so the response carries the same string, unchanged; the
 *   status code says who is at fault and nothing else.
 * - **Nothing here writes.** This slice serves the ladder and the listing;
 *   running commands and serving artifacts are the rows below it.
 *
 * Not tested here: the client, apart from its readers, which have their own file
 * beside them. Everything else there is verified in a browser, per the issue.
 */

vi.mock("../lib/env.js", () => ({ env: { AIMATOR_FFMPEG: "/nonexistent/aimator-ffmpeg" } }));

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** The one track this fixture draws to the end. */
const TRACK = "gpt-image";

/** What the terminal would print for the same question. */
async function cli(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

interface Frame {
  readonly data: string;
  readonly event: string;
}

/** A frame of the event stream, read off the socket and put back together. */
class Events {
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(): Promise<Frame> {
    while (!this.buffered.includes("\n\n")) {
      // biome-ignore lint/performance/noAwaitInLoops: a stream arrives in order
      const { done, value } = await this.reader.read();

      if (done) {
        throw new Error("strumień zdarzeń zamknął się bez zdarzenia");
      }

      this.buffered += this.decoder.decode(value, { stream: true });
    }

    const [frame = "", ...rest] = this.buffered.split("\n\n");
    this.buffered = rest.join("\n\n");
    const lines = frame.split("\n");

    return {
      data: lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n"),
      event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "",
    };
  }

  /** The next frame of one kind, skipping the ladder pushed on the way. */
  async nextOf(event: string): Promise<Frame> {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: a stream arrives in order
      const frame = await this.next();

      if (frame.event === event) {
        return frame;
      }
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

/** The episode's own directory, the one a stage writes into. */
function episodeRoot(): string {
  const project = projectPaths(workspace, PROJECT);

  if (!project.ok) {
    throw project.error;
  }

  const episode = episodePaths(project.data, EPISODE);

  if (!episode.ok) {
    throw episode.error;
  }

  return episode.data.root;
}

/**
 * A manifest stage 4 can actually publish, which the earlier one could not.
 *
 * Two things the stage refuses over were missing: a package with no reference
 * at all, and clips naming one of the two faces the shots put on screen. Both
 * left the stage `submitted`, which is a fixture quietly one stage shorter
 * than it claims to be, and unnoticeable until something asked for the file.
 */
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-ui-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-ui-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;
  // Narrated, and with a voice cast: stage 9 lifts the narrator's sentences
  // out of the shots' own `Audio` prose, so an episode that says nothing has
  // no script to buy and no gate to show.
  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    narration: true,
    root,
    scratch,
    voiceId: VOICE,
    workspace,
  });
  // One track drawn to the end and cut, so the resolver has real pictures and
  // a real film to serve, and the ladder has more than one kind of cell in it.
  // The cut is made with the fixture's own muxer, which is why it exists on a
  // machine whose `AIMATOR_FFMPEG` points at nothing: what the engine's
  // absence changes is what stage 8 will *do*, not what is already on disk.
  await makeCut({ root, track: TRACK, workspace });
  // Stage 9's words, bought and accepted, and laid on that one track: the
  // resolver has a script to read, recordings to play and a narrated cut to
  // watch, which are three different media under one stage.
  await makeNarration({ root, tracks: [TRACK], workspace });
  // Stage 10 on top of it, which is what makes the ladder end the way a
  // finished episode ends: a cue sheet, two stems and the film with every
  // sound it has.
  await makeSoundDesign({ tracks: [TRACK], workspace });
}, 180_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("the UI server", () => {
  it("should answer the ladder with exactly what status --json prints", async () => {
    const response = await createUi({ workspace }).request(`/api/status/${PROJECT}/${EPISODE}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      JSON.parse(await cli("status", PROJECT, EPISODE, "--json"))
    );
  });

  it("should answer the picker with exactly what list --json prints", async () => {
    const response = await createUi({ workspace }).request("/api/projects");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(await cli("list", "--json")));
  });

  it("should hand a refusal over in the words the terminal would print", async () => {
    const response = await createUi({ workspace }).request("/api/status/nie-ma/01-burza");
    const refused = await run(["status", "nie-ma", "01-burza", "--json", "--workspace", root]);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: refused.ok ? "" : refused.error.message,
        name: refused.ok ? "" : refused.error.name,
      },
    });
  });

  it("should open the stream with the ladder as it is right now", async () => {
    const response = await createUi({ workspace }).request(`/api/events/${PROJECT}/${EPISODE}`);

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = new Events(response.body as ReadableStream<Uint8Array>);
    const first = await events.next();

    expect(JSON.parse(first.data)).toEqual(
      JSON.parse(await cli("status", PROJECT, EPISODE, "--json"))
    );
    await events.close();
  });

  it("should open the workspace stream with the listing as it is right now", async () => {
    const response = await createUi({ workspace }).request("/api/events");

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = new Events(response.body as ReadableStream<Uint8Array>);
    const first = await events.next();

    expect(first.event).toBe("listing");
    expect(JSON.parse(first.data)).toEqual(JSON.parse(await cli("list", "--json")));
    await events.close();
  });

  /**
   * The deadline here is not the contract's.
   *
   * What a person is promised is a refreshed ladder within two seconds of a
   * file changing, and that is measured where it means something: a browser on
   * a real workspace. A deadline asserted inside a runner working through
   * forty-odd files at once would measure the runner instead, and would fail
   * on a busy machine while the server was behaving perfectly. So what this
   * test holds is the claim a test can hold honestly: the write reaches the
   * stream at all, and what arrives is the ladder rather than a heartbeat.
   */
  it("should push the ladder again when a file under the episode changes", {
    timeout: 45_000,
  }, async () => {
    const response = await createUi({ workspace }).request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(response.body as ReadableStream<Uint8Array>);

    await events.next();
    await writeFile(join(episodeRoot(), "poke.txt"), "ktoś coś zapisał\n", "utf8");

    const pushed = await Promise.race([
      events.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("strumień nie wypchnął drabiny")), 35_000)
      ),
    ]);

    expect(JSON.parse(pushed.data)).toMatchObject({ command: "status", episodeId: EPISODE });
    await events.close();
  });
});

/**
 * The one place in this module where an identifier becomes a path.
 *
 * The client addresses an artifact by what it is, the project, the stage, the
 * stage's own word for it and whichever axes that stage has, and never by
 * where it lives, because the layout is `workspace.ts`'s to know and a browser
 * that learned it would be reading the tree twice. What this resolver owes is
 * therefore narrow and absolute: a tuple that names something the layout knows
 * becomes its bytes, and anything else is a 404 rather than a path walked out
 * of the workspace.
 *
 * The axes are why an episode travels beside the path rather than in it. A
 * screenplay lives under an episode and a character's card lives under a
 * character and a track and under no episode at all, so a segment every caller
 * had to fill in with something meaningless would be an identifier that lies.
 */
describe("the artifact resolver", () => {
  it("should serve the screenplay as the markdown it is", async () => {
    const response = await createUi({ workspace }).request(
      `/api/artifact/${PROJECT}/screenplay/screenplay?episode=${EPISODE}`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe(
      await readFile(join(episodeRoot(), "screenplay.md"), "utf8")
    );
  });

  it("should serve each text stage's artifact with the type it actually is", async () => {
    const app = createUi({ workspace });
    const [shotList, manifest] = await Promise.all(
      [
        `/api/artifact/${PROJECT}/shot-list/shot-list?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/prompt-package/manifest?episode=${EPISODE}`,
      ].map(async (path) => {
        const response = await app.request(path);

        return { body: await response.text(), type: response.headers.get("content-type") ?? "" };
      })
    );

    expect(shotList?.type).toContain("text/markdown");
    expect(shotList?.body).toBe(await readFile(join(episodeRoot(), "shot-list.md"), "utf8"));
    expect(manifest?.type).toContain("application/json");
    expect(JSON.parse(manifest?.body ?? "")).toMatchObject({ clips: expect.anything() });
  });

  /**
   * The first artifact a person has to **look** at rather than read.
   *
   * Approving an image in a terminal is approving a filename, which is the
   * gap this whole module exists to close, so the bytes come back as the PNG
   * they are and the browser draws them.
   */
  it("should serve a character's image as the png it is, per character and per track", async () => {
    const app = createUi({ workspace });
    const response = await app.request(
      `/api/artifact/${PROJECT}/character/hero?character=ewa&track=gpt-image`
    );
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(bytes).toEqual(
      await readFile(join(root, "projects", PROJECT, "characters", "ewa", "gpt-image", "hero.png"))
    );
  });

  /**
   * Stages 5 and 6, which are the same two axes as stage 2 rearranged.
   *
   * A reference and the opening frame are under an episode **and** a track,
   * where a character's card is under a character and a track. That is the
   * whole reason the axes travel separately: each stage reads the ones it has,
   * and no caller fills in a segment that means nothing for the artifact it is
   * asking about.
   */
  it("should serve a track's own pictures as the png they are", async () => {
    const app = createUi({ workspace });
    const [reference, opening] = await Promise.all(
      [
        `/api/artifact/${PROJECT}/references/R01?episode=${EPISODE}&track=${TRACK}`,
        `/api/artifact/${PROJECT}/opening-frame/opening-frame?episode=${EPISODE}&track=${TRACK}`,
      ].map(async (path) => {
        const response = await app.request(path);

        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          status: response.status,
          type: response.headers.get("content-type") ?? "",
        };
      })
    );

    expect([reference?.status, opening?.status]).toEqual([200, 200]);
    expect([reference?.type, opening?.type]).toEqual(["image/png", "image/png"]);
    expect(reference?.bytes).toEqual(
      await readFile(join(episodeRoot(), TRACK, "references", "R01.png"))
    );
    expect(opening?.bytes).toEqual(await readFile(join(episodeRoot(), TRACK, "opening-frame.png")));
  });

  /**
   * Stage 7, the first artifact a person has to **watch** rather than look at.
   *
   * Its two media are one review and one list, so they are one stage's word
   * apiece under one tuple: a clip is its own id, an entry frame carries the
   * `entry:` the CLI already spells in `--artifact`. Nothing here learns that a
   * clip is an MP4 and a frame is a PNG from the bytes; both come from the
   * layout module, which is the only place either name is written down.
   */
  it("should serve a clip as the film it is and its entry frame as the png", async () => {
    const app = createUi({ workspace });
    const [clip, entry] = await Promise.all(
      [
        `/api/artifact/${PROJECT}/clips/C01?episode=${EPISODE}&track=${TRACK}`,
        `/api/artifact/${PROJECT}/clips/${encodeURIComponent("entry:C02")}?episode=${EPISODE}&track=${TRACK}`,
      ].map(async (path) => {
        const response = await app.request(path);

        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          ranges: response.headers.get("accept-ranges") ?? "",
          status: response.status,
          type: response.headers.get("content-type") ?? "",
        };
      })
    );

    expect([clip?.status, entry?.status]).toEqual([200, 200]);
    expect([clip?.type, entry?.type]).toEqual(["video/mp4", "image/png"]);
    expect(clip?.bytes).toEqual(await readFile(join(episodeRoot(), TRACK, "clips", "C01.mp4")));
    expect(entry?.bytes).toEqual(
      await readFile(join(episodeRoot(), TRACK, "frames", "C02", "entry.png"))
    );
    // Said on the whole file as well as on a slice: a player asks for the
    // first bytes and decides from this header whether it may seek at all.
    expect([clip?.ranges, entry?.ranges]).toEqual(["bytes", "bytes"]);
  });

  /**
   * Seeking, which is the whole difference between a film and a download.
   *
   * A browser that cannot ask for the middle of a file plays a clip from the
   * start or not at all, so approving a twelfth second means watching eleven.
   * The answer is the ordinary one HTTP already has, and it is the server's to
   * get right rather than the player's: the bytes that were asked for, the
   * range they came from, and 206 rather than 200, because a player reading
   * 200 believes it was handed the whole film and stops asking.
   */
  it("should answer a Range request with exactly the bytes it names", async () => {
    const whole = await readFile(join(episodeRoot(), TRACK, "clips", "C01.mp4"));
    const response = await createUi({ workspace }).request(
      `/api/artifact/${PROJECT}/clips/C01?episode=${EPISODE}&track=${TRACK}`,
      { headers: { range: "bytes=16-47" } }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 16-47/${whole.length}`);
    expect(response.headers.get("content-length")).toBe("32");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(whole.subarray(16, 48));
  });

  /** A range past the end is answered, not guessed at: 416 and the real size. */
  it("should refuse a range the file does not have", async () => {
    const whole = await readFile(join(episodeRoot(), TRACK, "clips", "C01.mp4"));
    const response = await createUi({ workspace }).request(
      `/api/artifact/${PROJECT}/clips/C01?episode=${EPISODE}&track=${TRACK}`,
      { headers: { range: `bytes=${whole.length}-` } }
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${whole.length}`);
  });

  /**
   * Stage 8, the first artifact that is the **whole film** rather than a piece.
   *
   * It is served exactly as a clip is, and the sameness is the point: the cut
   * is one more thing a person has to watch before saying yes, and the only
   * difference is that there is one of it per track. So the stage's own word
   * for it is the id `--artifact` would take, and the layout module decides
   * that it is an MP4.
   */
  it("should serve the cut as the film it is, per track", async () => {
    const response = await createUi({ workspace }).request(
      `/api/artifact/${PROJECT}/assembly/episode?episode=${EPISODE}&track=${TRACK}`
    );
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(bytes).toEqual(await readFile(join(episodeRoot(), TRACK, "episode.mp4")));
  });

  /**
   * Stage 9, the first stage whose artifacts live at **two levels** and in
   * three media at once.
   *
   * The words are shared between the tracks, so the script and every bought
   * line resolve without one; the mix is per track, because only the mix is
   * timed against a particular cut. A resolver that put a track on all three
   * would have invented a second copy of the recordings, and one that put a
   * track on none of them would have served one film's narration over the
   * other's picture.
   *
   * The WAV is the point of the whole row. An utterance is approved by
   * **listening** to it, and approving a recording in a terminal is approving
   * a filename, exactly as approving an image there was at stage 2.
   */
  it("should serve stage 9's three media, each at the level it lives at", async () => {
    const app = createUi({ workspace });
    const [script, line, narrated] = await Promise.all(
      [
        `/api/artifact/${PROJECT}/soundtrack/script?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/soundtrack/N01?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/soundtrack/narrated?episode=${EPISODE}&track=${TRACK}`,
      ].map(async (path) => {
        const response = await app.request(path);

        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          status: response.status,
          type: response.headers.get("content-type") ?? "",
        };
      })
    );

    expect([script?.status, line?.status, narrated?.status]).toEqual([200, 200, 200]);
    expect(script?.type).toContain("text/markdown");
    expect(line?.type).toBe("audio/wav");
    expect(narrated?.type).toBe("video/mp4");
    expect(script?.bytes).toEqual(await readFile(join(episodeRoot(), "narration.md")));
    expect(line?.bytes).toEqual(await readFile(join(episodeRoot(), "narration", "N01.wav")));
    expect(narrated?.bytes).toEqual(await readFile(join(episodeRoot(), TRACK, "narrated.mp4")));
  });

  /**
   * Stage 10, the same two levels one row down, and the one row that serves
   * **MP3**.
   *
   * The container is the provider's choice rather than this pipeline's:
   * neither the music endpoint nor the sound-effect one offers WAV at all. So
   * a stem is `audio/mpeg`, for the reason a recording is `audio/wav` and a
   * reference is `image/png`: a bed judged by its file name is a bed nobody
   * judged, and this is the row where a person finds out whether the music
   * fights the narrator.
   *
   * The cue sheet is shared and the full mix is not, exactly as the script and
   * `narrated.mp4` are, and for the same reason: only the mix is timed against
   * a particular cut.
   */
  it("should serve stage 10's three media, each at the level it lives at", async () => {
    const app = createUi({ workspace });
    const [cues, stem, mixed] = await Promise.all(
      [
        `/api/artifact/${PROJECT}/sound-design/cues?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/sound-design/M01?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/sound-design/mixed?episode=${EPISODE}&track=${TRACK}`,
      ].map(async (path) => {
        const response = await app.request(path);

        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          status: response.status,
          type: response.headers.get("content-type") ?? "",
        };
      })
    );

    expect([cues?.status, stem?.status, mixed?.status]).toEqual([200, 200, 200]);
    expect(cues?.type).toContain("text/markdown");
    expect(stem?.type).toBe("audio/mpeg");
    expect(mixed?.type).toBe("video/mp4");
    expect(cues?.bytes).toEqual(await readFile(join(episodeRoot(), "sound-design.md")));
    expect(stem?.bytes).toEqual(await readFile(join(episodeRoot(), "sound", "M01.mp3")));
    expect(mixed?.bytes).toEqual(await readFile(join(episodeRoot(), TRACK, "mixed.mp4")));
  });

  it("should answer 404 for anything the layout does not name, and leak nothing", async () => {
    const secret = join(scratch, "sekret.md");

    await writeFile(secret, "TAJNE\n", "utf8");

    const app = createUi({ workspace });
    const answers = await Promise.all(
      [
        `/api/artifact/${PROJECT}/screenplay/${encodeURIComponent("../../../../../../etc/passwd")}?episode=${EPISODE}`,
        `/api/artifact/${encodeURIComponent("..")}/screenplay/screenplay?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/screenplay/screenplay?episode=${encodeURIComponent("../..")}`,
        `/api/artifact/${PROJECT}/screenplay/${encodeURIComponent(secret)}?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/montaz/episode?episode=${EPISODE}`,
        // A character's image with no track named, and one with a track that
        // is not a track: neither becomes a path, both become a refusal.
        `/api/artifact/${PROJECT}/character/hero?character=ewa`,
        `/api/artifact/${PROJECT}/character/hero?character=ewa&track=${encodeURIComponent("../..")}`,
        `/api/artifact/${PROJECT}/character/hero?character=${encodeURIComponent("..")}&track=gpt-image`,
        `/api/artifact/${PROJECT}/character/${encodeURIComponent("../../../hero")}?character=ewa&track=gpt-image`,
        // A reference whose id is not a reference id, and a frame asked for
        // under a name stage 6 does not have: neither becomes a path.
        `/api/artifact/${PROJECT}/references/${encodeURIComponent("../../opening-frame")}?episode=${EPISODE}&track=${TRACK}`,
        `/api/artifact/${PROJECT}/opening-frame/R01?episode=${EPISODE}&track=${TRACK}`,
        // Stage 7 knows two words and neither of them is a reference's: a clip
        // id, and the same id under `entry:`. Anything else is a 404 before a
        // path exists, including the `end:` the chain talks about, whose format
        // is the provider's and therefore nothing this table may guess at.
        `/api/artifact/${PROJECT}/clips/R01?episode=${EPISODE}&track=${TRACK}`,
        `/api/artifact/${PROJECT}/clips/${encodeURIComponent("end:C01")}?episode=${EPISODE}&track=${TRACK}`,
        `/api/artifact/${PROJECT}/clips/${encodeURIComponent("entry:../../C01")}?episode=${EPISODE}&track=${TRACK}`,
        `/api/artifact/${PROJECT}/clips/C01?episode=${EPISODE}`,
        // Stage 8 has exactly one artifact per track and one word for it, so
        // there is nothing else its row may resolve to, and no track is no
        // path at all: the two films of one episode are two different films.
        `/api/artifact/${PROJECT}/assembly/C01?episode=${EPISODE}&track=${TRACK}`,
        `/api/artifact/${PROJECT}/assembly/episode?episode=${EPISODE}`,
        // Stage 9 lives at two levels and the resolver keeps them apart: the
        // mix needs a track and the words must not have one, because a second
        // copy of a recording per track is a recording nobody bought.
        `/api/artifact/${PROJECT}/soundtrack/narrated?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/soundtrack/${encodeURIComponent("../../N01")}?episode=${EPISODE}`,
        // Stage 10 the same way one row down: the full mix needs a track, a
        // stem id is a stem id, and neither answer is guessed at.
        `/api/artifact/${PROJECT}/sound-design/mixed?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/sound-design/${encodeURIComponent("../../M01")}?episode=${EPISODE}`,
        `/api/artifact/${PROJECT}/sound-design/N01?episode=${EPISODE}`,
      ].map(async (path) => {
        const response = await app.request(path);

        return { body: await response.text(), status: response.status };
      })
    );

    expect(answers.map((one) => one.status)).toEqual(Array.from({ length: 22 }, () => 404));
    expect(answers.every((one) => !one.body.includes("TAJNE"))).toBe(true);
  });

  /**
   * A film is handed over a piece at a time, because it is a film.
   *
   * What a cut weighs is decided by the episode rather than by this server: a
   * finished one runs minutes and carries both pictures and sound, so the
   * honest size to design for is hundreds of megabytes rather than the
   * kilobytes a fixture makes. An answer built by reading the whole file into
   * one buffer costs that much memory for as long as the response is alive,
   * and it is exactly as wrong for the request it was written for, the one
   * with no `Range` header, which is the request a download link makes.
   *
   * So what is asserted is the shape of the handover rather than a number of
   * bytes anybody measured: a body that arrives in one piece **is** the whole
   * file in memory, and a body that arrives in several is the file being read
   * as it is sent. The same change is what makes a short read impossible to
   * paper over, because a stream ends when the file does rather than when a
   * pre-sized buffer is full.
   */
  it("should hand a film over in pieces rather than hold it whole", async () => {
    const cut = join(episodeRoot(), TRACK, "episode.mp4");
    const original = await readFile(cut);

    // Larger than one read of a stream, so "several pieces" is a claim about
    // the handover and not about the fixture's size.
    await writeFile(cut, Buffer.alloc(512 * 1024, 7));

    try {
      const response = await createUi({ workspace }).request(
        `/api/artifact/${PROJECT}/assembly/episode?episode=${EPISODE}&track=${TRACK}`
      );
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let pieces = 0;
      let bytes = 0;

      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: a body arrives in order
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        pieces += 1;
        bytes += value.byteLength;
      }

      expect(bytes).toBe(512 * 1024);
      expect(pieces).toBeGreaterThan(1);
    } finally {
      await writeFile(cut, original);
    }
  });
});

/**
 * A command started here, and answered where the ladder is answered.
 *
 * The request returns an identifier and nothing else, because the clip stage
 * polls a provider for minutes and a browser that waited for it would be a
 * browser that cannot show anything else meanwhile. The result arrives on the
 * stream the episode already has open: one connection, one order of events,
 * and no window in which a result exists and has nowhere to go.
 *
 * The server does not read the argv it is handed. Which command is legal is
 * the CLI's answer, given by refusing, and a second opinion here would be the
 * private road `imports.test.ts` exists to prevent.
 */
describe("running a command", () => {
  it("should answer with a run id at once and deliver the result as an event", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: ["check", PROJECT, EPISODE, "--stage", "screenplay", "--json"],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(started.status).toBe(202);

    const { runId } = (await started.json()) as { runId: string };

    expect(runId).not.toBe("");

    const finished = await events.nextOf("run");

    expect(JSON.parse(finished.data)).toEqual({
      data: await cli("check", PROJECT, EPISODE, "--stage", "screenplay", "--json"),
      ok: true,
      runId,
    });
    await events.close();
  });

  /**
   * A project is created before there is any episode to stream a ladder for,
   * so its result has to arrive on the stream the start screen has open. The
   * listing follows it, because the new directory is a change the watcher sees.
   */
  it("should deliver a run on the workspace stream when no episode is open", async () => {
    const app = createUi({ workspace });
    const stream = await app.request("/api/events");
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const argv = INTENTS.initProject({
      aspectRatio: "16:9",
      projectId: "druga-seria",
      title: "Druga",
    });
    const started = await app.request("/api/run", {
      body: JSON.stringify({ argv }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");

    expect(JSON.parse(finished.data)).toMatchObject({ ok: true, runId });
    expect(JSON.parse(await cli("list", "--json"))).toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ id: "druga-seria" })]),
    });
    await events.close();
  });

  /**
   * The first of the two steps of a purchase, as far as a test can take it.
   *
   * What a browser has to confirm is the clicking. What this confirms is the
   * seam between the two halves that a click would otherwise be the first to
   * exercise: the argv the dictionary builds for "Generuj" is a command this
   * server runs, and what comes back under its identifier is the object the
   * panel arranges, the bill and the whole prompt included. The second step is
   * not run here, for the obvious reason, and `--dry-run` is why the first one
   * can be: by contract it reads no secret and sends nothing.
   */
  it("should answer the first step of a purchase with the stage's own object", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: INTENTS.previewScreenplay({
          episodeId: EPISODE,
          maxOutputTokens: "",
          model: "gpt-6-astra",
          projectId: PROJECT,
          regenerate: true,
        }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");
    const done = JSON.parse(finished.data) as { data: string; ok: boolean; runId: string };
    const report = JSON.parse(done.data) as {
      command: string;
      paidCalls: number;
      prompt: string;
      stage: string;
    };

    expect(done).toMatchObject({ ok: true, runId });
    expect(report.command).toBe("generate");
    expect(report.stage).toBe("screenplay");
    expect(report.paidCalls).toBe(1);
    expect(report.prompt).toContain("# Task: write a screenplay");
    await events.close();
  });

  /**
   * The loopback address is the security model, and it is not the whole one.
   *
   * Any page open in this browser can post to `127.0.0.1:4317`; CORS would
   * stop it reading the answer and would not stop the command running, and
   * from the next slice on a command spends money. Two checks close that:
   * a foreign `Origin` is refused, and a body has to be JSON, which is what
   * makes the browser ask permission before sending anything at all.
   */
  /**
   * Stage 0's one promise the browser could quietly break.
   *
   * A person pastes a path out of Finder and the CLI copies the file, which is
   * why `episode.json` records where it came from. Handing bytes over instead
   * would have made that origin a temporary directory, and an answer to "skąd
   * to jest" would have stopped existing: that is the whole reason the PRD
   * refused an upload. So the string travels from the form to `--source`
   * untouched, and what proves it is the archive rather than the argv.
   */
  it("should carry the path typed in a stage-0 form into the episode's archive", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const source = join(scratch, "02-Slonce.md");

    await writeFile(source, "# Słońce\n\nEwa czeka na słońce.\n", "utf8");

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: INTENTS.addEpisode({
          audio: "narration",
          duration: "30",
          language: "pl",
          maxClip: "15",
          nature: "law-or-idea",
          projectId: PROJECT,
          source,
          subtitles: "none",
        }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");

    expect(JSON.parse(finished.data)).toMatchObject({ ok: true, runId });

    const project = projectPaths(workspace, PROJECT);

    if (!project.ok) {
      throw project.error;
    }

    const added = episodePaths(project.data, "02-slonce");

    if (!added.ok) {
      throw added.error;
    }

    expect(JSON.parse(await readFile(added.data.file, "utf8"))).toMatchObject({
      source: { originPath: source },
    });

    const checked = await app.request("/api/run", {
      body: JSON.stringify({ argv: INTENTS.checkPrepare({ projectId: PROJECT }) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(checked.status).toBe(202);
    await events.close();
  });

  /**
   * The first stage whose obstacle is a **program**, and the whole reason the
   * panel forwards refusals instead of phrasing them.
   *
   * Stage 8 buys nothing, so nothing here can go wrong with a key; what can go
   * wrong is that the machine has no ffmpeg, and then the stage refuses rather
   * than re-encoding, because a second road is the one thing it must not have.
   * A screen that softened that sentence, or offered a button the terminal
   * would refuse, would be teaching a person that the two disagree. So the
   * words travel unchanged, which is checkable: the same argv run through the
   * server and run in this process say the same thing, to the character.
   */
  it("should carry stage 8's refusal over a missing engine in the terminal's words", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const argv = INTENTS.assembleEpisode({
      dryRun: false,
      episodeId: EPISODE,
      projectId: PROJECT,
      regenerate: false,
      track: TRACK,
    });
    const started = await app.request("/api/run", {
      body: JSON.stringify({ argv }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");
    const refused = await run([...argv, "--workspace", root]);

    expect(refused.ok).toBe(false);
    expect(JSON.parse(finished.data)).toEqual({
      error: {
        message: refused.ok ? "" : refused.error.message,
        name: refused.ok ? "" : refused.error.name,
      },
      ok: false,
      runId,
    });
    expect(refused.ok ? "" : refused.error.message).toContain("nie znaleziono ffmpeg");
    await events.close();
  });

  /**
   * Stage 8's one free question, and the only thing its panel arranges.
   *
   * A paid stage previews so a person can read the bill before spending; this
   * one has no bill, so the dry run exists for the other half of a preview:
   * what would be cut, in what order, and how far the clips that came back
   * drifted from the plan somebody approved. That array is derived from the
   * approved shot list at call time and stored nowhere, which is why the panel
   * asks for the object rather than keeping a plan of its own.
   */
  it("should answer stage 8's dry run with the cut plan and no bill", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: INTENTS.assembleEpisode({
          dryRun: true,
          episodeId: EPISODE,
          projectId: PROJECT,
          regenerate: false,
          track: TRACK,
        }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");
    const done = JSON.parse(finished.data) as { data: string; ok: boolean; runId: string };
    const report = JSON.parse(done.data) as Record<string, unknown> & {
      cut: readonly { id: string }[];
      plannedSeconds: number;
    };

    expect(done).toMatchObject({ ok: true, runId });
    expect(report.stage).toBe("assembly");
    expect(report.cut.map((one) => one.id)).toEqual(["C01", "C02"]);
    expect(report.plannedSeconds).toBe(30);
    expect(Object.keys(report)).not.toContain("paidCalls");
    await events.close();
  });

  /**
   * Stage 9's one knob somebody is **expected** to turn, and the reason it
   * lives where it lives.
   *
   * How the narrator reads is dialled in by ear over several attempts. Stored
   * beside `narratorVoiceId` in `project.json` it would have been a recorded
   * input of nearly every artifact in the workspace, so moving it a tenth
   * would have lapsed the acceptance of a screenplay, a shot list, ten
   * character images and a cut episode whose bytes it never touched. It lives
   * in a file stage 9 owns instead, and the proof a panel owes is the ladder:
   * the same cells, in the same states, before and after the form is saved.
   */
  it("should not lapse an earlier stage's approval when the direction is saved", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const ladder = async (): Promise<readonly (readonly [string, string])[]> => {
      const response = await app.request(`/api/status/${PROJECT}/${EPISODE}`);
      const body = (await response.json()) as {
        cells: readonly { id: string; stage: number; state: string }[];
      };

      return body.cells.filter((cell) => cell.stage < 9).map((cell) => [cell.id, cell.state]);
    };
    const before = await ladder();

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: INTENTS.directNarrator({
          projectId: PROJECT,
          similarity: "",
          speakerBoost: false,
          speed: "",
          stability: "0.35",
          style: "0.4",
        }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");

    expect(JSON.parse(finished.data)).toMatchObject({ ok: true, runId });
    expect(await ladder()).toEqual(before);
    await events.close();
  });

  /**
   * The same decision one level finer, and the proof that the line held.
   *
   * How loud the bed sits under a narrator says nothing about how that
   * narrator read, so the levels live in `mix.json` rather than inside
   * `narration.json`, and a fader somebody moves must not lapse a recording
   * that was bought, heard and accepted. Stage 9 owns delivery; stage 10 owns
   * levels; neither is in `project.json`, which is a recorded input of nearly
   * everything. What a panel owes here is therefore the ladder with **stage 9
   * in it**: the same cells, in the same states, before and after the form is
   * saved.
   */
  it("should not lapse an accepted recording when the levels are saved", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const ladder = async (): Promise<readonly (readonly [string, string])[]> => {
      const response = await app.request(`/api/status/${PROJECT}/${EPISODE}`);
      const body = (await response.json()) as {
        cells: readonly { id: string; stage: number; state: string }[];
      };

      return body.cells.filter((cell) => cell.stage < 10).map((cell) => [cell.id, cell.state]);
    };
    const before = await ladder();

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: INTENTS.setLevels({
          duckDb: "-14",
          duckRelease: "",
          effectsDb: "",
          musicDb: "-22",
          projectId: PROJECT,
        }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");

    expect(JSON.parse(finished.data)).toMatchObject({ ok: true, runId });
    expect(await ladder()).toEqual(before);
    await events.close();
  });

  it("should refuse a command posted by a page that is not this one", async () => {
    const response = await createUi({ workspace }).request("/api/run", {
      body: JSON.stringify({ argv: ["list"] }),
      headers: { "content-type": "application/json", origin: "https://zla-strona.example" },
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { name: "ForbiddenError" } });
  });

  /**
   * Comparing `Origin` to `Host` is not enough, and the attack says why.
   *
   * A page on `zla-strona.example` whose DNS is re-pointed at 127.0.0.1 is
   * served by this server under **its own** name: the browser then sends
   * `Host: zla-strona.example` and `Origin: http://zla-strona.example`, the
   * two agree, the request is same-origin so no preflight is asked for, and
   * the page can read the answer. The only header an attacker cannot forge
   * into the loopback address is the name this server is reached by, so that
   * is what is checked.
   */
  it("should refuse a request reaching it under a name that is not the loopback", async () => {
    const app = createUi({ workspace });
    const [started, read] = await Promise.all([
      app.request("http://zla-strona.example:4317/api/run", {
        body: JSON.stringify({ argv: ["list"] }),
        headers: {
          "content-type": "application/json",
          origin: "http://zla-strona.example:4317",
        },
        method: "POST",
      }),
      app.request(`http://zla-strona.example:4317/api/status/${PROJECT}/${EPISODE}`),
    ]);

    expect(started.status).toBe(403);
    expect(read.status).toBe(403);
    expect(await read.text()).not.toContain("command");
  });

  it("should refuse a body that needed no permission to send", async () => {
    const response = await createUi({ workspace }).request("/api/run", {
      body: JSON.stringify({ argv: ["list"] }),
      headers: { "content-type": "text/plain;charset=UTF-8" },
      method: "POST",
    });

    expect(response.status).toBe(415);
  });

  it("should carry a refusal in the words the terminal would print", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const started = await app.request("/api/run", {
      body: JSON.stringify({ argv: ["approve", "nie-ma", EPISODE, "--stage", "screenplay"] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");
    const refused = await run([
      "approve",
      "nie-ma",
      EPISODE,
      "--stage",
      "screenplay",
      "--workspace",
      root,
    ]);

    expect(JSON.parse(finished.data)).toEqual({
      error: {
        message: refused.ok ? "" : refused.error.message,
        name: refused.ok ? "" : refused.error.name,
      },
      ok: false,
      runId,
    });
    await events.close();
  });
});
