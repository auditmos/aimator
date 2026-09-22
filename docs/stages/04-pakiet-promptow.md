# Etap 4: pakiet promptów

Pierwszy etap, który łączy tor tekstowy z obrazowym: wynikiem jest tekst, ale bramka pyta
o obraz. Pisze **jeden plik promptu na każde przyszłe płatne wywołanie** obrazowe i wideo.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, `episode.json`, zatwierdzona `shot-list.md`, zatwierdzony `hero.png` **każdej postaci w kadrze, na obu torach** |
| **Wyjście** | `prompt-package.json`, `prompts/**`, `prompt-package.stage.json`, `runs/<runId>/` |
| **Bramka** | zatwierdzony [etap 3](03-lista-ujec.md) **i** zatwierdzone hero na obu torach |
| **Koszt** | jedno płatne wywołanie tekstowe |

Pakiet jest wspólny dla obu torów, więc nie ma w nim poziomu katalogu na tor, i nic
w nim nie nazywa toru.

## Komendy

```bash
pnpm dev prompt-package generate dzielna-ewa 01-burza --dry-run
pnpm dev prompt-package generate dzielna-ewa 01-burza
pnpm dev check dzielna-ewa 01-burza
pnpm dev approve dzielna-ewa 01-burza --stage prompt-package --note "graf się zgadza"
```

Dodatkowe flagi: `--model <id>`, `--max-output-tokens <n>` (domyślnie 32 000), `--json`,
`--regenerate`, `--republish` (publikuje zapisaną odpowiedź, nic nie wysyła).

## Etap 4 jako obiekt

`--json` wypisuje **obiekt, który zwraca moduł etapu**, plus pola `command` i `stage`:

```bash
pnpm dev check dzielna-ewa 01-burza --stage prompt-package --json
pnpm dev approve dzielna-ewa 01-burza --stage prompt-package --json
pnpm dev prompt-package generate dzielna-ewa 01-burza --dry-run --json
pnpm dev prompt-package show dzielna-ewa 01-burza --track gpt-image --json
```

`--stage prompt-package` zawęża `check` do tego etapu, tak samo jak `--stage shot-list`
zawęża go do [etapu 3](03-lista-ujec.md). Raport `generate` niesie `paidCalls`, rachunek
w wywołaniach, zawsze jeden albo zero.

`show --json` wypisuje **plan wysyłki**: to jedyne miejsce, w którym regułę 8 widać, zanim
cokolwiek poleci. Każdy przyszły płatny kadr ma tu swoje załączniki w kolejności, w jakiej
żądanie poniesie bajty, więc panel etapu 4 układa z tego listę `Image N = <id> — <rola>`
per tor, a nie szuka jej w tekście.

Jedno pole planu **nie wchodzi** do JSON-a: `bytes`. Załącznik niesie bajty dla etapu,
który je wyśle, a dokument JSON bajtów nie ma; serializacja bufora wstawiłaby megabajt
liczb dziesiętnych do planu, który ktoś chciał przeczytać. Plik identyfikuje tu `sha256`,
dokładnie tak jak wszędzie indziej w tym potoku.

## Podgląd tego, co poleci do modelu obrazu

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track gpt-image
pnpm dev prompt-package show dzielna-ewa 01-burza --track gpt-image --artifact R02
```

**Darmowe.** Drukuje dokładnie to, co poleci do modelu: numerowany blok
`Image N = <identyfikator> — <rola>` w kolejności, w jakiej żądanie poniesie bajty, treść
pliku z `prompts/`, blok o medium, kadr, przy kadrach filmu dosłowne ujęcia z listy,
i `project.md`.

Istnieje, bo etap 4 publikuje **połowę** promptu; resztę dokleja etap wysyłający, więc
inaczej zatwierdzałbyś tekst, którego nie widzisz w formie, w jakiej poleci. Bez
`--artifact` wypisuje sam plan: co pakiet planuje, ile referencji i czy są zatwierdzone.

Wartości `--artifact`: `R02`, `opening-frame`, `C03`, `entry:C03`.

## Dlaczego bramka pyta o oba tory

Kadr przypisuje sobie identyfikatory `hero:<id>` i `Rnn`, a w jaki plik się one zamieniają,
rozstrzyga dopiero etap, który je dołącza. To jest cały powód, dla którego **jeden manifest
obsługuje dwie produkcje**. Ponieważ obsługuje obie, obie muszą być gotowe: płatne
wywołanie odmawia, dopóki każda postać, którą lista ujęć stawia w kadrze, nie ma
zatwierdzonego `hero.png` na torze `gpt-image` **i** na torze `seedream`.

Bramka pyta o postacie **w kadrze**, nie o całą obsadę: hero postaci, której pakiet nigdy
nie wymieni, nie jest jego wejściem.

Obrazy postaci są zapisanym wejściem, choć **nie są wysyłane**: do modelu idzie to, z
czego powstały, czyli `project.md`. Dołączenie hero jednego toru uczyniłoby plan drugiego
toru pochodną tamtego rysunku.

---

[← etap 3](03-lista-ujec.md) · [README](../../README.md) ·
[etap 5: obrazy referencyjne →](05-referencje.md) · [pełny kontrakt](../pipeline.md)
