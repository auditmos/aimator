import { err, ok, type Result } from "../result.js";
import type { ImportDestination } from "../workspace.js";
import type { MaterialSection } from "./material.js";
import type { GroupingAnswer } from "./prompt.js";

/**
 * Internal to the import module: the verdict on a grouping, pure and offline.
 *
 * Complete rather than plausible, because the answer holds nothing but ids:
 * every section of the material is routed, nothing outside it is, every
 * character is somebody the routed text names, and the episodes are numbered
 * the way the document orders them. What a section says is never judged here;
 * a person reads the result.
 */

/** Lowercase ASCII words joined by single hyphens; linear, a hyphen separates every run. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EPISODE = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLAIN = new Set(["other", "series", "style"]);

export interface Grouping {
  readonly characters: readonly { readonly id: string; readonly name: string }[];
  /** Episode ids in number order, which is the order they first appear in. */
  readonly episodes: readonly string[];
  /** Each section's destinations, by section id. */
  readonly routes: ReadonlyMap<string, readonly ImportDestination[]>;
}

class GroupingFormatError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = "GroupingFormatError";
    this.rule = rule;
  }
}

function fail(rule: string, message: string): Result<never> {
  return err(new GroupingFormatError(rule, message));
}

export function validateGrouping(
  answer: GroupingAnswer,
  sections: readonly MaterialSection[]
): Result<Grouping> {
  const declared = new Map<string, string>();

  for (const character of answer.characters) {
    if (!SLUG.test(character.id)) {
      return fail(
        "character-id",
        `identyfikator postaci "${character.id}" może mieć tylko małe litery ASCII, cyfry i pojedyncze myślniki`
      );
    }

    if (declared.has(character.id)) {
      return fail("character-id", `postać "${character.id}" zadeklarowano dwa razy`);
    }

    if (character.name.trim() === "") {
      return fail("character-name", `postać "${character.id}" nie ma imienia`);
    }

    declared.set(character.id, character.name);
  }

  const routes = readRoutes(answer, sections, declared);

  if (!routes.ok) {
    return routes;
  }

  const named = checkCharacters(sections, routes.data, declared);

  if (!named.ok) {
    return named;
  }

  const episodes = numberedEpisodes(sections, routes.data);

  if (!episodes.ok) {
    return episodes;
  }

  return ok({
    characters: [...declared].map(([id, name]) => ({ id, name })),
    episodes: episodes.data,
    routes: routes.data,
  });
}

/** Every section once, nothing outside the material, every route legible. */
function readRoutes(
  answer: GroupingAnswer,
  sections: readonly MaterialSection[],
  declared: ReadonlyMap<string, string>
): Result<ReadonlyMap<string, readonly ImportDestination[]>> {
  const known = new Set(sections.map(({ id }) => id));
  const routes = new Map<string, readonly ImportDestination[]>();

  for (const entry of answer.sections) {
    if (!known.has(entry.id)) {
      return fail("section", `sekcji ${entry.id} nie ma w materiale`);
    }

    if (routes.has(entry.id)) {
      return fail("section", `sekcja ${entry.id} występuje w odpowiedzi dwa razy`);
    }

    const destinations = destinationsOf(entry, declared);

    if (!destinations.ok) {
      return destinations;
    }

    routes.set(entry.id, destinations.data);
  }

  const missing = sections.filter(({ id }) => !routes.has(id)).map(({ id }) => id);

  return missing.length === 0
    ? ok(routes)
    : fail("section", `bez przydziału zostały sekcje: ${missing.join(", ")}`);
}

/** One section's routes, read: at least one, none twice, `other` alone, characters declared. */
function destinationsOf(
  entry: GroupingAnswer["sections"][number],
  declared: ReadonlyMap<string, string>
): Result<readonly ImportDestination[]> {
  if (entry.routes.length === 0) {
    return fail("route", `sekcja ${entry.id} nie dostała przydziału`);
  }

  if (new Set(entry.routes).size !== entry.routes.length) {
    return fail("route", `sekcja ${entry.id} ma ten sam przydział dwa razy`);
  }

  if (entry.routes.includes("other") && entry.routes.length > 1) {
    return fail("other", `sekcja ${entry.id}: przydział other stoi sam, a dostała też inne`);
  }

  const destinations: ImportDestination[] = [];

  for (const route of entry.routes) {
    const destination = destinationOf(route);

    if (destination === null) {
      return fail("route", `sekcja ${entry.id}: nieznany przydział "${route}"`);
    }

    if (destination.kind === "character" && !declared.has(destination.id)) {
      return fail(
        "character",
        `sekcja ${entry.id} trafia do postaci "${destination.id}", której nie zadeklarowano`
      );
    }

    destinations.push(destination);
  }

  return ok(destinations);
}

function destinationOf(route: string): ImportDestination | null {
  if (PLAIN.has(route)) {
    return { kind: route as "other" | "series" | "style" };
  }

  const colon = route.indexOf(":");
  const kind = route.slice(0, colon);
  const id = route.slice(colon + 1);

  if (kind === "character" && SLUG.test(id)) {
    return { id, kind };
  }

  return kind === "episode" && EPISODE.test(id) ? { id, kind } : null;
}

/**
 * Each declared character is routed to, and named, as written, by a section
 * routed to it: a character the model made up has no such section.
 */
function checkCharacters(
  sections: readonly MaterialSection[],
  routes: ReadonlyMap<string, readonly ImportDestination[]>,
  declared: ReadonlyMap<string, string>
): Result<true> {
  for (const [id, name] of declared) {
    const own = sections.filter((section) =>
      (routes.get(section.id) ?? []).some(
        (destination) => destination.kind === "character" && destination.id === id
      )
    );

    if (own.length === 0) {
      return fail("character", `postać "${id}" zadeklarowano, ale żadna sekcja do niej nie trafia`);
    }

    if (!own.some((section) => section.text.includes(name))) {
      return fail(
        "character-name",
        `imienia "${name}" (postać "${id}") nie ma w żadnej sekcji, która do niej trafia: ${own.map((section) => section.id).join(", ")}`
      );
    }
  }

  return ok(true);
}

/** The episode ids in order of first appearance, numbered 01, 02, … in that order. */
function numberedEpisodes(
  sections: readonly MaterialSection[],
  routes: ReadonlyMap<string, readonly ImportDestination[]>
): Result<readonly string[]> {
  const episodes: string[] = [];

  for (const section of sections) {
    for (const destination of routes.get(section.id) ?? []) {
      if (destination.kind === "episode" && !episodes.includes(destination.id)) {
        episodes.push(destination.id);
      }
    }
  }

  for (const [index, id] of episodes.entries()) {
    const expected = String(index + 1).padStart(2, "0");

    if (!id.startsWith(`${expected}-`)) {
      return fail(
        "episode-order",
        `odcinki numeruje się od 01 w kolejności, w jakiej pojawiają się w materiale; "${id}" pojawia się jako ${expected}`
      );
    }
  }

  return ok(episodes);
}
