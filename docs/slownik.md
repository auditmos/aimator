# Słownik pojęć

Jedno pojęcie, jedno słowo. Ta strona ustala, jak nazywają się rzeczy, o które pyta
[etap 0](stages/00-przygotowanie.md): po polsku w rozmowie i w `project.md`, po angielsku
w instrukcjach skilli, w promptach i w kodzie.

Synonim w rozmowie staje się synonimem w prompcie. Człowiek czyta `watercolor`
i `aquarelle` jako to samo, model ciągnie każde z innych wzorców, a kto słyszy „proporcje",
nie wie, o które chodzi. Dlatego pojęcie, które tu jest, nazywa się tak, jak tu stoi,
a pojęcie, którego brakuje, dostaje nowy wiersz zamiast opisu własnymi słowami.

Kolumny po polsku i po angielsku to ten sam podział, który robi
[reguła 9](../AGENTS.md#pipeline-rules): instrukcja dla modelu jest po angielsku, materiał
zostaje w języku, w którym powstał. Słownik niczego nie tłumaczy, tylko mówi, jakim słowem
pojęcie nazywa się po każdej stronie.

## Styl

Jak te pojęcia składają się w opis rysunku, pokazuje [docs/styl.md](styl.md).

| Po polsku | In English | Co znaczy |
|---|---|---|
| **Style Bible** | Style Bible | Blok po angielsku w `project.md`, cztery pola: linia stylu, paleta, reguła kreski i lista „zawsze / nigdy". Opisuje rysunek jako całość; co przestaje być prawdą po wymianie obsady, należy do wierszy o postaciach. |
| **linia stylu** | style line | Kilka fraz po angielsku, które opisują rysunek całej serii i trafiają **dosłownie** do każdego promptu obrazu. Jedna na projekt. |
| **token** | token | Jedna fraza linii stylu, od przecinka do przecinka: `flat vector`, `thick black outline`. **Nie** jednostka tokenizera: „5–7 tokenów" to pięć do siedmiu fraz. |
| **Style Stack** | Style Stack | Osiem warstw opisu rysunku, zawsze w tej kolejności: format, medium, kreska, cieniowanie, paleta, tekstura, światło i nastrój, kompozycja. |
| **format** | format | Rodzaj filmu: animacja 2D, 3D albo poklatkowa. **Nie** kształt kadru, choć po polsku „format" bywa używany i w tym znaczeniu. |
| **medium** | medium | Z czego obraz wygląda na zrobiony: akwarela, gwasz, tusz, wektor, plastelina, papier. |
| **kreska** | linework | Narysowane linie: czy jest kontur, jak gruby, czy się zwęża, jakiego koloru. Po polsku zawsze „kreska", nigdy „linia", bo „linia" jest zajęta przez linię stylu, która jest tekstem. |
| **reguła kreski** | linework rule | Kreska zapisana jako reguła: grubość konturu zewnętrznego (outer line) i wewnętrznego (inner line), zwężenie (taper) i kolor. |
| **cieniowanie** | shading | Jak powstaje cień na postaci i przedmiocie: płaska plama, twarda granica, miękkie przejście albo brak cienia. |
| **paleta** | palette | 5–8 barw z wartościami hex, wspólna dla całej serii. Każda postać, rekwizyt i sceneria bierze barwy z niej. |
| **tekstura** | texture | Powierzchnia obrazu: gładka cyfrowa, ziarno papieru, ślad pędzla, odcisk palca w plastelinie. |
| **światło i nastrój** | lighting and mood | Skąd pada światło, jak jest kontrastowe i ciepłe, i jaki nastrój z tego wynika. |
| **kompozycja** | composition | Jak ułożony jest kadr i ile szczegółów ma tło w porównaniu z postacią. |
| **lista „zawsze / nigdy"** | always / never list | Twarde nakazy i zakazy rysunku albo jawne „brak". Tu stoi każde „bez czegoś", bo linia stylu mówi tylko, co jest. |
| **odcisk palca stylu** | style fingerprint | Dziewięć obserwacji, na które da się odpowiedzieć, patrząc na dowolny obraz. Zastępuje pytanie „jaki styl?" i rozkłada nazwę studia na decyzje. |
| **dryf stylu** | style drift | To, co model robi z luką w opisie: wypełnia ją w każdym przebiegu inaczej. W tym narzędziu dryf kosztuje regenerację, czyli kolejny płatny obraz. |

## Obsada i to, co powraca

| Po polsku | In English | Co znaczy |
|---|---|---|
| **obsada** | cast | Wszystkie postacie, które wracają między odcinkami, każda zadeklarowana w etapie 0. Twarz widziana raz to nie obsada, tylko referencja odcinka z [etapu 5](stages/05-referencje.md). |
| **rekwizyt** | prop | Przedmiot, który wraca między odcinkami. Opisany kształtem, wielkością względem postaci, materiałem, barwą i zużyciem. |
| **sceneria** | setting | Miejsce, do którego seria wraca, razem z tym, co jest w nim stałe: paletą, światłem, sprzętami. |
| **element powracający** | recurring element | Postać z obsady, rekwizyt albo sceneria: wszystko, co musi wyglądać tak samo w siódmym odcinku. Decyduje powtarzalność, nie rodzaj rzeczy. |
| **lista powracająca** | running list | Lista elementów powracających prowadzona w trakcie rozmowy. Element trafia na nią w chwili, gdy padnie w odpowiedzi, a rozmowa nie kończy się, póki każdy wpis nie jest opisany. **Nazwanie to nie opisanie**: „ma swój przedmiot" to inwentarz, nie wygląd. |
| **podstawa postaci** | character basis | Skąd etap postaci bierze wygląd: ze zdjęć (`photographs`) albo z opisu w `project.md` (`description`). W `project.json` jako `characterBasis`, bez wartości domyślnej. |
| **proporcje postaci** | figure proportions | Stosunek głowy do ciała i stopień deformacji sylwetki. W `project.md` wiersz „Proporcje i stylizacja postaci". |
| **proporcje obrazu** | aspect ratio | Kształt kadru, na przykład `16:9`. W `project.json` jako `aspectRatio`. |

## Import

Gdy seria istnieje już jako dokument, rozmowa etapu 0 zaczyna się od niego. Jak powstaje,
opisuje [docs/import.md](import.md).

| Po polsku | In English | Co znaczy |
|---|---|---|
| **import** | import | Dokument Worda skopiowany do `imports/<id>/` i zamieniony na materiał, zanim powstał projekt. Niczego nie rozstrzyga; płatny jest w nim tylko podział. |
| **materiał** | material | Treść dokumentu jako `material.md`, w słowach i języku autora: materiał w rozumieniu reguły 9. Co z niego trafi do `project.md`, jest propozycją, dopóki człowiek jej nie potwierdzi. |
| **sekcja** | section | Materiał od nagłówka do następnego, `T01`, `T02`, liczony na nowo z obecnego `material.md`. |
| **podział** | grouping | Wynik `import group`: każda sekcja przydzielona i skopiowana dosłownie do `grouped/`. Model wskazał tylko, dokąd idzie sekcja; nikt podziału nie zatwierdza. |
| **przydział** | destination | Dokąd idzie sekcja i czego dotyczy plik podziału: `series`, `style`, `character:<id>`, `episode:NN-slug` albo `other`. |
| **szkic zasad** | rules draft | `project.md` wypełniony przez model z podziału importu (`project draft`): propozycja do poprawy, nigdy „tak”. Co model tylko proponuje, a czego materiał nie mówi, stoi za `TODO(etap-0) propozycja:` i czeka na przyjęcie. |

## Proporcje i proporcje

Para, która myli się po polsku najczęściej, bo jedno słowo nazywa dwie niezależne decyzje,
a etap 0 wymaga obu.

- **Proporcje obrazu** to kształt kadru. Nie mają wartości domyślnej i nie da się ich
  zmienić, gdy istnieją już obrazy, bez unieważnienia tych obrazów.
- **Proporcje postaci** to rysunek figury: ile razy głowa mieści się w wysokości i jak
  bardzo sylwetka odchodzi od natury. To najmocniejszy wyróżnik stylu i najłatwiejszy do
  pominięcia, bo ludzie opisują najpierw kolor. Zdjęcie ich nie ustala: mówi, kim jest
  postać, a nie, jak bardzo stylizowany jest jej rysunek.

Dlatego w rozmowie żadne z tych słów nie pada samo, zawsze z dopełnieniem: „proporcje
obrazu" albo „proporcje postaci".
