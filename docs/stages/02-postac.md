# Etap 2: postać

Pierwszy etap obrazowy i pierwszy, który **rozgałęzia się na dwa tory modelowe**. Buduje
kanoniczny wygląd każdej powracającej postaci: kartę, osiem widoków i obraz bohaterski.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, a przy podstawie `design` albo `photographs` także `characters/<id>/sources/` |
| **Wyjście** | `card.png` → 8 widoków → `hero.png`, `character.stage.json`, `runs/<runId>/`, **per postać i per tor** |
| **Bramka** | zatwierdzony [etap 0](00-przygotowanie.md); potem ocena każdego obrazu z osobna |
| **Koszt** | płatny; do dziesięciu wywołań obrazowych na postać i tor |

Nie zależy od [etapu 1](01-scenariusz.md), więc scenariusz i postacie mogą powstawać
równolegle.

## Komendy

```bash
pnpm dev character generate dzielna-ewa ewa --track gpt-image --dry-run
pnpm dev character generate dzielna-ewa ewa --track gpt-image
pnpm dev approve dzielna-ewa ewa --stage character --track gpt-image \
  --artifact card --note "podobieństwo się zgadza"
pnpm dev character generate dzielna-ewa ewa --track gpt-image   # osiem widoków
pnpm dev check dzielna-ewa ewa --stage character --track gpt-image
```

Dodatkowe flagi: `--artifact card|hero|<widok>,...`, `--model <id>`, `--json`,
`--regenerate`, `--instruction <uwaga>` (tylko razem z `--regenerate` i jednym `--artifact`).

`--regenerate --artifact card --instruction "Przywróć brakującą rękę."` poprawia
opublikowany obraz zamiast rysować go od zera: idzie on jako `Image 1: previous:card`, przed
obrazami postaci, kartą i widokami, a model zmienia tylko to, co nazywa uwaga. Poprzedni obraz liczy
się do limitu toru, więc hero na seedream, które już niesie dziesięć obrazów, z uwagą jest
odmową z liczbami. Szczegóły na stronie [etapu 5](05-referencje.md#poprawka-z-uwagą).

Nazwy widoków: `front`, `slight-left`, `slight-right`, `three-quarter-left`,
`three-quarter-right`, `profile-left`, `profile-right`, `rear`.

## Skąd postać bierze wygląd

Z podstawy, którą ustawia [etap 0](00-przygotowanie.md), i każda z trzech mówi modelowi
co innego:

- **`design`**: obrazy idą jako `Image N: design 01-front.png`, a prompt każe odwzorować
  projekt wiernie (proporcje, twarz, włosy, kolory, kostium, materiały) i niczego w nim
  nie poprawiać, bo projekt jest już w stylu serii.
- **`photographs`**: obrazy idą jako `Image N: photograph portret.jpg`, a prompt przenosi
  kształty osoby do stylu serii, bez pikseli, faktury i światła zdjęcia.
- **`description`**: nie idzie żaden obraz, a jedynym źródłem jest opis w `project.md`.

Obrazem głównym jest pierwszy według nazwy pliku. Karta niesie wszystkie obrazy postaci,
widok obraz główny, kartę i resztę, a hero obraz główny, kartę, osiem widoków i resztę
(na seedream bez reszty, bo tor przyjmuje dziesięć obrazów).

## Etap 2 jako obiekt

`--json` wypisuje **obiekt, który zwraca moduł etapu**, bez osobnego formatu, plus pola
`command` i `stage`:

```bash
pnpm dev check dzielna-ewa ewa --stage character --track gpt-image --json
pnpm dev approve dzielna-ewa ewa --stage character --track gpt-image --artifact card --json
pnpm dev character generate dzielna-ewa ewa --track gpt-image --dry-run --json
```

Raport `generate` niesie `paidCalls`, i to **pierwszy rachunek w tym potoku, który jest
zbiorem, a nie rzutem monetą**: jedno polecenie rysuje jeden obraz albo osiem. Liczy to,
co naprawdę zostanie kupione, a nie to, o co ktoś poprosił: widoki czekają na zatwierdzoną
kartę, więc `--artifact card,front` to dwa artefakty i **jeden** zakup. Tekst drukuje tę
samą liczbę (`płatnych wywołań do wykonania`), bo na etapie obrazowym jedno wywołanie to
jeden obraz; [panel etapu 2](../ui.md) mówi wprost „obrazy", bo to o obrazach decyduje
człowiek.

Obrazy są też **serwowane** przez lokalne UI jako PNG, adresowane krotką (projekt, etap,
artefakt) z torem i postacią obok niej. Zatwierdzanie obrazu w terminalu jest
zatwierdzaniem nazwy pliku, i to jest luka, którą panel zamyka.

## Kolejność jest bramką

Jedno polecenie produkuje w tej kolejności `card.png`, osiem widoków i `hero.png` pod
`characters/<postać>/<tor>/`. **Bez flag robi następny krok i przestaje**, bo osiem
widoków czeka na zatwierdzoną kartę, a `hero.png` na zatwierdzone widoki, i ani jednej
z tych bramek nie otwiera sama walidacja.

`--artifact card|hero|<widok>[,...]` zawęża przebieg. `--regenerate` wymaga jawnego
`--artifact`, bo nowa opłata ma adresata.

Akceptacja dotyczy jednego obrazu naraz i jest związana z jego sha256. `approve` odmawia
bez `--artifact`: przyjęcie karty uruchamia osiem płatnych wywołań, więc musi być czymś,
co ktoś napisał.

Gdy po narysowaniu zmieni się wejście obrazu (np. `project.json` po dopisaniu postaci do
obsady albo karta narysowana ponownie pod gotowymi widokami), `check` cofa zgodę i mówi,
które pliki się zmieniły. Rozstrzyga to człowiek, jak na każdym ocenianym etapie: obejrzyj
obraz jeszcze raz obok nowej wersji i zatwierdź go ponownie (`approve` wiąże wtedy zgodę z
wejściami w ich obecnej postaci) albo kup go od nowa z `--regenerate --artifact <obraz>`.

## Model i klucz

`--model <id>`, a bez tej flagi `AIMATOR_IMAGE_MODEL_GPT_IMAGE` albo
`AIMATOR_IMAGE_MODEL_SEEDREAM`: jedna zmienna na tor, żeby oba dało się puścić z jednej
powłoki. Wartości domyślnej nie ma. Klucz (`OPENAI_API_KEY` albo `BYTEPLUS_MODELARK`)
czytany jest wyłącznie na ścieżce płatnej; `--dry-run` pokazuje każdy prompt w całości,
nie sięgając po sekret ani po sieć.

## Wznowienie przerwanej próby

Zwykle wznawia się **bez drugiej opłaty**: powtórz to samo polecenie. Odpowiedź, która
zdążyła trafić na dysk, jest już opłacona. Gpt-image niesie w niej bajty, seedream adres
ważny 24 h.

## Obrazy stylu generowane z Style Bible

Gdy projekt rozstrzygnął [obrazy stylu](00-przygotowanie.md#obrazy-stylu) jako
generowane (`project style <id> --generated --count <1-4>`), powstają obok etapu 2, na
poziomie projektu, **osobno na każdym torze**: dwa modele obrazu to dwie ręce, a obraz
stylu jednego toru przy drugim mieszałby je w jednym rysunku.

```bash
pnpm dev style generate dzielna-ewa --track gpt-image --dry-run
pnpm dev style generate dzielna-ewa --track gpt-image
pnpm dev approve dzielna-ewa --stage style --track gpt-image --artifact S01,S02
pnpm dev check dzielna-ewa --stage style --track gpt-image
```

| | |
|---|---|
| **Wejście** | `project.json` (kadr z `aspectRatio`, obsada), `project.md` (blok Style Bible), `style.json` (liczba) |
| **Wyjście** | `style/<tor>/Snn.png`, `style/<tor>/style.stage.json`, `style/<tor>/runs/<runId>/` |
| **Bramka** | zatwierdzony [etap 0](00-przygotowanie.md) i blok Style Bible bez `TODO(etap-0)`; potem ocena każdego obrazu z osobna |
| **Koszt** | jedno płatne wywołanie na obraz, najwyżej cztery na tor |

`style generate` rysuje **każdy brakujący** `Snn` decyzji i mówi, ile wywołań wykona,
zanim je wykona; `--artifact S01` zawęża przebieg, a `--regenerate` wymaga jawnego
`--artifact`. `--dry-run` pokazuje przeszkody (niezatwierdzony etap 0, Style Bible
z `TODO(etap-0)`), liczy wtedy zero płatnych wywołań i i tak drukuje każdy prompt w
całości. Flagi poza tym jak w `character generate`: `--model <id>`, `--json`.

Prompt jest po angielsku i ma jawną wersję: obraz stylu N z M to neutralna scena ze świata
serii opisanego w `project.md`, **bez żadnej postaci z obsady**, która pokazuje dokładnie
medium, kreskę, cieniowanie, paletę, teksturę i światło ze Style Bible. `project.md` jedzie
w nim dosłownie, jak w każdym obrazie. Kadr to kadr filmu, ten sam co w etapach 5 i 6.

**Zgoda jest per obraz**: `approve <id> --stage style --track <tor> --artifact S01`
odmawia bez `--artifact` i wiąże przyjęcie z sha256 obrazu. Etapy 5, 6 i 7 dołączają
wyłącznie **zatwierdzone** obrazy stylu swojego toru, a niezatwierdzony zatrzymuje kadr
z powodem i poleceniem w `note`, a że zatrzymuje każdy kadr toru, stoi też w `problems`
etapu, skąd czyta go `status`. Zmiana `project.md`, `project.json` albo `style.json`
cofa zgodę na obraz stylu tak jak na każdy inny obraz.

---

[← etap 1](01-scenariusz.md) · [README](../../README.md) ·
[etap 3: lista ujęć →](03-lista-ujec.md) · [pełny kontrakt](../pipeline.md)
