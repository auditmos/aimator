# Lokalne UI nad CLI

`pnpm ui` uruchamia serwer pod `http://127.0.0.1:4317` i otwiera w przeglądarce jeden
ekran: co jest w katalogu roboczym i gdzie stoi wybrany odcinek. To narzędzie dla jednej
osoby na jednym Macu, bez uwierzytelniania i bez dostępu zdalnego; nasłuch tylko na pętli
zwrotnej jest tu całym modelem bezpieczeństwa, a nie ustawieniem, które kiedyś się poszerzy.

## Reguła, z której wynika reszta

**CLI jest jedynym kontraktem.** Każda odpowiedź serwera to `run(argv)`, czyli ta sama
funkcja, którą wywołuje `aimator` w terminalu, uruchomiona w procesie serwera. Serwer nie
importuje żadnego modułu etapu, nie czyta pliku stanu i nie rozstrzyga, czy komórka jest
zablokowana; pilnuje tego test, nie pamięć (`src/ui/imports.test.ts`).

Powód jest jeden i jest ważniejszy niż wygoda: pipeline prowadzą także agenci, więc ekran,
który umie coś, czego nie umie terminal, jest drugą drogą, o której agent nie wie. Dlatego
listę projektów dostała komenda [`list`](pipeline.md), a nie klient.

## Co ten ekran pokazuje

- **Wybór projektu i odcinka** z `list --json`.
- **Drabinę etapów** z `status --json`: komórka na etap, na tor od etapu 2 i na postać w
  etapie 2, każda w jednym z pięciu stanów z etykietą tekstową, z powodem blokady w słowach
  etapu i z meldunkami pod spodem. Kolor nigdy nie niesie znaczenia sam.
- **Jedno „Dalej:"**, wyróżnione, dokładnie to, które policzył `status`.
- **Panel etapu 1** po kliknięciu komórki: werdykt `check` (stan pliku, zatwierdzenie,
  sceny i sumy czasów), problemy w słowach etapu, dryf wejść wypisany plik po pliku,
  treść `screenplay.md` do przeczytania, przycisk „Sprawdź" i przycisk „Zatwierdź".
- **Płatne wywołanie etapu 1**: pola modelu, limitu tokenów i nowej próby, przycisk
  „Generuj" z podglądem i rachunkiem, i dopiero po nim przycisk „Kup".

Komórki pozostałych etapów są na razie wierszami bez panelu: każdy etap dostaje swój
w osobnym wycinku, a wiersz, którego nie da się kliknąć, mówi to uczciwiej niż pusty panel.

## Przyciski, czyli komendy

Pod każdym przyciskiem stoi komenda, którą on uruchamia, w tej samej postaci, którą
przyjmuje terminal. To nie ozdoba: pipeline prowadzą też agenci, więc to, co klikalne,
musi dać się wkleić. Całą gramatykę CLI zna jeden plik (`src/ui/commands.ts`), a test
sprawdza każde zbudowane `argv` względem `--help` tą samą metodą, co test dokumentacji.

„Zatwierdź" pojawia się **wyłącznie wtedy, gdy `check` nie zgłasza problemów**, a
scenariusz czeka na przyjęcie. Przycisk, któremu CLI i tak by odmówiło, uczy człowieka,
że ekran kłamie.

## Zakup w dwóch krokach

Każde płatne wywołanie ma **dwa kroki i nie ma progu**. „Generuj" uruchamia tę samą
komendę z `--dry-run --json`, która z kontraktu nie czyta klucza i niczego nie wysyła, i
pokazuje całą wysyłkę: prompt do przeczytania i rachunek w **wywołaniach**, nie w
dolarach. Dopiero wtedy istnieje „Kup", a to, co uruchamia, jest **tym samym `argv` bez
próby na sucho**.

To wyprowadzenie, a nie zbieżność, i na tym stoi cała reguła. Zamiar „kup" przyjmuje
ukończoną próbę na sucho jako jedyne wejście, więc **nie da się go zbudować** bez niej ani
zbudować go dla innej wysyłki niż ta przeczytana: odcinek, model, limit tokenów i nowa
próba jadą z podglądu, nie z pól formularza w chwili drugiego kliknięcia. Pilnuje tego
typ i test (`src/ui/commands.test.ts`), a nie pamięć autora panelu. Próg „jeden klik dla
tanich, dwa dla drogich" został odrzucony w PRD, bo próg to decyzja, którą ktoś musiałby
ustalać i utrzymywać.

Podgląd jest jedyną odpowiedzią, którą panel **układa** z pól obiektu, bo rachunek ma stać
jako liczba obok przycisku, który płaci, a szukanie jej w polskim zdaniu byłoby uczeniem
klienta formatu tekstowego CLI. Wynik zakupu, jak wynik „Sprawdź" i „Zatwierdź", pokazuje
się w całości, w słowach terminala. Gdy podgląd mówi `0 płatnych wywołań`, „Kup" nie
pojawia się wcale, a pod spodem stoją przeszkody w słowach etapu.

## Uruchamianie komendy i artefakty

Uruchomienie odpowiada **natychmiast identyfikatorem przebiegu**; wynik `run` przychodzi
później zdarzeniem `run` na tym samym strumieniu, na którym przychodzi drabina. Etap 7
odpytuje dostawcę minutami, a ekran ma przez ten czas pozostać używalny. Serwer **nie
czyta przekazanego `argv`**: co jest legalną komendą, rozstrzyga CLI, odmawiając.

Artefakty są serwowane tylko do odczytu i adresowane krotką (projekt, odcinek, etap,
artefakt). Na ścieżkę tłumaczy je jedno miejsce, przez `workspace.ts`; krotka, której
układ nie zna, dostaje 404, **zanim powstanie jakakolwiek ścieżka**, więc `..` ani ścieżka
bezwzględna nie wyprowadzą odczytu poza katalog roboczy.

## Czego pętla zwrotna nie załatwia

Nasłuch na `127.0.0.1` nie powstrzymuje **innej strony otwartej w tej samej przeglądarce**
przed wysłaniem żądania tutaj: CORS ukryłby przed nią odpowiedź, a nie powstrzymał samego
wywołania, a od kolejnego wycinka wywołanie kosztuje. Dlatego uruchomienie komendy odmawia
przy obcym nagłówku `Origin` i wymaga `application/json`, co wymusza zapytanie o zgodę
(preflight) zanim cokolwiek poleci. Żądanie bez `Origin`, czyli z terminala albo od agenta,
przechodzi normalnie.

Samo porównanie `Origin` z `Host` by nie wystarczyło i warto wiedzieć, dlaczego. Strona na
`zla-strona.example`, której nazwa zostaje przestawiona na 127.0.0.1 (DNS rebinding),
dociera tu **pod własną nazwą**: oba nagłówki się wtedy zgadzają, żądanie jest tego samego
pochodzenia, o zgodę nikt nie pyta, a strona czyta odpowiedź. Jedynym nagłówkiem, którego
obca strona nie podrobi na pętlę zwrotną, jest nazwa, pod którą serwer został osiągnięty,
więc **każda** odpowiedź `/api` jest na niej bramkowana, nie tylko uruchomienie komendy:
katalog roboczy to czyjś nieopublikowany film, a odczyt drabiny i scenariusza wyciekłby tak
samo jak wywołanie.

## Odświeżanie i utrata połączenia

Serwer obserwuje katalog roboczy i po zmianie przelicza `status --json`, a wynik wypycha
przez SSE, więc okno w przeglądarce i agent pracujący w terminalu nie rozjeżdżają się.
Postęp jest **dokładnie tak szczegółowy, jak stan zapisany na dysku**: blokada etapu daje
„w toku", a niczego poza tym serwer o trwającej pracy nie wie i nie udaje, że wie.

Gdy strumień padnie, ostatnia drabina **zostaje na ekranie** z oznaczeniem, że jest
nieaktualna. Zerwane połączenie nigdy nie udaje świeżego wyniku, a puste okno byłoby
schowaniem odpowiedzi, którą ktoś właśnie czytał.

## Wygląd

Skorupa według „Portable website shell" z [manuala Auditmos](https://auditmos.com/design.md)
(odczytanego 2026-09-21), tak samo jak [strona wydań](strona.md): kompaktowy nagłówek z
wordmarkiem poza kontrolkami, natywny wybór motywu System / Jasny / Ciemny pod kluczem
`auditmos-theme`, kompaktowa stopka. Tokeny kolorów są **rozwiązane dla tego renderera** w
`ui/styles.css`, bo nie ma tu Tailwinda; cyan tylko na wyróżnieniu „Dalej", z ciemnym
tekstem. Oba motywy są pełnymi kompozycjami. Język interfejsu jest polski, jak komunikaty
CLI, które ten ekran pokazuje bez zmian.

Wordmark i webfonty są serwowane wprost z `site/assets`, więc nie ma drugiej kopii, którą
trzeba by aktualizować.

## Gdzie co mieszka

| Część | Katalog | Dlaczego tam |
|---|---|---|
| Serwer | `src/ui/` | Kod Node, testowany przez wywołanie aplikacji, poza buildem pakietu |
| Klient | `ui/` | Pliki przeglądarki, jak `site/` obok `src/site/`; JSX i DOM nie wchodzą do `src` |

Serwer i klient dzielą jeden proces i jeden port: Vite w trybie middleware obsługuje stronę
i przeładowania, Hono obsługuje `/api`. Dwa procesy kupiłyby proxy i drugi log za jeden
adres, który już jest.

## Testy

Serwer jest testowany przez `app.request()` na tym samym fixture, którego używają etapy, bez
otwierania portu: żądanie stanu zwraca to samo, co `status --json`, żądanie listy to samo, co
`list --json`, odmowa zostaje odmową z tym samym komunikatem, strumień zdarzeń wypycha
drabinę po zmianie pliku, artefakt wraca jako bajty z właściwym typem, krotka spoza układu
jako 404, a uruchomiona komenda oddaje identyfikator od razu i wynik zdarzeniem. Słownik
komend jest sprawdzany względem `--help`, a zakup osobno: że jest tą samą wysyłką bez próby
na sucho i że bez ukończonej próby nie daje się zbudować. Klient jest sprawdzany w
przeglądarce, w obu motywach.
