import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { run } from "../cli/index.js";
import type { Workspace } from "../lib/workspace.js";
import { locateArtifact } from "./artifact.js";
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

/** Whether a request came from the page this server itself is serving. */
function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
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

  /** Nothing here, said the way a refusal is said everywhere else. */
  const missing = (message: string): Response => {
    const refusal: Refusal = { error: { message, name: "NotFoundError" } };

    return Response.json(refusal, { status: 404 });
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
   * given to a filename. So the bytes are served, from the one path builder
   * that knows the layout, and nothing else about them is decided here. A
   * tuple the layout does not know is a 404, never a guess at a file.
   */
  app.get("/api/artifact/:projectId/:episodeId/:stage/:artifact", async (c) => {
    const located = locateArtifact(options.workspace, {
      artifact: c.req.param("artifact"),
      episodeId: c.req.param("episodeId"),
      projectId: c.req.param("projectId"),
      stage: c.req.param("stage"),
    });

    if (located === null) {
      return missing("nie ma takiego artefaktu w układzie katalogu roboczego");
    }

    try {
      return new Response(await readFile(located.path), {
        headers: { "content-type": located.contentType },
        status: 200,
      });
    } catch {
      // An artifact the layout knows and the stage has not written yet is the
      // ordinary case here, not an error: the panel asks for it the moment a
      // cell exists, which is before the stage has run.
      return missing("tego artefaktu jeszcze nie ma na dysku");
    }
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
    if (origin !== undefined && !sameOrigin(origin, c.req.header("host"))) {
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
