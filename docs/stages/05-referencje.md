# Etap 5: obrazy referencyjne

Pierwszy etap, w którym tory **naprawdę się rozchodzą**: jeden pakiet promptów, dwa
niezależne zestawy obrazów, dwie osobne oceny. Rysuje miejsca, przedmioty i twarze
widziane raz, czyli wszystko, co nie należy do obsady.

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

Dodatkowe flagi: `--artifact R01,R02`, `--model <id>`, `--json`, `--regenerate`,
`--instruction <uwaga>` (tylko razem z `--regenerate` i jednym `--artifact`).

## Poprawka z uwagą

Samo `--regenerate` rysuje obraz od zera z tym samym promptem, więc poprawka jednego
szczegółu ryzykuje zmianę wszystkiego, co było dobre. Z uwagą jest inaczej:

```bash
pnpm dev reference generate dzielna-ewa 01-burza --track gpt-image --regenerate \
  --artifact R02 --instruction "Przywróć brakujące ucho alpaki." --dry-run
```

Poprzedni obraz idzie jako **Image 1**, `Image 1 = previous:R02 — the image to correct…`,
a po nim dotychczasowe załączniki w dotychczasowej kolejności. Lista jest generowana przy
wysyłce, więc proza promptu dalej wskazuje załączniki po identyfikatorach i przesunięcie
pozycji jej nie psuje. Zaraz po liście stoi angielskie zadanie poprawki: zmienić tylko to,
co nazywa uwaga, a kompozycję, tożsamość, paletę, światło i każdy inny szczegół Image 1
zostawić; uwaga jedzie dosłownie między `----- BEGIN NOTE -----` a `----- END NOTE -----`.
Na gpt-image żądanie idzie na `/images/edits` z poprzednim obrazem jako pierwszym plikiem,
na seedream jako pierwszy element `image`.

Poprzedni obraz liczy się do limitu toru (gpt-image 16, seedream 10). Jeśli razem
z dotychczasowymi załącznikami go przekracza, pada odmowa przed wysyłką, z liczbami; nic
nie jest cicho obcinane. Uwaga ma jednego adresata, więc `--artifact R01,R02` z uwagą to błąd
użycia. Rekord dostaje pole `instruction`, a w `inputs` stoi poprzedni obraz z archiwum
próby (`runs/<runId>/previous.png`), ścieżką i sha256. Poprawiony obraz czeka na zgodę jak
każdy inny. Tak samo działa w etapach [2](02-postac.md), [6](06-klatka-otwarcia.md)
i [7](07-klipy.md) dla `entry:Cnn`.

## Etap 5 jako obiekt

`--json` wypisuje **obiekt, który zwraca moduł etapu**, bez osobnego formatu, plus pola
`command` i `stage`:

```bash
pnpm dev check dzielna-ewa 01-burza --stage references --track gpt-image --json
pnpm dev approve dzielna-ewa 01-burza --stage references --track gpt-image \
  --artifact R01,R02 --json
pnpm dev reference generate dzielna-ewa 01-burza --track gpt-image --dry-run --json
```

Raport `generate` niesie `paidCalls`, czyli **ile obrazów to wywołanie kupi**. Bez
`--artifact` liczy to, na co pozwala graf: referencja zależna nie wchodzi do rachunku,
dopóki ta, z której powstaje, nie jest zatwierdzona **na tym torze**.

Powód blokady jest w obiekcie, a nie tylko w tekście, i to jest ważne: pole `note`
zablokowanej referencji **nazywa referencję, na którą czeka**, zarówno w raporcie
`generate` (gdy zapytasz o nią po nazwie), jak i w obiekcie `check`, z którego korzysta
[panel etapu 5](../ui.md). Komórka, która mówiłaby tylko „zablokowana", zostawiałaby
człowieka bez następnego ruchu.

## Bez flag rysuje wszystko, co gotowe

**Polecenie rysuje wszystkie referencje, których zależności są już zatwierdzone na tym
torze**, i mówi, ile płatnych wywołań wykona, zanim je wykona. To pierwszy etap, w którym
jedno polecenie może kupić kilka obrazów: graf `dependsOn` ma zwykle kilka niezależnych
korzeni.

Bramka jest **wewnątrz własnego zestawu wyników**, więc R04 czeka na *zatwierdzoną* R03,
a narysowanie R03 niczego nie otwiera.

## Kadr

Wynika z `aspectRatio` projektu i jest ten sam na obu torach: dla `16:9` to 2816×1584,
czyli największa ramka o dokładnie tej proporcji, którą przyjmują oba tory. Obraz w innym
rozmiarze nie jest publikowany ani skalowany.

---

[← etap 4](04-pakiet-promptow.md) · [README](../../README.md) ·
[etap 6: klatka otwarcia →](06-klatka-otwarcia.md) · [pełny kontrakt](../pipeline.md)
