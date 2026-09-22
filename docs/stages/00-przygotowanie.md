# Etap 0: przygotowanie projektu i odcinka

Rozmowa, nie generacja. Ustala zasady wspólne serii i sześć decyzji odcinka. **Żadne
polecenie tego etapu nie woła płatnego API.**

| | |
|---|---|
| **Wejście** | Twój pomysł, plik źródłowy odcinka, opcjonalnie zdjęcia postaci |
| **Wyjście** | `project.json`, `project.md`, `source.md`, `episode.json`, `characters/<id>/sources/` |
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

Każde polecenie zapisujące przyjmuje `--dry-run`: pokazuje, co powstanie, i nie zapisuje
niczego. `--workspace <ścieżka>` nadpisuje `AIMATOR_WORKSPACE` dla jednego wywołania.

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
  "created": [],
  "nextStep": "pliki się zgadzają, ale nikt ich jeszcze nie przyjął: aimator approve dzielna-ewa",
  "problems": [],
  "ready": true,
  "reused": ["01-burza"]
}
```

`stage` brzmi `prepare` dla wszystkich siedmiu poleceń, bo wszystkie piszą jeden artefakt.
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
├── prepare.stage.json  pochodzenie i ocena
├── characters/ewa/sources/   zdjęcia tej postaci, skopiowane i zahashowane
└── episodes/01-burza/
    ├── source.md       kopia bajtowa Twojego opisu
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
odcinka nie jest pusta. To kontrola **plików**. Nie potwierdza, że zasady mają sens ani
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
