import { z } from "zod";
import type { CastMember } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import type { ShotList } from "../shot-list/index.js";

/**
 * Internal to the prompt-package module: the structural verdict on a package,
 * and the package itself as data.
 *
 * Pure and offline, like every other stage's validator, and for the same
 * reason: it decides whether a paid answer may be published at all, and `check`
 * has to be able to re-run it against files that already exist, long after the
 * command that produced them.
 *
 * What it judges is the **manifest** — identifiers, kinds, subjects and the
 * dependency graph — never the prose. The prose lives in `prompts/**`, one file
 * per future paid call, and this module deliberately cannot see it: a rule that
 * read a prompt would be a rule about writing, and no regular expression gets
 * to hold an opinion about that.
 *
 * The one thing it does hold an opinion about is the binding to the shot list.
 * That binding is the whole point of the stage: a clip that does not carry the
 * hero of every character its shots put on screen is a clip the next stages
 * cannot draw, and the shot list already said who is there.
 */

/** How a reference to a character's canonical image is written. */
const HERO = "hero:";
const ONE_LINE = /^[^\r\n]+$/;

const REFERENCE_KINDS = ["character", "location", "prop"] as const;

/**
 * The manifest's shape. Deliberately free of length and pattern constraints:
 * the same object is turned into the JSON Schema the provider enforces, and
 * that dialect supports neither. Every such rule is checked below instead,
 * where it can say which identifier it objected to.
 */
export const manifestSchema = z.strictObject({
  clips: z.array(z.strictObject({ id: z.string(), referenceIds: z.array(z.string()) })),
  opening: z.strictObject({ referenceIds: z.array(z.string()) }),
  references: z.array(
    z.strictObject({
      dependsOn: z.array(z.string()),
      id: z.string(),
      kind: z.enum(REFERENCE_KINDS),
      subject: z.string(),
    })
  ),
  review: z.string(),
});

export type PackageReference = z.infer<typeof manifestSchema>["references"][number];
export type PackageClip = z.infer<typeof manifestSchema>["clips"][number];

/**
 * The package as data — what a later stage reads instead of parsing anything.
 *
 * `heroes` is the cast this episode actually needs an image of, derived from
 * the shot list rather than from the roster: a recurring character who is not
 * in this episode is not an input to this package, and blocking on their hero
 * would hold the stage hostage to a file it never opens.
 */
export interface PromptPackage {
  readonly clips: readonly PackageClip[];
  readonly heroes: readonly string[];
  readonly opening: { readonly referenceIds: readonly string[] };
  readonly references: readonly PackageReference[];
  readonly review: string;
}

interface ValidateInput {
  /** The stage-0 roster. A `hero:` id must name one of these. */
  readonly cast: readonly CastMember[];
  /** The plan this package is drawn from, as `validateShotList` returned it. */
  readonly shotList: ShotList;
  /** `prompt-package.json`, parsed. */
  readonly value: unknown;
}

class PackageFormatError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = "PackageFormatError";
    this.rule = rule;
  }
}

function fail(rule: string, message: string): Result<never> {
  return err(new PackageFormatError(rule, message));
}

/** How a reference to one character's canonical image is written. */
function heroId(castId: string): string {
  return `${HERO}${castId}`;
}

/** The cast ids the shot list puts on screen inside one clip, in roster order. */
function castOfClip(shotList: ShotList, clipId: string): readonly string[] {
  const seen = new Set(
    shotList.shots.filter((shot) => shot.clip === clipId).flatMap((shot) => shot.cast)
  );

  return shotList.castSeen.filter((id) => seen.has(id));
}

/**
 * The references, checked for consecutive numbering and a forward-only
 * dependency graph.
 *
 * Forward-only is what makes the graph acyclic, and it is checked rather than
 * searched for: `Rnn` may depend on a hero or on a lower-numbered reference and
 * on nothing else, so a cycle cannot be written down in the first place. A
 * topological sort would answer the same question later and less clearly.
 */
function readReferences(
  references: readonly PackageReference[],
  heroes: readonly string[]
): Result<true> {
  if (references.length === 0) {
    return fail("references", "pakiet nie ma ani jednej referencji");
  }

  const known = new Set(heroes.map(heroId));

  for (const [index, reference] of references.entries()) {
    const expected = `R${String(index + 1).padStart(2, "0")}`;

    if (reference.id !== expected) {
      return fail(
        "reference-order",
        `referencje muszą mieć kolejne numery od R01 — napotkano "${reference.id}" na pozycji ${index + 1}`
      );
    }

    if (!ONE_LINE.test(reference.subject.trim())) {
      return fail(
        "reference-subject",
        `${reference.id}: pole subject musi być jedną niepustą linią — to etykieta, a opis jest w prompts/references/${reference.id}.md`
      );
    }

    const depends = checkIds(reference.dependsOn, known, `${reference.id}: dependsOn`);

    if (!depends.ok) {
      return depends;
    }

    known.add(reference.id);
  }

  return ok(true);
}

/** Ids that must all be known, with none repeated. */
function checkIds(
  ids: readonly string[],
  known: ReadonlySet<string>,
  context: string
): Result<true> {
  if (ids.length === 0) {
    return fail("reference-ids", `${context}: wymagana co najmniej jedna referencja`);
  }

  const seen = new Set<string>();

  for (const id of ids) {
    if (!known.has(id)) {
      return fail(
        "reference-ids",
        `${context}: "${id}" nie istnieje w tym miejscu — dozwolone są wyłącznie ${[...known].join(", ")}`
      );
    }

    if (seen.has(id)) {
      return fail("reference-ids", `${context}: "${id}" wymieniony dwa razy`);
    }

    seen.add(id);
  }

  return ok(true);
}

/**
 * What one frame must carry: the heroes of everybody the shot list puts in it,
 * and at least one location.
 *
 * The location rule is the one continuity lesson the source production paid
 * for: a close-up alone cannot establish a wider composition, so a frame that
 * names no space has nothing to widen into.
 */
function checkFrame(
  ids: readonly string[],
  context: string,
  scope: {
    readonly cast: readonly string[];
    readonly known: ReadonlySet<string>;
    readonly locations: ReadonlySet<string>;
  }
): Result<true> {
  const checked = checkIds(ids, scope.known, context);

  if (!checked.ok) {
    return checked;
  }

  const missing = scope.cast.filter((castId) => !ids.includes(heroId(castId)));

  if (missing.length > 0) {
    return fail(
      "frame-cast",
      `${context}: brakuje ${missing.map(heroId).join(", ")} — lista ujęć umieszcza tu ${missing.join(", ")}, a bez zatwierdzonego obrazu postaci nie ma z czego jej narysować`
    );
  }

  return ids.some((id) => scope.locations.has(id))
    ? ok(true)
    : fail(
        "frame-location",
        `${context}: żadna z przypisanych referencji nie opisuje przestrzeni — zbliżenie samo nie ustawi szerszego kadru`
      );
}

/**
 * The structural contract, checked against the approved shot list — and the
 * package, returned as data.
 *
 * Says nothing about whether the direction is any good: a package that passes
 * every rule here is a correctly wired package and nothing more, which is why
 * approval is a separate command rather than a consequence of this function.
 */
export function validatePromptPackage(input: ValidateInput): Result<PromptPackage> {
  const parsed = manifestSchema.safeParse(input.value);

  if (!parsed.success) {
    return fail("shape", `pakiet ma niepoprawny kształt:\n${z.prettifyError(parsed.error)}`);
  }

  const manifest = parsed.data;
  const roster = new Set(input.cast.map((member) => member.id));
  const heroes = input.shotList.castSeen.filter((id) => roster.has(id));
  const unknown = input.shotList.castSeen.filter((id) => !roster.has(id));

  if (unknown.length > 0) {
    return fail("cast", `lista ujęć wymienia postacie spoza obsady: ${unknown.join(", ")}`);
  }

  const references = readReferences(manifest.references, heroes);

  if (!references.ok) {
    return references;
  }

  if (manifest.review.trim() === "") {
    return fail("review", "pakiet nie niesie własnej oceny — pole review jest puste");
  }

  const known = new Set([...heroes.map(heroId), ...manifest.references.map((one) => one.id)]);
  const locations = new Set(
    manifest.references.filter((one) => one.kind === "location").map((one) => one.id)
  );

  if (locations.size === 0) {
    return fail("references", "pakiet nie ma ani jednej referencji przestrzeni (kind: location)");
  }

  const [first] = input.shotList.shots;
  const opening = checkFrame(manifest.opening.referenceIds, "klatka otwarcia", {
    cast: first?.cast ?? [],
    known,
    locations,
  });

  if (!opening.ok) {
    return opening;
  }

  const planned = input.shotList.clips.map((clip) => clip.id);

  if (manifest.clips.map((clip) => clip.id).join(",") !== planned.join(",")) {
    return fail(
      "clips",
      `klipy pakietu muszą być dokładnie klipami listy ujęć, w tej samej kolejności — lista ujęć ma ${planned.join(",")}`
    );
  }

  for (const clip of manifest.clips) {
    const checked = checkFrame(clip.referenceIds, clip.id, {
      cast: castOfClip(input.shotList, clip.id),
      known,
      locations,
    });

    if (!checked.ok) {
      return checked;
    }
  }

  // A reference nothing points at is an image somebody would pay for and no
  // frame would ever attach. The stage plans images; it does not collect them.
  const used = new Set([
    ...manifest.opening.referenceIds,
    ...manifest.clips.flatMap((clip) => clip.referenceIds),
    ...manifest.references.flatMap((one) => one.dependsOn),
  ]);
  const orphan = manifest.references.filter((one) => !used.has(one.id));

  if (orphan.length > 0) {
    return fail(
      "references",
      `żaden kadr ani żadna referencja nie sięga po ${orphan.map((one) => one.id).join(", ")} — etap 5 zapłaciłby za obraz, którego nikt nie użyje`
    );
  }

  return ok({ ...manifest, heroes });
}
