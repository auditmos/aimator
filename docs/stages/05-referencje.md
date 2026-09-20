# Etap 5 — obrazy referencyjne

Pierwszy etap, w którym tory **naprawdę się rozchodzą**: jeden pakiet promptów, dwa
niezależne zestawy obrazów, dwie osobne oceny. Rysuje miejsca, przedmioty i twarze
widziane raz — wszystko, co nie należy do obsady.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, zatwierdzony `prompt-package.json` i `prompts/references/Rxx.md`, zatwierdzone zależności `dependsOn` **na tym torze** |
| **Wyjście** | `<tor>/references/Rxx.png`, `<tor>/references.stage.json`, `<tor>/runs/<runId>/` |
| **Bramka** | zatwierdzony [etap 4](04-pakiet-promptow.md) i zatwierdzone `dependsOn`; potem ocena każdego obrazu z osobna |
| **Koszt** | płatny; **jedno polecenie może kupić kilka obrazów** |

## Komendy

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track gpt-image --artifact R02
pnpm dev reference generate dzielna-ewa 01-burza --track gpt-image --dry-run
pnpm dev reference generate dzielna-ewa 01-burza --track gpt-image
pnpm dev check dzielna-ewa 01-burza --stage references --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage references --track gpt-image \
  --artifact R01 --note "wieczorny komplet się zgadza"
```

Dodatkowe flagi: `--artifact R01,R02`, `--model <id>`, `--regenerate`.

## Bez flag rysuje wszystko, co gotowe

**Polecenie rysuje wszystkie referencje, których zależności są już zatwierdzone na tym
torze** — i mówi, ile płatnych wywołań wykona, zanim je wykona. To pierwszy etap, w którym
jedno polecenie może kupić kilka obrazów: graf `dependsOn` ma zwykle kilka niezależnych
korzeni.

Bramka jest **wewnątrz własnego zestawu wyników**, więc R04 czeka na *zatwierdzoną* R03,
a narysowanie R03 niczego nie otwiera.

## Kadr

Wynika z `aspectRatio` projektu i jest ten sam na obu torach — dla `16:9` to 2816×1584,
czyli największa ramka o dokładnie tej proporcji, którą przyjmują oba tory. Obraz w innym
rozmiarze nie jest publikowany ani skalowany.

---

[← etap 4](04-pakiet-promptow.md) · [README](../../README.md) ·
[etap 6 — klatka otwarcia →](06-klatka-otwarcia.md) · [pełny kontrakt](../pipeline.md)
