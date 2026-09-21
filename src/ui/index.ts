import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { run } from "../cli/index.js";
import type { Workspace } from "../lib/workspace.js";
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

export function createUi(options: UiOptions): Hono {
  const app = new Hono();

  /** What one question costs: an argv, a call, and the text that came back. */
  const ask = async (argv: readonly string[]): ReturnType<typeof run> =>
    await run([...argv, "--json", "--workspace", options.workspace.root]);

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

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          stop();
          resolve();
        });
      });
    });
  });

  return app;
}
