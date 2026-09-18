import { err, ok, type Result } from "../result.js";

/**
 * Internal to the text-model module: the paid text call, and nothing else.
 *
 * Promoted out of `lib/screenplay` when the shot list became the second stage
 * to make it: the transport, the redaction, the single-attempt rule and the
 * refusal classification are identical for every text stage, and a second copy
 * is a place for them to diverge. The same reason `lib/artifact` exists.
 *
 * `fetch` is injected so every rule around the call — no retry, the key never
 * reaching disk, a refusal being an error rather than an empty document — is
 * testable without spending anything.
 *
 * `store: false` is deliberate and has a consequence worth stating: the
 * provider keeps nothing, so a response that never reached disk cannot be
 * fetched again by id. An interrupted attempt is therefore a dead end that
 * only `--regenerate` reopens, and the tool says so rather than silently
 * paying twice.
 *
 * Nothing here knows which stage is calling, what a valid result looks like,
 * or where anything is written.
 */

export const ENDPOINT = "https://api.openai.com/v1/responses";
const REDACTED = "[UKRYTY KLUCZ]";

const TIMEOUT_MS = 10 * 60_000;

/**
 * A schema the provider itself enforces on the answer.
 *
 * Stage 4 asks for one, because its result is a dependency graph plus twenty
 * separate prompts rather than a document somebody reads top to bottom: an
 * array is unambiguous where a comma-separated Markdown field would be a parser
 * over prose. Stages 1 and 3 ask for none — their result *is* the document, so
 * the shape a person reads and the shape the tool checks are the same thing.
 */
export interface ResponseFormat {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

interface ModelRequest {
  readonly input: string;
  readonly max_output_tokens: number;
  readonly model: string;
  readonly store: false;
  readonly text?: {
    readonly format: {
      readonly name: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly strict: true;
      readonly type: "json_schema";
    };
  };
}

interface Transport {
  /** The response body with the API key redacted, ready to archive. */
  readonly body: string;
  readonly httpStatus: number;
  readonly receivedAt: string;
  readonly requestId: string | null;
}

interface ModelMessage {
  readonly content?: readonly { readonly text?: string; readonly type: string }[];
  readonly role?: string;
  readonly type: string;
}

interface ModelResponse {
  readonly id?: string;
  readonly output?: readonly ModelMessage[];
  readonly status?: string;
}

class ModelCallError extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "ModelCallError";
    this.httpStatus = httpStatus;
  }
}

class ModelOutputError extends Error {
  readonly reason: "empty" | "incomplete" | "malformed" | "refusal";

  constructor(reason: ModelOutputError["reason"], message: string) {
    super(message);
    this.name = "ModelOutputError";
    this.reason = reason;
  }
}

export function buildRequest(input: {
  readonly format?: ResponseFormat | null;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly prompt: string;
}): ModelRequest {
  const request = {
    input: input.prompt,
    max_output_tokens: input.maxOutputTokens,
    model: input.model,
    store: false,
  } as const;

  return input.format === undefined || input.format === null
    ? request
    : {
        ...request,
        text: {
          format: {
            name: input.format.name,
            schema: input.format.schema,
            strict: true,
            type: "json_schema",
          },
        },
      };
}

/**
 * One call. Never two: a non-2xx answer is reported as it stands, because a
 * retry here is a second charge nobody asked for.
 */
export async function callModel(input: {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly request: ModelRequest;
}): Promise<Result<Transport>> {
  let response: Response;

  try {
    response = await input.fetch(ENDPOINT, {
      body: JSON.stringify(input.request),
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    return err(
      new ModelCallError(
        null,
        "wywołanie API nie doszło do skutku (sieć albo przekroczony czas) — nie ponawiam; sprawdź, czy próba nie została rozliczona",
        { cause }
      )
    );
  }

  const raw = await response.text();

  // Any answer that arrived is returned, including a rejection. Judging it here
  // would mean discarding the body before the caller could archive it, and a
  // refusal nobody can read is the one thing worse than a refusal.
  return ok({
    body: raw.replaceAll(input.apiKey, REDACTED),
    httpStatus: response.status,
    receivedAt: new Date().toISOString(),
    requestId: response.headers.get("x-request-id"),
  });
}

/**
 * Whether an archived answer is a refusal, and what the provider said.
 *
 * `null` means the call succeeded. The message carries the provider's own
 * words: "check the model, access and balance" is useless advice when the API
 * already said which field it objected to.
 */
export function httpFailure(transport: Transport): Error | null {
  if (transport.httpStatus < 400) {
    return null;
  }

  return new ModelCallError(
    transport.httpStatus,
    `API zwróciło HTTP ${transport.httpStatus} — nie ponawiam wywołania. Odpowiedź dostawcy: ${providerMessage(transport.body)}`
  );
}

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    const { code, message } = parsed.error ?? {};

    if (typeof message === "string" && message !== "") {
      return code === undefined ? message : `[${code}] ${message}`;
    }
  } catch {
    // Not JSON: the raw text is the best diagnostic there is.
  }

  return body.slice(0, 600).trim() || "pusta";
}

/**
 * Whether a refused request can have been billed.
 *
 * A 4xx is the provider declining to do the work, so nothing was charged and a
 * plain re-run is safe. A 429 or a 5xx is different: the work may have started,
 * so those keep the `--regenerate` rule that protects against paying twice.
 */
export function refusedWithoutCharge(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
}

/**
 * Pulls the document out of a Responses payload, or says why there is none.
 *
 * `what` names the thing in the error message — the caller knows whether it
 * asked for a screenplay or a shot list, and this module does not.
 */
export function readOutputText(
  body: string,
  what: string
): Result<{ jobId: string | null; text: string }> {
  let parsed: ModelResponse;

  try {
    parsed = JSON.parse(body) as ModelResponse;
  } catch {
    return err(new ModelOutputError("malformed", "odpowiedź API nie jest poprawnym JSON-em"));
  }

  if (parsed.status !== "completed") {
    return err(
      new ModelOutputError(
        "incomplete",
        `odpowiedź API ma status "${parsed.status ?? "brak"}" zamiast "completed" — zachowano ją do sprawdzenia, nie publikuję wyniku (${what})`
      )
    );
  }

  if (!Array.isArray(parsed.output)) {
    return err(new ModelOutputError("malformed", "API nie zwróciło tablicy output"));
  }

  const content = parsed.output
    .filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content ?? []);

  if (content.some((item) => item.type === "refusal")) {
    return err(
      new ModelOutputError(
        "refusal",
        `model odmówił wykonania zadania (${what}) — odpowiedź zachowana w archiwum próby`
      )
    );
  }

  const text = `${content
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim()}\n`;

  return text.trim() === ""
    ? err(new ModelOutputError("empty", "API zwróciło pustą odpowiedź"))
    : ok({ jobId: parsed.id ?? null, text });
}
