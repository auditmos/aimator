import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { run } from "../cli/index.js";
import { parseRange } from "../lib/byte-range.js";
import type { Workspace } from "../lib/workspace.js";
import { type LocatedArtifact, locateArtifact } from "./artifact.js";
import { watchWorkspace } from "./watch.js";

/**
 * The local UI's server: a thin envelope around `run(argv)`.
 *
 * It sits beside `src/site` rather than inside `src/lib` for the same reason
 * that one does: it is not a stage, it owns no artifact and it decides nothing
 * about the pipeline. The difference is which way each of them faces. The site
 * publishes a finished episode to the internet from a frozen export; this one
 * shows the workspace as it is right now, to one person on one machine.
 *
 * The rule that shapes every route here: **the CLI is the only contract.** A
 * route builds an `argv`, calls `run`, and hands back what came out. It never
 * imports a stage, never reads a state file and never decides whether a cell
 * is blocked, because the moment it does, the browser can answer something the
 * terminal cannot and the parity that lets an agent drive this tool is gone.
 * `run` never touches `process`, a stream or an exit code, which is exactly
 * what makes calling it in a server process legal rather than a workaround.
 */

interface UiOptions {
  /** Which tree is being shown. Injected, so tests run on a fixture. */
  readonly workspace: Workspace;
}

/**
 * The answer a refused command gives, in the words the terminal would print.
 *
 * A refusal is a `Result` here rather than an exception, so the server has the
 * message in hand and hands it over unchanged: two versions of one refusal is
 * the thing the panel is supposed to make impossible.
 */
interface Refusal {
  readonly error: { readonly message: string; readonly name: string };
}

/**
 * What a started command says when it is done, under its own identifier.
 *
 * It is the `Result` the CLI returned and nothing more: the text a terminal
 * would have printed, or the refusal it would have printed instead. The
 * browser has no second reading of either.
 */
type RunDone =
  | { readonly data: string; readonly ok: true; readonly runId: string }
  | { readonly error: Refusal["error"]; readonly ok: false; readonly runId: string };

/**
 * The names this server answers to. Anything else is somebody else's DNS.
 *
 * This is the check that cannot be forged past. Comparing `Origin` with `Host`
 * looks like the same test and is not: a page on `zla-strona.example` whose
 * name is re-pointed at 127.0.0.1 reaches this process under **its own** name,
 * so both headers agree, the request counts as same-origin, no preflight is
 * asked for, and the page reads the answer. The loopback binding stops the
 * network from routing a stranger here; this stops a stranger's *name* from
 * doing it.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function loopbackHost(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];

  return name !== undefined && LOOPBACK.has(name);
}

/** The name and port a request arrived under, or nothing it could have. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Whether a request came from the page this server itself is serving. */
function sameOrigin(origin: string, url: string): boolean {
  try {
    return new URL(origin).host === hostOf(url);
  } catch {
    return false;
  }
}

export function createUi(options: UiOptions): Hono {
  const app = new Hono();

  /**
   * Every stream open on this server, waiting for a command to finish.
   *
   * A finished run is announced to all of them rather than to the episode it
   * belongs to, and that is not laziness: knowing which episode an argv is
   * about would mean reading the argv, which is the CLI's grammar and the one
   * thing this server must never learn a second copy of. One person, one
   * machine, and the client ignores an identifier it did not start.
   */
  const listeners = new Set<(done: RunDone) => void>();

  /** What one question costs: an argv, a call, and the text that came back. */
  const ask = async (argv: readonly string[]): ReturnType<typeof run> =>
    await run([...argv, "--json", "--workspace", options.workspace.root]);

  /**
   * Every answer this server gives, gated on the name it was reached by.
   *
   * It guards reads as well as the one write, because a rebound page would
   * otherwise read the ladder and the screenplay just as happily as it would
   * run a command, and this workspace is somebody's unpublished film.
   */
  app.use("/api/*", async (c, next) => {
    // Read off the request URL rather than the header: the Node adapter builds
    // that URL from `Host`, so this is the same name with one spelling.
    if (!loopbackHost(hostOf(c.req.url))) {
      const refusal: Refusal = {
        error: { message: "żądanie pod nazwą spoza pętli zwrotnej", name: "ForbiddenError" },
      };

      return Response.json(refusal, { status: 403 });
    }

    await next();
  });

  /** Nothing here, said the way a refusal is said everywhere else. */
  const missing = (message: string): Response => {
    const refusal: Refusal = { error: { message, name: "NotFoundError" } };

    return Response.json(refusal, { status: 404 });
  };

  /**
   * An artifact's bytes, and the one header that makes a film watchable.
   *
   * Reading a screenplay is reading the whole file; watching a clip is not.
   * A player asks for the head of the file, reads how long it is, and then
   * asks for the second somebody dragged to, so a server that only ever
   * answered 200 with everything would leave a person watching eleven seconds
   * in order to approve the twelfth. That is the same gap the pictures closed
   * at stage 2: approving what you cannot look at is approving a filename.
   *
   * So `Range` is answered where HTTP says it is answered, and the three
   * possible replies are kept apart on purpose. A request with no range gets
   * the whole file and the header that says a range would have worked; a
   * legible range gets 206 and exactly the bytes it named, because a player
   * reading 200 believes it was handed the whole film and stops asking; a
   * range the file does not have gets 416 and the real size, rather than a
   * guess at what the caller meant.
   */
  const serve = async (located: LocatedArtifact, range: string | undefined): Promise<Response> => {
    let file: Awaited<ReturnType<typeof open>> | null = null;

    try {
      // An artifact the layout knows and the stage has not written yet is the
      // ordinary case here, not an error: the panel asks for it the moment a
      // cell exists, which is before the stage has run. So every way of
      // failing to read these bytes is answered the same way, exactly as it
      // was when this was one `readFile`.
      file = await open(located.path);

      const { size } = await file.stat();
      // Several ranges in one header are optional in HTTP and nothing here
      // asks for them, so they are read as no range at all rather than refused.
      const wanted = range === undefined || range.includes(",") ? null : range;
      const span = wanted === null ? null : parseRange(wanted, size);

      if (wanted !== null && span === null) {
        return new Response(null, {
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes */${size}`,
            "content-type": located.contentType,
          },
          status: 416,
        });
      }

      const first = span?.first ?? 0;
      const last = span?.last ?? size - 1;
      const length = size === 0 ? 0 : last - first + 1;
      const bytes = Buffer.alloc(length);

      await file.read(bytes, 0, length, first);

      return new Response(bytes, {
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(length),
          "content-type": located.contentType,
          ...(span === null ? {} : { "content-range": `bytes ${first}-${last}/${size}` }),
        },
        status: span === null ? 200 : 206,
      });
    } catch {
      return missing("tego artefaktu jeszcze nie ma na dysku");
    } finally {
      await file?.close();
    }
  };

  /** One command, one answer, and the JSON the CLI already produced. */
  const answer = async (argv: readonly string[]): Promise<Response> => {
    const result = await ask(argv);

    if (!result.ok) {
      const refusal: Refusal = {
        error: { message: result.error.message, name: result.error.name },
      };

      return Response.json(refusal, { status: 400 });
    }

    // Passed through as bytes rather than parsed and re-serialised: what the
    // browser reads is then the same object the terminal prints, to the field.
    return new Response(result.data, {
      headers: { "content-type": "application/json; charset=utf-8" },
      status: 200,
    });
  };

  app.get("/api/projects", async () => await answer(["list"]));

  /**
   * An artifact, read-only, addressed by what it is rather than where it is.
   *
   * Reviewing is looking: a screenplay nobody can read in the panel is a yes
   * given to a filename, and a character card nobody can see is worse. So the
   * bytes are served, from the one path builder that knows the layout, and
   * nothing else about them is decided here. A tuple the layout does not know
   * is a 404, never a guess at a file.
   */
  app.get("/api/artifact/:projectId/:stage/:artifact", async (c) => {
    const located = locateArtifact(options.workspace, {
      artifact: c.req.param("artifact"),
      // The three axes a stage may or may not have. They travel beside the
      // path rather than in it, because a character's card is under no episode
      // and a screenplay is under no track: a segment every caller had to fill
      // in with something meaningless would be an identifier that lies.
      characterId: c.req.query("character") ?? "",
      episodeId: c.req.query("episode") ?? "",
      projectId: c.req.param("projectId"),
      stage: c.req.param("stage"),
      track: c.req.query("track") ?? "",
    });

    return located === null
      ? missing("nie ma takiego artefaktu w układzie katalogu roboczego")
      : await serve(located, c.req.header("range"));
  });

  app.get(
    "/api/status/:projectId/:episodeId",
    async (c) => await answer(["status", c.req.param("projectId"), c.req.param("episodeId")])
  );

  /**
   * The same ladder, pushed again whenever the workspace moves.
   *
   * Two windows on one workspace is the ordinary case here, because the agent
   * in the terminal and the person in the browser are working on one episode,
   * so a screen that only answered when asked would be wrong for as long as it
   * took somebody to reload it. What travels is the whole ladder rather than a
   * description of what changed: the server has no idea what changed, and that
   * is deliberate.
   *
   * A refusal travels too, under its own event name, because "the project is
   * gone" is a state the screen has to show rather than a reason to hang up.
   */
  app.get("/api/events/:projectId/:episodeId", (c) => {
    const argv = ["status", c.req.param("projectId"), c.req.param("episodeId")];

    return streamSSE(c, async (stream) => {
      const push = async (): Promise<void> => {
        const result = await ask(argv);

        await stream.writeSSE(
          result.ok
            ? { data: result.data, event: "status" }
            : {
                data: JSON.stringify({
                  error: { message: result.error.message, name: result.error.name },
                }),
                event: "refusal",
              }
        );
      };

      await push();

      let pushing = Promise.resolve();
      const stop = watchWorkspace(options.workspace.root, () => {
        // One recompute at a time: a burst that outruns `status` would
        // otherwise interleave two answers on one socket.
        pushing = pushing.then(push);
      });
      // A finished command joins the same queue as a recomputed ladder, for
      // the same reason: two writers on one socket would interleave frames.
      const listener = (done: RunDone): void => {
        pushing = pushing.then(
          async () => await stream.writeSSE({ data: JSON.stringify(done), event: "run" })
        );
      };

      listeners.add(listener);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          stop();
          listeners.delete(listener);
          resolve();
        });
      });
    });
  });

  /**
   * A command, started and let go of.
   *
   * The answer is an identifier, given before the command has done anything,
   * because stage 7 polls a provider for minutes and a browser that waited for
   * it could show nothing else meanwhile. What the run actually said arrives
   * on the episode's own stream, under that identifier.
   *
   * The argv is passed through unread. Which commands exist, which flags they
   * take and which of them spend money are all the CLI's answers, given by
   * running or by refusing, and a second opinion here would be exactly the
   * private road this module is forbidden to build. The workspace is appended
   * rather than trusted from the request, because which tree is open is this
   * process's fact and not the page's.
   */
  app.post("/api/run", async (c) => {
    const origin = c.req.header("origin");

    // A page served from somewhere else may post here: the browser sends the
    // request and only hides the answer, which is no comfort when the request
    // is the thing that costs money. An absent `Origin` is a terminal or an
    // agent, which is the other caller this endpoint is for.
    if (origin !== undefined && !sameOrigin(origin, c.req.url)) {
      const refusal: Refusal = {
        error: { message: "żądanie spoza tego serwera", name: "ForbiddenError" },
      };

      return Response.json(refusal, { status: 403 });
    }

    // Insisting on JSON is what forces a preflight: a form or a `fetch` with a
    // plain-text body is a "simple request" any page may send unasked, and a
    // preflight is a question this server answers for nobody but itself.
    if (c.req.header("content-type")?.startsWith("application/json") !== true) {
      const refusal: Refusal = {
        error: { message: "komendę wysyła się jako application/json", name: "UsageError" },
      };

      return Response.json(refusal, { status: 415 });
    }

    const body: unknown = await c.req.json().catch(() => null);
    const argv = (body as { readonly argv?: unknown } | null)?.argv;

    if (!(Array.isArray(argv) && argv.every((one) => typeof one === "string"))) {
      const refusal: Refusal = {
        error: { message: "żądanie bez listy argumentów argv", name: "UsageError" },
      };

      return Response.json(refusal, { status: 400 });
    }

    const runId = randomUUID();
    const announce = (done: RunDone): void => {
      for (const listener of listeners) {
        listener(done);
      }
    };

    run([...(argv as string[]), "--workspace", options.workspace.root]).then(
      (result) =>
        announce(
          result.ok
            ? { data: result.data, ok: true, runId }
            : {
                error: { message: result.error.message, name: result.error.name },
                ok: false,
                runId,
              }
        ),
      // An exception is a bug rather than a refusal, and the screen still has
      // to stop saying "w toku": the identifier comes back either way.
      (cause: unknown) =>
        announce({
          error: {
            message: cause instanceof Error ? cause.message : String(cause),
            name: cause instanceof Error ? cause.name : "Error",
          },
          ok: false,
          runId,
        })
    );

    return Response.json({ runId }, { status: 202 });
  });

  return app;
}
