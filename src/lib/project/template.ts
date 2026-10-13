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

export function renderRules(title: string): string {
  return `# ${title}, zasady wspólne

> Uzupełnij każdy ${PLACEHOLDER} zatwierdzonymi ustaleniami, a następnie usuń ten cytat.
> Nie kopiuj ustawień ani fabuły innego projektu jako domyślnych.
> Póki został choć jeden ${PLACEHOLDER}, \`aimator check\` nie przepuści etapu 0.
> Style Bible pisz po angielsku, bo trafia do każdego obrazu jako instrukcja dla modelu.
> Opisuje rysunek jako całość: co przestaje być prawdą po wymianie obsady, należy do wierszy
> o postaciach. Metodę i gotowe linie stylu podaje \`docs/styl.md\` w repozytorium aimator.

## Zatwierdzone założenia

- Temat projektu: ${PLACEHOLDER} co łączy odcinki.
- Zasada odcinka: ${PLACEHOLDER} co opowiada pojedynczy odcinek i jak wiąże się z resztą.
- Odbiorcy i ton: ${PLACEHOLDER} dla kogo i jak opowiadamy.
- Świat i czas akcji: ${PLACEHOLDER} ustalenia wspólne.

## Bohaterowie i wygląd

- Główny bohater i jego rola: ${PLACEHOLDER} uczestnik wydarzeń, obserwator, narrator.
- Proporcje i stylizacja postaci: ${PLACEHOLDER} stosunek głowy do ciała i stopień
  deformacji. To co innego niż proporcje obrazu i trzeba ustalić jedno i drugie.
- Stałe cechy wyglądu i stroju: ${PLACEHOLDER} kolor i kształt włosów, krój i barwa stroju,
  cechy szczególne. Przy \`characterBasis: "description"\` **to jest jedyne wejście etapu
  postaci**, czego tu nie ma, tego model dopowie sobie inaczej w każdym przebiegu.
- Stała obsada drugoplanowa: ${PLACEHOLDER} albo jawne „brak stałej obsady".
- Relacje i wspólne zasady rysowania postaci: ${PLACEHOLDER} jak postacie mają się do siebie
  skalą, kto jest ile wyższy i czy głowy są tej samej wielkości, oraz co jest rysowane
  identycznie u każdej z nich. Proporcja podana osobno dla każdej postaci **nie wystarcza**:
  dwie niezależne proporcje nie wyznaczają jeszcze relacji między nimi, a etap postaci
  rysuje każdą osobno.
- Powracające rekwizyty: ${PLACEHOLDER} albo jawne „brak". Każdy wymieniony opisz: kształt,
  wielkość względem postaci, materiał, barwa, zużycie. Sama nazwa to nie opis.
- Materiały postaci: podstawa i zdjęcia wynikają z \`project.json\` (\`characterBasis\`,
  \`characterSources\`); nie wpisuj tu akceptacji, która nie nastąpiła.

## Style Bible

- Style line: ${PLACEHOLDER} 5–7 comma-separated phrases in Style Stack order, repeated
  verbatim in every image prompt.
- Palette: ${PLACEHOLDER} 5–8 colours, each with a hex value.
- Linework rule: ${PLACEHOLDER} outer and inner line weight, taper, colour.
- Always / never: ${PLACEHOLDER} hard rules for the whole drawing, or an explicit "none".

## Obraz i ciągłość

- Proporcje obrazu: zapisane w \`project.json\` jako \`aspectRatio\`.
- Otwarcie: ${PLACEHOLDER} wymagana kompozycja albo jawny brak dodatkowych ograniczeń.
- Powracająca sceneria: ${PLACEHOLDER} miejsca, do których seria wraca, i co jest w nich
  stałe: paleta, światło, sprzęty, które nie mogą się przesuwać. Albo jawne „brak".
- Ciągłość i ograniczenia: ${PLACEHOLDER} co ma pozostać stałe między scenami i odcinkami.

## Źródła i ustawienia odcinków

Każdy odcinek ma własny katalog w \`episodes/\` z zachowanym bajtowo \`source.md\`
oraz \`episode.json\` z długością, dźwiękiem, językiem, napisami i charakterem źródła.
Indywidualna fabuła powstaje dopiero w etapie scenariusza.

## Pochodzenie ustaleń

- Przygotowano: ${PLACEHOLDER} data i rozmowa lub dokument, na podstawie których powstały zasady.
- Zatwierdzone przez użytkownika: ${PLACEHOLDER} zakres decyzji.

## Propozycje i otwarte kwestie

${PLACEHOLDER} wymień tylko sprawy nieblokujące scenariusza i oznacz pomysły jako propozycje.
Jeśli nie ma otwartych spraw, wpisz „Brak". Decyzje wymagane rozstrzygnij w etapie 0.
`;
}
