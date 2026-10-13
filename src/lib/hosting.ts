import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { err, ok, type Result } from "./result.js";

/**
 * A file lent to a provider for the length of one job. Single-file form.
 *
 * Kling's lip-sync takes no bytes: it takes the id of a clip it rendered itself
 * in the last thirty days, or an address it can download from. A clip from
 * Seedance, or an older one, therefore has to sit for a moment at an address the
 * provider can reach, and be gone after the job. This module is that moment and
 * nothing else: put the file in a **private** R2 bucket, hand out a signed GET
 * that expires within the hour, and hand the caller the means to take it back.
 *
 * The bucket is not the site's. The site's worker serves whatever is in its
 * bucket, so a clip lent there would be published for as long as it sat there.
 *
 * Signatures are AWS Signature Version 4 in query form, made with `node:crypto`
 * rather than an SDK: three verbs on one object do not earn a dependency, and
 * the one part nobody can eyeball is pinned by a test against AWS's own worked
 * example.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
/**
 * The payload is not part of the signature. A presigned URL is signed before
 * the body exists for whoever sends it, and the object's identity is carried by
 * its key, which is its digest.
 */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

type Method = "DELETE" | "GET" | "PUT";

/** RFC 3986, which is stricter than `encodeURIComponent` about `!'()*`. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** What `toISOString` has that SigV4's `20130524T000000Z` does not. */
const NOT_IN_STAMP = /[-:]|\.\d{3}/g;

/** `20130524T000000Z`: the moment as SigV4 spells it. */
function amzDate(at: Date): string {
  return at.toISOString().replace(NOT_IN_STAMP, "");
}

/**
 * A URL that lets whoever holds it perform one verb on one object until it
 * expires, signed with SigV4 in query form.
 *
 * Exported because the signature is the one thing that cannot be checked
 * through `hostFile`: AWS's published example is a virtual-hosted bucket in
 * `us-east-1`, and R2 is neither. Only `host` is signed, so a header the sender
 * adds, such as `Content-Type`, is not part of the bargain.
 */
export function presignUrl(input: {
  readonly accessKeyId: string;
  readonly at: Date;
  /** Seconds the URL stays valid. */
  readonly expires: number;
  readonly method: Method;
  readonly region: string;
  readonly secretAccessKey: string;
  readonly url: string;
}): string {
  const target = new URL(input.url);
  const stamp = amzDate(input.at);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/${SERVICE}/aws4_request`;
  const path = target.pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
  const query = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expires)],
    ["X-Amz-SignedHeaders", "host"],
  ]
    .map(([name = "", value = ""]) => `${encode(name)}=${encode(value)}`)
    .join("&");
  const canonical = [
    input.method,
    path,
    query,
    `host:${target.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const toSign = [
    ALGORITHM,
    stamp,
    scope,
    createHash("sha256").update(canonical, "utf8").digest("hex"),
  ].join("\n");
  const key = [input.region, SERVICE, "aws4_request"].reduce<Buffer | string>(
    (previous, part) => hmac(previous, part),
    hmac(`AWS4${input.secretAccessKey}`, day)
  );
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");

  return `${target.origin}${path}?${query}&X-Amz-Signature=${signature}`;
}

/** R2 has one region, and SigV4 still wants a name for it. */
const REGION = "auto";
/** How long the provider may take to fetch the file; the most the decision allows. */
const LENT_SECONDS = 3600;
/** The upload's own window: long enough for a 100 MB clip on a slow line. */
const UPLOAD_SECONDS = 900;
/** A DELETE is signed the moment it is sent, so its window only has to cover the call. */
const REMOVE_SECONDS = 60;

/** Where each value comes from, by the name a person sets it under. */
const VARIABLES = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "AIMATOR_LIPSYNC_BUCKET",
] as const;

type HostingVariable = (typeof VARIABLES)[number];

/**
 * The bucket and its credentials, keyed by the variable each is read from, so
 * a refusal can name what is missing in the words a person fixes it with. The
 * caller reads them on the paid path only, the way every key here is read.
 */
type HostingVariables = Readonly<Record<HostingVariable, string | undefined>>;

/** A file the provider may fetch until `expiresAt`. */
interface HostedFile {
  readonly expiresAt: string;
  /** The object's name in the bucket: the file's digest, never its path. */
  readonly key: string;
  /**
   * Takes the file back. The caller owes this on every way out of the job,
   * failure included. `null` when the object is gone; otherwise a notice, never
   * a refusal: the bucket is private and the address expires on its own, so a
   * failed removal leaves litter, not a leak, and the job's result stands.
   */
  readonly remove: () => Promise<string | null>;
  /** A signed GET, valid for at most an hour. */
  readonly url: string;
}

class HostingError extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "HostingError";
    this.httpStatus = httpStatus;
  }
}

/**
 * Puts one file in the private bucket and hands out a signed GET for it.
 *
 * The object is named by the file's sha256 and nothing else. Rule 3 says only
 * `workspace.ts` knows the layout, and a key carrying a project's or a clip's
 * name would be a copy of that layout in a bucket somebody else's servers read.
 */
export async function hostFile(input: {
  readonly fetch: typeof fetch;
  /** Injected so a test can pin the signature's moment; the default is now. */
  readonly now?: () => Date;
  readonly path: string;
  readonly variables: HostingVariables;
}): Promise<Result<HostedFile>> {
  const now = input.now ?? (() => new Date());
  const variables = complete(input.variables);

  if (!variables.ok) {
    return variables;
  }

  return await lend(input.fetch, now, input.path, variables.data);
}

class HostingVariableError extends Error {
  readonly variables: readonly HostingVariable[];

  constructor(variables: readonly HostingVariable[]) {
    super(
      `brak ${variables.join(", ")} w środowisku lub .env; klip, którego dostawca nie zna po id, trafia na czas zadania do prywatnego bucketu R2 (docs/konfiguracja.md)`
    );
    this.name = "HostingVariableError";
    this.variables = variables;
  }
}

/** Every variable present, or a refusal naming each one that is not. */
function complete(variables: HostingVariables): Result<Readonly<Record<HostingVariable, string>>> {
  const missing = VARIABLES.filter((name) => variables[name] === undefined);

  return missing.length === 0
    ? ok(variables as Readonly<Record<HostingVariable, string>>)
    : err(new HostingVariableError(missing));
}

async function lend(
  transport: typeof fetch,
  now: () => Date,
  path: string,
  variables: Readonly<Record<HostingVariable, string>>
): Promise<Result<HostedFile>> {
  const bytes = await readFile(path);
  const key = `${createHash("sha256").update(bytes).digest("hex")}${extname(path).toLowerCase()}`;
  const object = `https://${variables.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${variables.AIMATOR_LIPSYNC_BUCKET}/${key}`;
  const sign = (method: Method, expires: number, at: Date): string =>
    presignUrl({
      accessKeyId: variables.R2_ACCESS_KEY_ID,
      at,
      expires,
      method,
      region: REGION,
      secretAccessKey: variables.R2_SECRET_ACCESS_KEY,
      url: object,
    });
  let response: Response;

  try {
    response = await transport(sign("PUT", UPLOAD_SECONDS, now()), {
      body: bytes,
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(UPLOAD_SECONDS * 1000),
    });
  } catch (cause) {
    return err(
      new HostingError(
        null,
        `wysyłka pliku do bucketu ${variables.AIMATOR_LIPSYNC_BUCKET} nie doszła do skutku`,
        {
          cause,
        }
      )
    );
  }

  if (!response.ok) {
    return err(
      new HostingError(
        response.status,
        `bucket ${variables.AIMATOR_LIPSYNC_BUCKET} odrzucił plik: HTTP ${response.status}`
      )
    );
  }

  const lentAt = now();
  const litter = `obiekt ${key} został w buckecie ${variables.AIMATOR_LIPSYNC_BUCKET}; jest prywatny, a adres wygasa sam, ale usuń go ręcznie`;

  return ok({
    expiresAt: new Date(lentAt.getTime() + LENT_SECONDS * 1000).toISOString(),
    key,
    remove: async () => {
      try {
        const removed = await transport(sign("DELETE", REMOVE_SECONDS, now()), {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(REMOVE_SECONDS * 1000),
        });

        return removed.ok ? null : `usunięcie nie powiodło się (HTTP ${removed.status}): ${litter}`;
      } catch {
        return `usunięcie nie doszło do skutku: ${litter}`;
      }
    },
    url: sign("GET", LENT_SECONDS, lentAt),
  });
}
