# Etap 6 — klatka otwarcia

Pierwsza klatka filmu. Jedno polecenie, jedno płatne wywołanie, jeden obraz do oceny.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, zatwierdzony `prompt-package.json` i `prompts/opening-frame.md`, zatwierdzona `shot-list.md`, zatwierdzone `opening.referenceIds` **na tym torze** |
| **Wyjście** | `<tor>/opening-frame.png`, `<tor>/opening-frame.stage.json`, `<tor>/runs/<runId>/` |
| **Bramka** | zatwierdzony [etap 4](04-pakiet-promptow.md) i zatwierdzone `opening.referenceIds`; potem ocena kadru |
| **Koszt** | dokładnie jedno płatne wywołanie obrazowe |

## Komendy

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track seedream --artifact opening-frame
pnpm dev opening-frame generate dzielna-ewa 01-burza --track seedream --dry-run
pnpm dev opening-frame generate dzielna-ewa 01-burza --track seedream
pnpm dev check dzielna-ewa 01-burza --stage opening-frame --track seedream
pnpm dev approve dzielna-ewa 01-burza --stage opening-frame --track seedream \
  --note "pozycja alpaki bez ucisku ucha"
```

Dodatkowe flagi: `--model <id>`, `--regenerate`.

## Bramka przekracza granicę etapu, nie granicę toru

Czeka na to, co pakiet wpisał w `opening.referenceIds` — `hero:<id>` każdej postaci
w kadrze i wskazane `Rnn` — **zatwierdzone na tym torze**. Zgoda wydana na `gpt-image` nie
otwiera niczego na `seedream`.

## `--artifact` nie jest tu wymagane nigdzie

Ani przy `--regenerate`, ani przy `approve`. Etap ma jeden artefakt, więc samo polecenie
już mówi, o co chodzi; flaga o jednej dozwolonej wartości byłaby ceremonią, nie
zabezpieczeniem. Napisana i tak jest sprawdzana: `--artifact R01` w tym etapie to odmowa,
nie ciche zignorowanie.

## Czym różni się od referencji

Klatka otwarcia **niesie dosłowne ujęcia** pierwszego klipu, bo jest kadrem filmu, a nie
referencją — więc `shot-list.md` jest jej zapisanym wejściem. Kadr jest ten sam co
w [etapie 5](05-referencje.md).

---

[← etap 5](05-referencje.md) · [README](../../README.md) ·
[etap 7 — klipy →](07-klipy.md) · [pełny kontrakt](../pipeline.md)
