# Etap 0: przygotowanie projektu i odcinka

Rozmowa, nie generacja. Ustala zasady wspólne serii i sześć decyzji odcinka. **Żadne
polecenie tego etapu nie woła płatnego API.**

| | |
|---|---|
| **Wejście** | Twój pomysł, plik źródłowy odcinka, opcjonalnie zdjęcia postaci i obrazy stylu |
| **Wyjście** | `project.json`, `project.md`, `style.json`, `style/sources/`, `source.md`, `episode.json`, `characters/<id>/sources/` |
| **Bramka** | `check`, potem `approve`; otwiera etapy 1 i 2 |
| **Koszt** | darmowy |

## Najprościej: skillem

```
/prepare-project
```

Zbiera decyzje w rozmowie i sam woła poniższe polecenia. Jeśli masz dopiero mglisty
pomysł i nie umiesz odpowiedzieć, o czym to ma być ani jak ma wyglądać, zacznij o krok
wcześniej, bo `/develop-series` doprowadzi Cię do tych odpowiedzi i przekaże je dalej.

Fabuła odcinka **nie** powstaje w żadnym z nich: opracowuje ją [etap 1](01-scenariusz.md)
ze wskazanego pliku źródłowego.

## Ręcznie

```bash
pnpm dev project init dzielna-ewa --title "Dzielna Ewa" --aspect-ratio 16:9
# uzupełnij każdy TODO(etap-0) w project.md; to jedyny plik pisany ręcznie
# wymień każdą powracającą postać, nie tylko główną
pnpm dev character new dzielna-ewa ewa --name "Ewa"
pnpm dev character add dzielna-ewa ewa --source ~/Zdjecia/portret.jpg
# albo, jeśli zdjęć nie będzie i postać powstaje z opisu:
pnpm dev character describe dzielna-ewa ewa
pnpm dev episode add dzielna-ewa --source '~/burza/01-burza.md'
pnpm dev episode set dzielna-ewa 01-burza \
  --duration 60 --audio music-and-effects --language pl --subtitles pl \
  --nature law-or-idea --max-clip 6
pnpm dev check dzielna-ewa
pnpm dev approve dzielna-ewa --note "przeczytane i przyjęte"
```

Narratora obsadza się osobno i dopiero wtedy, gdy film ma mieć narrację:

```bash
pnpm dev project voice dzielna-ewa --voice-id <id głosu>
```

Głos jest **obsadą, nie konfiguracją**: powraca między odcinkami, więc mieszka
w `project.json` obok postaci, a nie w zmiennej środowiskowej, która dałaby drugiemu
odcinkowi innego lektora bez śladu na dysku. Bramkuje wyłącznie
[etap 9](09-narracja.md); film bez narracji nigdy nie musi tej decyzji podejmować.

Obrazy stylu też można rozstrzygnąć później, ale nie da się ich pominąć, bo czekają na nie
etapy 5, 6 i 7:

```bash
pnpm dev project style dzielna-ewa --source ~/Styl/kadr-1.png --source ~/Styl/kadr-2.png
# albo generowane z Style Bible, dwa na każdy tor:
pnpm dev project style dzielna-ewa --generated --count 2
# albo jawnie bez obrazów stylu:
pnpm dev project style dzielna-ewa --none
```

Co to zmienia i czego nie, opisuje sekcja [Obrazy stylu](#obrazy-stylu).

Każde polecenie zapisujące przyjmuje `--dry-run`: pokazuje, co powstanie, i nie zapisuje
niczego. `--workspace <ścieżka>` nadpisuje `AIMATOR_WORKSPACE` dla jednego wywołania.

Co projekt już trzyma, pokazuje jedno polecenie, które niczego nie zapisuje:

```bash
pnpm dev project show dzielna-ewa
```

```
Projekt "dzielna-ewa": Dzielna Ewa
  Proporcje: 16:9
  Narrator: 21m00Tcm4TlvDq8ikWAM
  Obrazy stylu: wnoszone (2)
  Obsada:
    ewa   Ewa   ze zdjęć (1)
    tata  Tata  z opisu w project.md
```

To **opis, nie werdykt**: czy obsada, proporcje i zasady wystarczają, odpowiada `check`.
Pole, którego nikt nie rozstrzygnął, pokazuje się jako nierozstrzygnięte, a nie znika.
Pod `--json` wypisuje ten sam opis jako obiekt (`command`, `projectId`, `title`,
`aspectRatio`, `narratorVoiceId`, `style` z `basis`, `images` i `sources`, `cast` z `id`,
`name`, `basis` i `sources`), bez pola `stage`, bo nie jest raportem etapu. Styl, którego
nikt nie rozstrzygnął, ma `basis: null` i w tekście „nierozstrzygnięte”.

To samo o poziom niżej, dla jednego odcinka:

```bash
pnpm dev episode show dzielna-ewa 01-burza
```

```
Odcinek "01-burza" (nr 1) w projekcie "dzielna-ewa"
  Źródło: projects/dzielna-ewa/episodes/01-burza/source.md
    skopiowane z: /Users/ktos/Filmy/01-Burza.md
  Rodzaj źródła: law-or-idea
  Długość: 30 s
  Dźwięk: narration
  Język: pl
  Napisy: none
  Najdłuższy klip: nierozstrzygnięte
```

Też opis, nie werdykt, i z tego samego powodu: `episode set` zapisuje decyzje, `check`
je ocenia, a dopiero to polecenie mówi, jakie są teraz. Pod `--json` wypisuje obiekt
(`command`, `projectId`, `episodeId`, `number`, `source` z `path` i `originPath`,
`settings` z sześcioma decyzjami, `null` tam, gdzie nikt nie zdecydował).

## Pomysł bez pliku

Pomysł na jedno zdanie nie musi leżeć w pliku. `--idea` przyjmuje go wprost, a `--episode`
niesie to, co niosłaby nazwa pliku bez `.md`, czyli numer i slug:

```bash
pnpm dev episode add dzielna-ewa --idea "Wanda boi się zasnąć" --episode 03-wanda \
  --nature law-or-idea
```

`--episode` jest wymagane, bo **numer odcinka to decyzja**: wyznacza katalog wyników,
więc nie jest wyliczany z kolejnego wolnego. Sprawdza go ten sam walidator co nazwę pliku,
a zajęty numer to ta sama odmowa. `source.md` to tekst pomysłu zakończony nową linią,
z hashem jak każde źródło. `--idea` wyklucza się z `--source`, pusty pomysł albo same
białe znaki to błąd użycia, a pozostałe flagi decyzji działają bez zmian.

Nic nie zostało skopiowane, więc `episode.json` ma `source.originPath: null`, a
`episode show` zamiast ścieżki pisze „pomysł wpisany w poleceniu”.

## Paczka scenariuszy

Scenariusze przygotowane wcześniej dodaje się jednym poleceniem, wskazując `--source`
**katalog** zamiast pliku:

```bash
pnpm dev episode add dzielna-ewa --source ~/burza/odcinki --duration 20 --audio narration
```

Każdy plik `NN-*.md` leżący wprost w katalogu staje się jednym odcinkiem, z tą samą regułą
nazwy co pojedynczy plik; podkatalogów narzędzie nie przegląda. Inne pliki i podkatalogi
są pomijane i **wymienione w raporcie**, a pliki z kropką na początku (`.DS_Store`) to
mowa systemu plików, nie odcinki, więc nie trafiają nawet tam. Flagi decyzji podane przy
`add` obowiązują każdy odcinek paczki, a `originPath` każdego wskazuje jego własny plik.

Paczka to **wszystko albo nic**. Najpierw walidowana jest cała: nazwy, kolizje numerów
z istniejącymi odcinkami i między plikami paczki (dwa pliki `03-*`). Jeden zły plik
odrzuca ją w całości, zanim cokolwiek się zapisze, a odmowa wymienia każdy problem, nie
tylko pierwszy, bo poprawiając katalog, potrzebujesz całej listy. Katalog bez żadnego
`.md` to błąd.

`--dry-run` pokazuje, jakie odcinki powstaną, i niczego nie zapisuje. Pod `--json` raport
`episode add` niesie `episodes` (`episodeId`, `number`, `originPath` każdego odcinka)
i `skipped` (pominięte nazwy); przy pojedynczym pliku albo pomyśle `episodes` ma jedną
pozycję, a `skipped` jest puste.

## Etap 0 jako obiekt

Każde polecenie tego etapu przyjmuje `--json` i wypisuje **obiekt, który zwraca moduł
etapu**, bez osobnego formatu, plus dwa pola mówiące, skąd się wziął:

```bash
pnpm dev check dzielna-ewa --stage prepare --json
```

```json
{
  "command": "check",
  "stage": "prepare",
  "approved": false,
  "changedSinceApproval": [],
  "created": [],
  "nextStep": "pliki się zgadzają, ale nikt ich jeszcze nie przyjął: aimator approve dzielna-ewa",
  "problems": [],
  "ready": true,
  "reused": ["01-burza"]
}
```

`changedSinceApproval` to pliki przyjęte przez człowieka, których bajty zmieniły się od
tamtej zgody. Wypełnia je tylko `check` i w praktyce może tam trafić jedynie `project.md`,
jedyny plik etapu 0 pisany ręcznie, więc jedyny, który zmienia się poza narzędziem. Zdanie
o tym samym zostaje w `problems`; pole jest dla czytelnika, który zdań nie parsuje, na
przykład dla panelu etapu 0, który po nim odróżnia „zasady się zmieniły, przeczytaj je
jeszcze raz” od „nikt ich jeszcze nie przeczytał”.

`stage` brzmi `prepare` dla wszystkich ośmiu poleceń, bo wszystkie piszą jeden artefakt.
`command` ma tu **dwa słowa**, i to nie jest niekonsekwencja wobec etapu 1: tam `stage`
i `command` składają się w całe wywołanie (`screenplay generate`), a tutaj jeden etap
zapisują trzy gramatyki, więc pole mówiące `add` dla `character add` i dla `episode add`
odpowiadałoby na pytanie „która komenda to wypisała" zgadywanką.

`--stage prepare` zawęża `check` do etapu 0, także wtedy, gdy w wywołaniu stoi odcinek.
Bez tej flagi `check <id> <episode-id>` skleja werdykty etapów 0, 1, 3 i 4 w jeden tekst,
którego nie da się rozłożyć z powrotem: to dobre pytanie dla człowieka przy terminalu
i złe dla wszystkiego, co chce werdyktu samego etapu 0. Identyfikator w wywołaniu mówi,
o który odcinek chodzi, nigdy o który etap.

Panel etapu 0 w [lokalnym UI](../ui.md) czyta właśnie te obiekty, a plik podaje się w nim
**ścieżką w polu tekstowym**, przekazywaną do `--source` bez zmian. Dzięki temu
`episode.json` zapisuje w `source.originPath` miejsce, z którego plik naprawdę pochodzi;
upload przez przeglądarkę zapisałby katalog tymczasowy i odpowiedź na pytanie „skąd to
jest" przestałaby istnieć.

## Co powstaje

```
$AIMATOR_WORKSPACE/projects/dzielna-ewa/
├── project.json        identyfikator, tytuł, proporcje, obsada, narratorVoiceId
├── project.md          zasady wspólne, pisane ręcznie
├── style.json          decyzja o obrazach stylu: supplied albo none
├── prepare.stage.json  pochodzenie i ocena
├── style/sources/      obrazy stylu, skopiowane jako S01.png, S02.png… i zahashowane
├── characters/ewa/sources/   zdjęcia tej postaci, skopiowane i zahashowane
└── episodes/01-burza/
    ├── source.md       kopia bajtowa Twojego opisu albo wpisany pomysł
    ├── episode.json    decyzje odcinka
    └── prepare.stage.json
```

Katalog powstaje dopiero wtedy, gdy coś do niego pisze; pusty folder byłby obietnicą,
której narzędzie nie dotrzymuje.

## Dwie decyzje projektu

| Decyzja | Wartość |
|---|---|
| `--aspect-ratio` | np. `16:9`; po powstaniu obrazów nie da się zmienić bez ich unieważnienia |
| obsada | każda powracająca postać, z identyfikatorem, nazwą i własną podstawą |

**Obsada jest decyzją, nie wnioskiem.** Pusta obsada blokuje bramkę, bo projekt bez
zadeklarowanej postaci znaczył kiedyś „dokładnie jedna, bezimienna", i właśnie ten cichy
domysł sprawiał, że seria opisująca dwie osoby produkowała jedną, a którą, rozstrzygał
model. Kryterium jest powracalność: postać, której tożsamość musi przetrwać między
odcinkami, należy do obsady; twarz widziana raz to referencja [etapu 5](05-referencje.md).

Każda postać ma **własną podstawę**, więc jedną możesz zbudować ze zdjęć, a resztę
z opisu. Podstawa istnieje, bo pusty katalog na zdjęcia nie odróżnia „świadomie bez
zdjęć" od „jeszcze nie dodałem". Przy `photographs` bramka blokuje, dopóki nie ma ani
jednego zdjęcia tej postaci. Przy `description` **jedynym** wejściem etapu postaci jest
opis jej wyglądu w `project.md`, i wtedy to on musi być konkretny, bo nic dalej go nie
uzupełni. `character add` samo w sobie jest deklaracją i przestawia podstawę na
`photographs`.

## Style Bible

`project.md` ma jeden blok po angielsku, **Style Bible**: cztery pola, które opisują
rysunek całej serii. Każde startuje ze znacznikiem `TODO(etap-0)`, więc blokuje bramkę jak
każdy inny wiersz zasad.

| Pole | Co zawiera |
|---|---|
| `Style line` | linia stylu: 5–7 fraz w kolejności Style Stacku, wklejana dosłownie do każdego promptu obrazu |
| `Palette` | paleta: 5–8 barw, każda z wartością hex |
| `Linework rule` | reguła kreski: grubość konturu zewnętrznego i wewnętrznego, zwężenie, kolor |
| `Always / never` | lista „zawsze / nigdy": twarde nakazy i zakazy rysunku albo jawne `none` |

Angielski wynika z [reguły 9](../../AGENTS.md#pipeline-rules), nie z wygody. `project.md`
trafia w całości do każdego płatnego obrazu i klipu, a ten blok jest w nim instrukcją dla
modelu, nie materiałem. Reszta pliku zostaje po polsku, więc prompt jest dwujęzyczny
z założenia. Jawne `none` w ostatnim polu jest odpowiedzią, tak samo jak „brak" przy
rekwizytach: mówi, że zakazów nie ma, a nie, że nikt o nie nie zapytał.

Linia stylu ma 5–7 fraz, a nie „opisz styl", bo `project.md` jedzie w każdym wywołaniu
obrazu, a rozdmuchana linia uśrednia się w sposób, którego nie da się przewidzieć. To ten
sam dryf stylu, przed którym blok ma chronić.

**Style Bible opisuje rysunek jako całość**: medium, kreskę, cieniowanie, paletę, teksturę
i światło. Wiersze „Proporcje i stylizacja postaci" oraz „Relacje i wspólne zasady
rysowania postaci" opisują konkretne postacie i to, jak mają się do siebie. Rozstrzyga
jedno pytanie: *czy ten fakt przestaje być prawdziwy, gdy wymienisz obsadę?* Jeśli tak,
należy do postaci, nie do Style Bible. Dzięki temu żadna prawda nie stoi w dwóch miejscach,
które rozjechałyby się przy pierwszej ręcznej poprawce.

Jak zamienić „ciepły, bajkowy" w te cztery pola, z gotowymi liniami i ceną każdej rodziny
stylów, pokazuje [docs/styl.md](../styl.md). Słowa ustala [słownik](../slownik.md).

Szkielet `project.md` powstaje wyłącznie przy `project init`, więc istniejący plik nigdy
nie dostaje tego bloku sam i jego zgoda nie wygasa. Dopisanie bloku ręcznie to zwykła
edycja zasad, która wygasza zgodę etapu 0 jak każda inna.

## Obrazy stylu

Style Bible mówi modelowi słowami, jak wygląda seria. **Obrazy stylu** pokazują mu to:
kilka kadrów w docelowym medium, które etapy 5, 6 i 7 dołączają do każdego kadru filmu.
To decyzja projektu bez wartości domyślnej: obrazy wnoszone (`supplied`), generowane
z Style Bible osobno na każdym torze (`generated`) albo jawnie żadne (`none`).

| Polecenie | Co zapisuje |
|---|---|
| `project style <id> --source <plik.png>` | kopiuje obraz do `style/sources/S01.png` (kolejne S02, S03…) z sha256 i ustawia `supplied`; można powtarzać, te same bajty drugi raz to ten sam obraz |
| `project style <id> --generated --count <1-4>` | ustawia `generated` i liczbę obrazów na tor; liczba to decyzja bez wartości domyślnej, a `--generated` bez `--count` to błąd użycia. Same obrazy rysuje `style generate`, opisane przy [etapie 2](02-postac.md#obrazy-stylu-generowane-z-style-bible) |
| `project style <id> --none` | jawne „bez obrazów stylu”; obrazy już wniesione zostają na dysku, ale nie są dołączane |

Przyjmowany jest wyłącznie PNG, bo plik ląduje w katalogu roboczym jako `Snn.png`.

**Decyzja mieszka w `style.json`, nie w `project.json`.** `project.json` jest zapisanym
wejściem niemal każdego artefaktu, więc zmiana stylu w nim cofałaby zgody na scenariusze
i listy ujęć, na które styl nie wpływa. `style.json` i obrazy stylu są wejściami wyłącznie
kadrów etapów 5, 6 i 7 (referencji, klatki otwarcia i klatek wejściowych), więc ich zmiana
cofa zgody na te kadry i na nic innego. Klip nie dostaje obrazów stylu: zaczyna się od
klatki, która już je niosła.

**Wnoszenie plików z zewnątrz to monopol etapu 0**, więc obraz wniesiony jest wyjściem
tego etapu, zapisanym w `prepare.stage.json` projektu obok `project.json`. Nie ma własnej
oceny: przyjmuje go `approve` etapu 0, a dodanie obrazu po zatwierdzeniu cofa tę zgodę
dokładnie tak jak `character add`. Do tego czasu kadry etapów 5–7 czekają z powodem
w `note`.

**Brak decyzji to nie „bez stylu”.** Bez `style.json` etapy 5, 6 i 7 odmawiają z
poleceniem, które ją podejmuje; etapy 0–4 działają bez niej. Odcinek w toku zatrzyma się
więc na etapie 5, dopóki ktoś nie zdecyduje, a `project style <id> --none` to jedna linia.

Obrazy stylu idą **po** załącznikach treści, jako `Image N = style:S01 — style frame:
medium, line, shading, palette, texture and lighting only; not content`, i liczą się do
limitu referencji toru. Przekroczenie limitu to odmowa przed wysyłką, z liczbami, nigdy
ciche obcięcie. Przy `generated` każdy tor dołącza **wyłącznie swoje** obrazy stylu i tylko
te, które ktoś przyjął przez `approve --stage style`; brakujący albo nieprzyjęty zatrzymuje
kadr z poleceniem, które go kupuje albo przyjmuje.

## Sześć decyzji odcinka

Pięć z nich blokuje bramkę tego etapu. Szósta, `--max-clip`, jest wymagana dopiero przez
[etap 3](03-lista-ujec.md), można ją więc podjąć później, ale nie da się jej pominąć.

| Pole | Wartość | Kto wymaga |
|---|---|---|
| `--duration` | długość w sekundach, liczba całkowita 1–3600. Schemat przyjmuje całą godzinę, ale potok obsłuży dziś kilkanaście minut; [issue #1](https://github.com/auditmos/aimator/issues/1) mówi dlaczego | etap 0 |
| `--audio` | `music-and-effects`, `dialogue`, `narration`, `dialogue-and-narration`; wszystkie zawierają muzykę i efekty. Proces obsługuje w całości `music-and-effects` i `narration` | etap 0 |
| `--language` | kod języka scenariusza i wypowiedzi; wymagany także w filmie bez mowy | etap 0 |
| `--subtitles` | kod języka albo `none`; ustalany niezależnie od `--language` | etap 0 |
| `--nature` | `law-or-idea`, `synopsis`, `screenplay`; czym jest Twój plik źródłowy | etap 0 |
| `--max-clip` | najdłuższy planowany klip w sekundach, 1–60; plan montażowy, nie zmierzony limit dostawcy | etap 3 |

Świeży `episode.json` ma je wszystkie jako `null` i jest celowo niegotowy. Nie ma
wartości domyślnych: `--duration` nie ma „zwykle 60", a `--language` nie dziedziczy się
z zasad projektu.

## Bramka

`check` przepuszcza, gdy zasady nie zawierają już żadnego `TODO(etap-0)`, obie decyzje
projektu są ustalone, wyniki zgadzają się z zapisanymi hashami i żadna z pięciu decyzji
odcinka nie jest pusta. Obrazy stylu nie bramkują etapu 0, tylko etapy 5–7, ale wniesione
obrazy są jego wynikami i ich hashe są sprawdzane jak każde inne. To kontrola **plików**. Nie potwierdza, że zasady mają sens ani
że pomysł jest dobry, i mówi to wprost zamiast udawać, że przeszło znaczy przyjęte.

Przyjęcie zapisuje osobne polecenie:

```bash
pnpm dev approve dzielna-ewa --note "przeczytane i przyjęte"
```

`approve` powtarza całą walidację i odmawia, jeśli cokolwiek nie gra; akceptacja
zapisana na zepsutym pochodzeniu byłaby kłamstwem, któremu zaufałyby kolejne etapy. Przy
okazji `project.md` dostaje wreszcie swój hash: do tej chwili pisze go człowiek, więc
hash z momentu `init` opisywałby pusty szkielet. Każda późniejsza edycja unieważnia
akceptację, a `check` to zgłasza.

---

[← README](../../README.md) · [etap 1: scenariusz →](01-scenariusz.md) ·
[pełny kontrakt](../pipeline.md)
