# Etap 1 — scenariusz

Pierwszy etap, który **wydaje pieniądze**, i jedyny, którego wynikiem jest tekst napisany
przez model. Adaptuje Twój plik źródłowy na scenariusz podzielony na sceny.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, `source.md`, `episode.json` |
| **Wyjście** | `screenplay.md`, `screenplay.stage.json`, `runs/<runId>/` |
| **Bramka** | zatwierdzony [etap 0](00-przygotowanie.md) — projektu **i** odcinka |
| **Koszt** | jedno płatne wywołanie tekstowe |

Nie zależy od [etapu 2](02-postac.md), więc scenariusz i postacie mogą powstawać
równolegle.

## Komendy

```bash
pnpm dev screenplay generate dzielna-ewa 01-burza --dry-run
pnpm dev screenplay generate dzielna-ewa 01-burza
pnpm dev check dzielna-ewa 01-burza
pnpm dev approve dzielna-ewa 01-burza --stage screenplay --note "rytm się zgadza"
```

Dodatkowe flagi: `--model <id>`, `--max-output-tokens <n>`, `--regenerate`.

## Model i klucz

`--model <id>`, a bez tej flagi `AIMATOR_SCREENPLAY_MODEL`. Wartości domyślnej nie ma
i nie będzie: model, którego nikt nie wybrał, nie jest decyzją. Klucz (`OPENAI_API_KEY`)
czytany jest wyłącznie na ścieżce płatnej — `--dry-run` nie sięga po sekret ani po sieć,
a i tak pokazuje cały prompt.

## Bramka

`screenplay generate` odmawia płatnego wywołania, dopóki `prepare.stage.json` projektu
**i** odcinka nie mają `review.status = "approved"`, a hashe ich wyników się zgadzają.
Edycja `project.md` po akceptacji unieważnia ją arytmetycznie i etap 1 znów blokuje.
`--dry-run` tej bramki nie omija — raportuje ją jako przeszkodę, ale prompt i tak
pokazuje, bo po to jest podgląd.

## Co sprawdza walidacja

Siedem sekcji w ustalonej kolejności, żadnej pustej. Nagłówki
`### S01 | 15s | miejsce i pora dnia` numerowane kolejno od `S01`, każda scena 1–15 s,
suma czasów **dokładnie** równa `durationSeconds`. W każdej scenie dokładnie jedno
niepuste pole `Action`, `Audio`, `Text` i `End state`. Przy `subtitles: none` każde pole
`Text` musi brzmieć `none`; przy zamówionych napisach co najmniej jedno nie może.

## Wznowienie przerwanej próby

Wywołanie idzie z `store: false`, więc dostawca nic nie przechowuje i przerwanej próby nie
da się odpytać po identyfikatorze. Rekord `submitted` bez zapisanej odpowiedzi jest ślepym
zaułkiem: `check` mówi wprost, że próba mogła zostać rozliczona, a jedyną drogą dalej jest
`--regenerate`. Odpowiedź, która zdążyła trafić na dysk, jest już opłacona — powtórzenie
polecenia dokańcza z niej próbę, nie wysyłając niczego. Nic nie ponawia się samo.

---

[← etap 0](00-przygotowanie.md) · [README](../../README.md) ·
[etap 2 — postać →](02-postac.md) · [pełny kontrakt](../pipeline.md)
