/**
 * Internal to the project module. The shared-rules document is scaffolded with
 * explicit markers rather than prose, so "has the human actually filled this
 * in?" is a file read instead of a judgement call. Ported from the source
 * project's series template, which had the same sections but no marker, there
 * the check was "is the file nonempty", and placeholders slipped through.
 *
 * The Style Bible is the one English block in a Polish document, by rule 9:
 * every image call receives it verbatim as an instruction, not as material.
 * Its four fields are the drawing as a whole, named as in `docs/slownik.md`;
 * figure proportions and how the cast relates already have rows above, and a
 * field repeating either would be a second place for one truth.
 */

export const PLACEHOLDER = "TODO(etap-0)";

const STYLE_BIBLE = "## Style Bible";

/**
 * Why the Style Bible cannot be drawn from yet, or nothing when it can.
 *
 * Generated style frames are drawn from this block and nothing else, so it has
 * to exist and be answered. The block runs from its heading to the next one; a
 * project scaffolded before the block existed simply has none, and is told how
 * to add it rather than drawn from rules that never stated a style.
 */
export function styleBibleProblems(rules: string): readonly string[] {
  const start = rules.indexOf(`\n${STYLE_BIBLE}\n`);

  if (start === -1) {
    return [
      `project.md nie ma bloku "${STYLE_BIBLE}", a obrazy stylu powstają wyłącznie z niego; dopisz go według docs/stages/00-przygotowanie.md#style-bible`,
    ];
  }

  const rest = rules.slice(start + STYLE_BIBLE.length + 2);
  const next = rest.indexOf("\n## ");
  const block = next === -1 ? rest : rest.slice(0, next);
  const left = block.split(PLACEHOLDER).length - 1;

  return left === 0
    ? []
    : [
        `blok Style Bible w project.md ma jeszcze ${left} znaczników ${PLACEHOLDER}, a obrazy stylu powstają wyłącznie z niego`,
      ];
}

/**
 * Every answer the rules ask for, keyed, with the label it stands under and
 * what a person is told to write there. One list for the scaffold and for a
 * draft, so a draft can fill a field only where the scaffold has one.
 */
const FIELDS = {
  alwaysNever: {
    hint: 'hard rules for the whole drawing, or an explicit "none".',
    label: "Always / never",
  },
  approved: { hint: "zakres decyzji.", label: "Zatwierdzone przez użytkownika" },
  audience: { hint: "dla kogo i jak opowiadamy.", label: "Odbiorcy i ton" },
  cast: { hint: 'albo jawne „brak stałej obsady".', label: "Stała obsada drugoplanowa" },
  continuity: {
    hint: "co ma pozostać stałe między scenami i odcinkami.",
    label: "Ciągłość i ograniczenia",
  },
  episodeRule: {
    hint: "co opowiada pojedynczy odcinek i jak wiąże się z resztą.",
    label: "Zasada odcinka",
  },
  linework: { hint: "outer and inner line weight, taper, colour.", label: "Linework rule" },
  opening: {
    hint: "wymagana kompozycja albo jawny brak dodatkowych ograniczeń.",
    label: "Otwarcie",
  },
  openQuestions: {
    hint: `wymień tylko sprawy nieblokujące scenariusza i oznacz pomysły jako propozycje.
Jeśli nie ma otwartych spraw, wpisz „Brak". Decyzje wymagane rozstrzygnij w etapie 0.`,
    label: "Propozycje i otwarte kwestie",
  },
  palette: { hint: "5–8 colours, each with a hex value.", label: "Palette" },
  prepared: {
    hint: "data i rozmowa lub dokument, na podstawie których powstały zasady.",
    label: "Przygotowano",
  },
  proportions: {
    hint: `stosunek głowy do ciała i stopień
  deformacji. To co innego niż proporcje obrazu i trzeba ustalić jedno i drugie.`,
    label: "Proporcje i stylizacja postaci",
  },
  props: {
    hint: `albo jawne „brak". Każdy wymieniony opisz: kształt,
  wielkość względem postaci, materiał, barwa, zużycie. Sama nazwa to nie opis.`,
    label: "Powracające rekwizyty",
  },
  protagonist: {
    hint: "uczestnik wydarzeń, obserwator, narrator.",
    label: "Główny bohater i jego rola",
  },
  relations: {
    hint: `jak postacie mają się do siebie
  skalą, kto jest ile wyższy i czy głowy są tej samej wielkości, oraz co jest rysowane
  identycznie u każdej z nich. Proporcja podana osobno dla każdej postaci **nie wystarcza**:
  dwie niezależne proporcje nie wyznaczają jeszcze relacji między nimi, a etap postaci
  rysuje każdą osobno.`,
    label: "Relacje i wspólne zasady rysowania postaci",
  },
  scenery: {
    hint: `miejsca, do których seria wraca, i co jest w nich
  stałe: paleta, światło, sprzęty, które nie mogą się przesuwać. Albo jawne „brak".`,
    label: "Powracająca sceneria",
  },
  styleLine: {
    hint: `5–7 comma-separated phrases in Style Stack order, repeated
  verbatim in every image prompt.`,
    label: "Style line",
  },
  theme: { hint: "co łączy odcinki.", label: "Temat projektu" },
  traits: {
    hint: `kolor i kształt włosów, krój i barwa stroju,
  cechy szczególne. Przy \`characterBasis: "description"\` **to jest jedyne wejście etapu
  postaci**, czego tu nie ma, tego model dopowie sobie inaczej w każdym przebiegu.`,
    label: "Stałe cechy wyglądu i stroju",
  },
  world: { hint: "ustalenia wspólne.", label: "Świat i czas akcji" },
} as const;

type RuleField = keyof typeof FIELDS;

/** What fills each field; a field left out keeps its marker and its hint. */
export type RuleValues = Partial<Readonly<Record<RuleField, string>>>;

/** The fields in the order `project.md` asks them, which `FIELDS`, sorted by key, cannot say. */
const ORDER: readonly RuleField[] = [
  "theme",
  "episodeRule",
  "audience",
  "world",
  "protagonist",
  "proportions",
  "traits",
  "cast",
  "relations",
  "props",
  "styleLine",
  "palette",
  "linework",
  "alwaysNever",
  "opening",
  "scenery",
  "continuity",
  "prepared",
  "approved",
  "openQuestions",
];

/** The fields `values` leaves to a person, by the label each stands under, in document order. */
export function leftOpen(values: RuleValues): readonly string[] {
  return ORDER.filter((field) => values[field] === undefined).map((field) => FIELDS[field].label);
}

/**
 * `project.md`: the scaffold when no value is given, and a draft when some are.
 *
 * A bullet's value starts after its label and its further lines are indented
 * into the bullet; a value that is itself a list starts on the line below.
 */
export function renderRules(title: string, values: RuleValues = {}): string {
  const open = (field: RuleField): string => {
    const value = values[field];

    if (value === undefined) {
      return ` ${PLACEHOLDER} ${FIELDS[field].hint}`;
    }

    const lines = value.split("\n").map((row, index) => {
      if (index === 0 || row === "") {
        return row;
      }

      return `  ${row}`;
    });

    return value.startsWith("- ") ? `\n  ${lines.join("\n")}` : ` ${lines.join("\n")}`;
  };
  const line = (field: RuleField): string => `- ${FIELDS[field].label}:${open(field)}`;

  return `# ${title}, zasady wspólne

> Uzupełnij każdy ${PLACEHOLDER} zatwierdzonymi ustaleniami, a następnie usuń ten cytat.
> Nie kopiuj ustawień ani fabuły innego projektu jako domyślnych.
> Póki został choć jeden ${PLACEHOLDER}, \`aimator check\` nie przepuści etapu 0.
> Style Bible pisz po angielsku, bo trafia do każdego obrazu jako instrukcja dla modelu.
> Opisuje rysunek jako całość: co przestaje być prawdą po wymianie obsady, należy do wierszy
> o postaciach. Metodę i gotowe linie stylu podaje \`docs/styl.md\` w repozytorium aimator.

## Zatwierdzone założenia

${line("theme")}
${line("episodeRule")}
${line("audience")}
${line("world")}

## Bohaterowie i wygląd

${line("protagonist")}
${line("proportions")}
${line("traits")}
${line("cast")}
${line("relations")}
${line("props")}
- Materiały postaci: podstawa i zdjęcia wynikają z \`project.json\` (\`characterBasis\`,
  \`characterSources\`); nie wpisuj tu akceptacji, która nie nastąpiła.

## Style Bible

${line("styleLine")}
${line("palette")}
${line("linework")}
${line("alwaysNever")}

## Obraz i ciągłość

- Proporcje obrazu: zapisane w \`project.json\` jako \`aspectRatio\`.
${line("opening")}
${line("scenery")}
${line("continuity")}

## Źródła i ustawienia odcinków

Każdy odcinek ma własny katalog w \`episodes/\` z zachowanym bajtowo \`source.md\`
oraz \`episode.json\` z długością, dźwiękiem, językiem, napisami i charakterem źródła.
Indywidualna fabuła powstaje dopiero w etapie scenariusza.

## Pochodzenie ustaleń

${line("prepared")}
${line("approved")}

## Propozycje i otwarte kwestie

${values.openQuestions ?? `${PLACEHOLDER} ${FIELDS.openQuestions.hint}`}
`;
}
