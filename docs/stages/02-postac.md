# Etap 2: postać

Pierwszy etap obrazowy i pierwszy, który **rozgałęzia się na dwa tory modelowe**. Buduje
kanoniczny wygląd każdej powracającej postaci: kartę, osiem widoków i obraz bohaterski.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, a przy podstawie `photographs` także `characters/<id>/sources/` |
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
`--regenerate`.

Nazwy widoków: `front`, `slight-left`, `slight-right`, `three-quarter-left`,
`three-quarter-right`, `profile-left`, `profile-right`, `rear`.

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

---

[← etap 1](01-scenariusz.md) · [README](../../README.md) ·
[etap 3: lista ujęć →](03-lista-ujec.md) · [pełny kontrakt](../pipeline.md)
