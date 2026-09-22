# Etap 1: scenariusz

Pierwszy etap, który **wydaje pieniądze**, i jedyny, którego wynikiem jest tekst napisany
przez model. Adaptuje Twój plik źródłowy na scenariusz podzielony na sceny.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, `source.md`, `episode.json` |
| **Wyjście** | `screenplay.md`, `screenplay.stage.json`, `runs/<runId>/` |
| **Bramka** | zatwierdzony [etap 0](00-przygotowanie.md), projektu **i** odcinka |
| **Koszt** | jedno płatne wywołanie tekstowe |

Nie zależy od [etapu 2](02-postac.md), więc scenariusz i postacie mogą powstawać
równolegle.

## Komendy

```bash
pnpm dev screenplay generate dzielna-ewa 01-burza --dry-run
pnpm dev screenplay generate dzielna-ewa 01-burza --dry-run --json
pnpm dev screenplay generate dzielna-ewa 01-burza
pnpm dev check dzielna-ewa 01-burza
pnpm dev check dzielna-ewa 01-burza --stage screenplay
pnpm dev approve dzielna-ewa 01-burza --stage screenplay --note "rytm się zgadza"
```

Dodatkowe flagi: `--model <id>`, `--max-output-tokens <n>`, `--json`, `--regenerate`.

## Dwa kroki i rachunek

Etap kupuje dokładnie jedno wywołanie tekstowe i mówi to, zanim cokolwiek wyśle:
`--dry-run` wypisuje `płatnych wywołań do wykonania: 1`, a przy przeszkodzie `0`, bo zero
i jeden to dwie różne odpowiedzi na pytanie, czy ta komenda zaraz kupi scenariusz. Po
zakupie ten sam wiersz brzmi `płatnych wywołań wykonanych`.

Rachunek jest w **jednostkach, nie w dolarach**, i to jest decyzja, nie niedoróbka:
dostawcy nie wystawiają cennika przez API, więc lokalna tabela cen byłaby utrzymaniem bez
właściciela i liczbą, której nikt nie weryfikuje. Wywołania są tym, co ten CLI naprawdę
liczy.

## Sam etap 1, i odpowiedź jako obiekt

`check <id> <episode-id>` czyta całą tekstową stronę odcinka (etapy 0, 1, 3 i 4) i skleja
cztery werdykty w jeden tekst. To dobre pytanie dla człowieka przy terminalu i złe dla
wszystkiego, co chce werdyktu samego etapu 1, bo sklejonego tekstu nie da się rozłożyć z
powrotem. Dlatego etap daje się nazwać: `--stage screenplay` odpowiada wyłącznie za niego.

`--json` na `check` i `approve` wypisuje **obiekt, który zwraca moduł etapu**, bez żadnego
osobnego formatu, plus dwa pola mówiące, skąd się wziął:

```bash
pnpm dev check dzielna-ewa 01-burza --stage screenplay --json
```

```json
{
  "command": "check",
  "stage": "screenplay",
  "approved": false,
  "inputsChanged": [],
  "problems": [],
  "status": "completed",
  "verdict": {
    "durationSeconds": 30,
    "longestSceneSeconds": 10,
    "maxSceneSeconds": 15,
    "minimumScenes": 2,
    "scenes": 3
  }
}
```

Flaga jest odmową, a nie cichym powrotem do tekstu: `--json` bez `--stage screenplay`
kończy się błędem użycia, bo wołający, który poprosił o obiekt i dostał polskie zdania,
został okłamany przez flagę. Kolejne etapy dostają `--json` po kolei, każdy razem ze swoim
panelem w [lokalnym UI](../ui.md).

`screenplay generate --json` wypisuje raport tej komendy tym samym sposobem, z polami
`command: "generate"` i `stage: "screenplay"`. Odmowy tu nie ma i nie może być: `check`
i `approve` odpowiadają za jedenaście etapów, więc muszą odrzucić pisownię, której etap
nie umie jeszcze odpowiedzieć obiektem, a ta komenda nazywa swój etap własnym pierwszym
słowem. Przy `--dry-run` raport niesie `prompt` i `paidCalls`, przy zakupie `runId` i
listę zapisanych plików. Panel etapu 1 czyta właśnie ten obiekt, żeby postawić rachunek
obok przycisku, który płaci, zamiast szukać liczby w polskim zdaniu.

## Model i klucz

`--model <id>`, a bez tej flagi `AIMATOR_SCREENPLAY_MODEL`. Wartości domyślnej nie ma
i nie będzie: model, którego nikt nie wybrał, nie jest decyzją. Klucz (`OPENAI_API_KEY`)
czytany jest wyłącznie na ścieżce płatnej, bo `--dry-run` nie sięga po sekret ani po sieć,
a i tak pokazuje cały prompt.

## Bramka

`screenplay generate` odmawia płatnego wywołania, dopóki `prepare.stage.json` projektu
**i** odcinka nie mają `review.status = "approved"`, a hashe ich wyników się zgadzają.
Edycja `project.md` po akceptacji unieważnia ją arytmetycznie i etap 1 znów blokuje.
`--dry-run` tej bramki nie omija: raportuje ją jako przeszkodę, ale prompt i tak
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
`--regenerate`. Odpowiedź, która zdążyła trafić na dysk, jest już opłacona, więc powtórzenie
polecenia dokańcza z niej próbę, nie wysyłając niczego. Nic nie ponawia się samo.

---

[← etap 0](00-przygotowanie.md) · [README](../../README.md) ·
[etap 2: postać →](02-postac.md) · [pełny kontrakt](../pipeline.md)
