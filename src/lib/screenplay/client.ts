import { err, ok, type Result } from "../result.js";

/**
 * Internal to the screenplay module: the paid call and nothing else.
 *
 * `fetch` is injected so every rule around the call — no retry, the key never
 * reaching disk, a refusal being an error rather than an empty screenplay —
 * is testable without spending anything.
 *
 * `store: false` is deliberate and has a consequence worth stating: the
 * provider keeps nothing, so a response that never reached disk cannot be
 * fetched again by id. An interrupted attempt is therefore a dead end that
 * only `--regenerate` reopens, and the tool says so rather than silently
 * paying twice.
 */

export const ENDPOINT = "https://api.openai.com/v1/responses";
const REDACTED = "[UKRYTY KLUCZ]";

const TIMEOUT_MS = 10 * 60_000;

interface ModelRequest {
  readonly input: string;
  readonly max_output_tokens: number;
  readonly model: string;
  readonly store: false;
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
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly prompt: string;
}): ModelRequest {
  return {
    input: input.prompt,
    max_output_tokens: input.maxOutputTokens,
    model: input.model,
    store: false,
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
  const transport: Transport = {
    body: raw.replaceAll(input.apiKey, REDACTED),
    httpStatus: response.status,
    receivedAt: new Date().toISOString(),
    requestId: response.headers.get("x-request-id"),
  };

  if (!response.ok) {
    return err(
      new ModelCallError(
        response.status,
        `API zwróciło HTTP ${response.status} — sprawdź model, dostęp i saldo; nie ponawiam wywołania`
      )
    );
  }

  return ok(transport);
}

/** Pulls the screenplay out of a Responses payload, or says why there is none. */
export function readScreenplay(body: string): Result<{ jobId: string | null; text: string }> {
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
        `odpowiedź API ma status "${parsed.status ?? "brak"}" zamiast "completed" — zachowano ją do sprawdzenia, nie publikuję scenariusza`
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
        "model odmówił napisania scenariusza — odpowiedź zachowana w archiwum próby"
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
