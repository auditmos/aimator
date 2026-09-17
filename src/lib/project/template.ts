/**
 * Internal to the project module. The shared-rules document is scaffolded with
 * explicit markers rather than prose, so "has the human actually filled this
 * in?" is a file read instead of a judgement call. Ported from the source
 * project's series template, which had the same sections but no marker — there
 * the check was "is the file nonempty", and placeholders slipped through.
 */

export const PLACEHOLDER = "TODO(etap-0)";

export function renderRules(title: string): string {
  return `# ${title} — zasady wspólne

> Uzupełnij każdy ${PLACEHOLDER} zatwierdzonymi ustaleniami, a następnie usuń ten cytat.
> Nie kopiuj ustawień ani fabuły innego projektu jako domyślnych.
> Póki został choć jeden ${PLACEHOLDER}, \`aimator check\` nie przepuści etapu 0.

## Zatwierdzone założenia

- Temat projektu: ${PLACEHOLDER} co łączy odcinki.
- Zasada odcinka: ${PLACEHOLDER} co opowiada pojedynczy odcinek i jak wiąże się z resztą.
- Odbiorcy i ton: ${PLACEHOLDER} dla kogo i jak opowiadamy.
- Świat i czas akcji: ${PLACEHOLDER} ustalenia wspólne.

## Bohaterowie i wygląd

- Główny bohater i jego rola: ${PLACEHOLDER} uczestnik wydarzeń, obserwator, narrator.
- Stałe cechy wyglądu i stroju: ${PLACEHOLDER} kolor i kształt włosów, krój i barwa stroju,
  cechy szczególne. Przy \`characterBasis: "description"\` **to jest jedyne wejście etapu
  postaci** — czego tu nie ma, tego model dopowie sobie inaczej w każdym przebiegu.
- Stała obsada drugoplanowa: ${PLACEHOLDER} albo jawne „brak stałej obsady".
- Styl wizualny: ${PLACEHOLDER} zatwierdzony kierunek.
- Materiały postaci: podstawa i zdjęcia wynikają z \`project.json\` (\`characterBasis\`,
  \`characterSources\`); nie wpisuj tu akceptacji, która nie nastąpiła.

## Obraz i ciągłość

- Proporcje obrazu: zapisane w \`project.json\` jako \`aspectRatio\`.
- Otwarcie: ${PLACEHOLDER} wymagana kompozycja albo jawny brak dodatkowych ograniczeń.
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
