# Lokalne UI nad CLI

`pnpm ui` uruchamia serwer pod `http://127.0.0.1:4317`. Ekran otwiera się na dwóch
wyborach, „Nowy projekt” i „Wczytaj projekt”, i dopiero wybrany projekt pokazuje swoje
odcinki i drabinę etapów. To narzędzie dla jednej
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

- **Ekran startowy** z dwoma wyborami i niczym więcej: „Nowy projekt” i „Wczytaj
  projekt”. To jedyne dwa pytania, na które ktoś wchodzący tu umie odpowiedzieć; odcinek,
  drabina i panel etapu dotyczą projektu, więc czekają, aż jakiś jest. Gdzie stoi ekran,
  zapisuje adres, więc odświeżenie zostaje w miejscu, a przycisk „wstecz” przeglądarki
  cofa. Wordmark w nagłówku wraca na start.
- **Nowy projekt** (`#/nowy`): sam formularz `project init` (identyfikator, tytuł,
  proporcje). Gdy CLI powie „tak”, ekran przechodzi do tego projektu; odmowa zostaje pod
  formularzem, słowo w słowo.
- **Wczytaj projekt** (`#/wczytaj`): projekty z `list --json` jako lista odnośników z
  liczbą odcinków. Pusty katalog roboczy mówi o tym i odsyła do nowego projektu.
- **Widok projektu** (`#/projekt/<id>`): to samo pytanie o jeden poziom niżej, „Nowy
  odcinek” albo „Wczytaj odcinek”, a pod nimi, ciszej, odnośnik „Obsada i narrator”.
- **Obsada i narrator** (`#/projekt/<id>/obsada`): trzy osobne sekcje, bo to trzy
  pytania. „Postacie”: każda postać z `project show --json` jako własna karta z podstawą,
  zdjęciami i dwiema akcjami na niej samej (`character add`, `character describe`), więc
  identyfikatora nie wpisuje się drugi raz; pod kartami `character new`. „Narrator”:
  obecny głos i `project voice`. „Sprawdzenie etapu 0”: `check --stage prepare`. Wynik
  komendy pokazuje się w pasku na dole okna, jak na każdym ekranie (patrz niżej).
  Są na poziomie projektu, bo mieszkają w `project.json` i powracają między
  odcinkami; świeży projekt ustawia je, zanim ma jakikolwiek odcinek. Lista czyta się na
  nowo przy każdej zmianie w katalogu roboczym, więc postać dopisana z terminala też się
  na niej pojawia. Serwer odpowiada nią pod `/api/project/<id>` i nie czyta
  `project.json` sam: to ta sama zasada, dla której listę projektów dostała komenda
  `list`.
- **Nowy odcinek** (`#/projekt/<id>/nowy-odcinek`): ścieżka do pliku źródłowego i sześć
  decyzji, czyli `episode add`. Identyfikator odcinka czyta z nazwy pliku CLI, więc ekran
  go nie zgaduje: pamięta, jakie odcinki projekt miał w chwili wysłania komendy, i
  przechodzi do tego, który po niej pojawił się w `list`.
- **Wczytaj odcinek** (`#/projekt/<id>/odcinki`): odcinki projektu jako lista odnośników.
- **Przegląd odcinka** (`#/projekt/<id>/odcinek/<odcinek>`): następny krok i jedenaście
  etapów, opisane niżej. Odcinka się tu nie wybiera: wybrano go po drodze i nazywa go
  adres. Projekt albo odcinek, którego nie ma w `list`, dostaje komunikat zamiast ekranu
  zbudowanego na czymś, czego CLI i tak by odmówiło.
- **Strona etapu** (`#/projekt/<id>/odcinek/<odcinek>/etap/<komórka>`): jeden etap i nic
  poza nim. Adres niesie identyfikator komórki z `status`, taki jak `7`, `7/seedream` albo
  `2/ewa/gpt-image`, więc odświeżenie, „wstecz” i wklejony link lądują na tej samej
  zakładce. Sam numer etapu otwiera komórkę, którą `status` nazwał następną, jeśli jest w
  tym etapie, a inaczej pierwszą, która jeszcze czegoś chce.
- **Następny krok** na przeglądzie, dokładnie ten, który policzył `status`, powiedziany
  jako miejsce: numer i nazwa etapu, tor albo postać, stan, i przycisk „Przejdź do etapu
  N”. Zdanie etapu (`nextStep`) jest pod nim zwinięte jako „Polecenie w terminalu” z
  przyciskiem „Kopiuj”, który wkłada je do schowka takim, jakie jest, bo bywa gołą komendą,
  a bywa zdaniem z komendą w środku i skracanie go tutaj byłoby redagowaniem cudzej
  odpowiedzi.
- **Etapy** na przeglądzie: jeden wiersz na etap, nie na komórkę, z tym, z czego etap się
  składa („2 postacie × 2 tory”, „2 tory”, „wspólna część + 2 tory”), i ze stanem.
  Komórki jednego etapu w tym samym stanie dają jedną etykietę; różne dają liczniki
  („zatwierdzony 1/2”, „do przeglądu 1/2”). To arytmetyka na komórkach `status`, nie
  werdykt: pięć stanów ma etykiety tekstowe, kolor nigdy nie niesie znaczenia sam.
- **Panel etapu 0**: formularz sześciu decyzji tego odcinka, „Sprawdź" i „Zatwierdź",
  oraz odnośnik do obsady projektu. Założenie projektu, obsada i dodanie odcinka mają
  własne ekrany, bo pyta się o nie na innym poziomie niż o odcinek. Gdy `status` odmawia (np.
  etap 0 jest niekompletny), panel etapu 0 stoi na przeglądzie zamiast listy etapów, bo to
  w nim naprawia się to, o co drabina się zatrzymała. Pliki podaje się **ścieżką w polu
  tekstowym**; patrz niżej.
- **Panel etapu 1**: werdykt `check` (stan pliku, zatwierdzenie,
  sceny i sumy czasów), problemy w słowach etapu, dryf wejść wypisany plik po pliku,
  treść `screenplay.md` do przeczytania, przycisk „Sprawdź" i przycisk „Zatwierdź".
- **Panel etapu 2**, pierwszy, w którym zatwierdza się **patrząc**: dziesięć obrazów
  postaci na tym torze, każdy ze swoim stanem i polem wyboru, rachunek w obrazach.
- **Panele etapów 3 i 4**, na tym samym wzorcu: werdykt, dryf wejść, treść
  `shot-list.md` albo manifestu pakietu, „Sprawdź", „Zatwierdź" i płatne wywołanie
  w dwóch krokach z rachunkiem w wywołaniach.
- **Panele etapów 5 i 6** na tym samym wzorcu obrazowym: referencje z wyborem kilku naraz
  i z powodem blokady w słowach etapu, nazywającym referencję, na którą zależna czeka;
  klatka otwarcia bez żadnego wyboru, bo ma jeden artefakt.
- **Panel etapu 7**, pierwszy, w którym się nie patrzy, tylko **ogląda**: łańcuch ogniwo po
  ogniwie, klatka wejściowa jako obraz, klip jako wideo z przewijaniem, pod każdym jego
  stan w słowach etapu, więc zablokowane mówi, czyjej zgody brakuje. Zaznaczenie kilku daje
  jedną komendę (`--artifact C01,entry:C02`), rachunek stoi w **dwóch** liczbach, a obok
  płatnego wywołania jest jedyna komenda tego ekranu, która zapisuje, nie płacąc:
  `--republish` z archiwum.
- **Panel etapu 8**, pierwszy **bez rachunku i bez „Kup”**: cały odcinek jako wideo do
  obejrzenia w całości, plan cięcia wyprowadzony z zatwierdzonej listy ujęć (nigdzie nie
  zapisany), cisza jako meldunek, a nie przeszkoda, i **jeden przycisk**. Bez `ffmpeg`
  panel pokazuje odmowę słowo w słowo taką, jaką wypisałby terminal.
- **Panele etapu 9**, pierwszego etapu z **dwoma panelami**, bo jego artefakty leżą na
  dwóch poziomach drzewa: skrypt i nagrania są wspólne dla obu torów (kwestia jako audio
  do odsłuchania, z własnym polem wyboru, bo zatwierdza się **słuchając**), a miks jest
  per tor i jest wideo. Rachunek stoi w **znakach i wywołaniach**, a znaki kontekstu obok
  niego, nie w nim. Reżyseria narratora to formularz pięciu pokręteł mapowany na komendę
  `narration direction`; jego zapis nie unieważnia zgód wcześniejszych etapów, bo nie
  dotyka `project.json`.
- **Panele etapu 10**, na wzorcu etapu 9 i na tych samych dwóch poziomach: arkusz cue
  i stemy są wspólne dla obu torów (stem jako audio do odsłuchania, `audio/mpeg`, bo
  tylko taki kontener dają te dwa endpointy), a pełna ścieżka jest per tor i jest wideo.
  Rachunek stoi w **sekundach i wywołaniach**, a obok niego zdanie, którego nie ma nigdzie
  indziej: dostawca nalicza przy **generacji**, więc nowa próba to druga pełna opłata.
  Poziomy to formularz czterech suwaków mapowany na `sound-design levels`; jego zapis nie
  unieważnia zatwierdzonych nagrań etapu 9, bo mieszka w `mix.json`, a nie w
  `narration.json` ani w `project.json`.
- **Plan wysyłki etapu 4** per tor: patrz niżej.
- **Płatne wywołanie**: pola modelu, limitu tokenów i nowej próby, przycisk
  „Generuj" z podglądem i rachunkiem, i dopiero po nim przycisk „Kup".

Tym etapem drabina domyka się w panelach: każdy zaimplementowany etap, od 0 do 10, ma swój
ekran, a dwa ostatnie mają po dwa, bo ich artefakty leżą na dwóch poziomach drzewa.

## Gdzie stoi panel

Panel ma **własną stronę**, a nie miejsce obok drabiny. Wcześniej drabina (ponad
dwadzieścia komórek przy dwóch postaciach) i panel otwartej komórki stały w dwóch
kolumnach, i trzeba było czytać oba naraz: długie zdanie etapu obcinała kolumna, a
odmowy panelu spychały to, co się ocenia, poza ekran. Teraz odcinek czyta się z dwóch
odległości. Z daleka to jedenaście wierszy. Z bliska to jeden etap:
- u góry pasek jedenastu znaczników; każdy ma kolor najpilniejszego stanu swoich komórek,
  a stan jest też w jego nazwie dostępnej dla czytnika;
- pod nim nazwa etapu i zakładki jego torów, postaci albo poziomów, gdy jest ich więcej
  niż jeden;
- powód blokady w słowach etapu;
- i sam panel, na całą szerokość;
- na dole odnośniki do etapu poprzedniego i następnego.

Przejście do innego etapu albo zakładki to nowa strona. Ekran wraca wtedy na górę, a
fokus ląduje na nagłówku etapu, więc klawiatura i czytnik ekranu zaczynają tam, gdzie
wzrok. Zakładka zaczyna czysto: nic nie jest zaznaczone i nic nie zostało z podglądu
poprzedniej. Nagłówek panelu zostaje tylko dla czytnika ekranu, bo stronę nazywa już
nagłówek etapu i zakładka.

Odmowy panelu, po dwóch pierwszych, zwijają się pod „Pokaż pozostałe powody (N)”. Jedno
zmienione wejście unieważnia zgodę na każdy artefakt z niego zrobiony, więc etap potrafi
odmówić tuzinem zdań naraz. Zdania nie znikają, a liczba na zwinięciu mówi, ile ich jest.

## Z czego składa się panel

Każdy panel to kolumna **bloków**, osobnych kart z tytułem, zawsze w tej samej kolejności.
Każdy blok zwija się pod swoim tytułem. Na etapie (albo zakładce), który jest już
**zatwierdzony**, wszystkie startują zwinięte: taki etap otwiera się, żeby coś sprawdzić,
nie żeby nad nim pracować, więc tytuły bloków służą za spis treści. Stan otwarcia czyta
się raz, przy wejściu na stronę, bo blok zamykający się komuś pod ręką zabierałby coś w
pół zdania. Dzięki stałej kolejności na każdym etapie wiadomo, gdzie szukać:

1. **Stan**: werdykt `check`, odmowy, meldunki i dryf wejść.
2. **To, co etap wyprodukował**: tekst, obrazy, łańcuch klipów, film albo nagrania, pod
   nazwą tego etapu. Na liście z wyborem pozycja już zatwierdzona ma pole zaznaczone i
   zablokowane oraz zieloną ramkę, więc po powrocie na stronę widać, co przyjęto, a
   kolejne „Zatwierdź” obejmuje tylko nowo zaznaczone. Odblokowuje je jedynie wybór, który
   z definicji dotyczy rzeczy przyjętych: „Nowa płatna próba”, a w klipach także zgoda na
   publikację z archiwum. Nad listą stoi „Zaznacz wszystkie”, które zaznacza to, co dałoby
   się zaznaczyć ręcznie: pozycje już istniejące, bez zablokowanych. Pomija to, czego
   jeszcze nie ma, bo „Zatwierdź” by tego odmówiło, a dorysowanie brakujących nie wymaga
   żadnego wyboru. Kliknięty obraz (w klipach: klatka wejściowa, bo klip ma własny pełny
   ekran) otwiera się w podglądzie na całe okno. Strzałki przechodzą po tej samej liście,
   Escape zamyka, a pole wyboru stoi także w podglądzie, więc decyzję podjętą przy pełnym
   rozmiarze zaznacza się bez zamykania.
3. **Decyzja**: „Sprawdź” i „Zatwierdź”, a w etapach 9 i 10 oba „tak” tego etapu
   (skrypt i kwestie, arkusz i stemy). Gdy w bloku stoi przycisk zatwierdzenia, blok jedzie
   z dołem okna, więc obraz zaznaczony na końcu galerii zatwierdza się bez wracania na
   górę. Gdy nie ma czego przyjąć, stoi w miejscu i niczego nie zasłania. Dryf wejść nie
   chowa „Zatwierdź”, bo lekarstwem na niego jest właśnie ponowne zatwierdzenie: blok mówi
   wtedy, który plik się zmienił i że zgoda wygasła, a przycisk zostaje.
4. **Generowanie (płatne)**: zwinięte, chyba że komórka jest „gotowa do generowania”.
   Tam kupowanie jest tym, po co się przyszło; przy przeglądzie ponowny zakup jest
   rzadszym pytaniem. Prompty z podglądu są zwinięte każdy osobno, a rachunek stoi nad nimi.
5. **Reszta**, zwinięta: montaż i miksy (bez płacenia, otwarte, gdy etap jest gotowy),
   publikacja z archiwum, plan wysyłki, reżyseria, poziomy i decyzje odcinka.

Długie uzasadnienia zostają na stronie, ale pod „Jak to działa” w swoim bloku: są
dokumentacją decyzji, a kto przeczytał je raz, nie powinien przedzierać się przez nie
przy każdym przeglądzie.

**Wynik komendy** stoi w pasku przy dolnej krawędzi okna, na **każdym** ekranie (etap,
obsada, nowy projekt, nowy odcinek) i niezależnie od tego, który blok ją uruchomił:
„W toku, czekam na wynik…” z kręcącym się znacznikiem, potem „✓ Gotowe” albo „✕ Odmowa”,
z komendą obok. Pasek pojawia się **w chwili kliknięcia**, a nie dopiero wtedy, gdy
serwer odda identyfikator: serwer zajęty przeliczaniem drabiny potrafi odpowiadać kilka
sekund, a kliknięcie, po którym nic się nie dzieje, wygląda jak kliknięcie, które nie
trafiło. Kliknięty przycisk zostaje w pełnym kolorze, dostaje znacznik i wielokropek
(„Zatwierdź…”), a pozostałe przyciski komend są wyłączone do czasu odpowiedzi. Odmowa
rozwija się sama, bo to jedyna odpowiedź, która czegoś wymaga; sukces rozwija się na
żądanie. Odmowę samego serwera (np. żądanie bez `argv`) pasek pokazuje tak samo.

„Gotowe” nie wyprzedza skutków komendy. Serwer ogłasza zakończoną komendę na strumieniu
odcinka dopiero **za** drabiną przeczytaną po jej zakończeniu, w tej samej kolejce, a
otwarty odcinek czyta wyniki z tego strumienia, nie ze strumienia katalogu roboczego.
Inaczej szybkie `approve` mówiło „Gotowe” w ułamku sekundy, a przez kolejne sekundy
ekran pokazywał stary stan z aktywnym „Zatwierdź”. Dlatego „w toku” trwa tyle, ile
przeliczenie drabiny, czyli zwykle kilka sekund, także dla komendy, która niczego nie
zapisała.

## Czego ten ekran nie robi

Lista jest krótka i każda pozycja jest decyzją, a nie brakiem czasu.

**Nie umie nic, czego nie umie terminal.** Pod każdym przyciskiem stoi `run(argv)`, więc
ekran nie ma ani jednej własnej odpowiedzi. Gdy czegoś brakuje, brakuje tego w CLI i tam
trzeba to dopisać; dołożenie tego po stronie klienta byłoby drugą drogą, o której agent
prowadzący ten sam potok nie wie.

**Nie rozstrzyga niczego.** Czy komórka jest zablokowana, ile kosztuje wywołanie i co jest
następnym krokiem, liczy `status` i raport etapu. Serwer nie importuje modułu etapu, nie
czyta pliku stanu i nie skleja ścieżek poza `workspace.ts`.

**Nie przyjmuje plików.** Plik podaje się ścieżką, bo upload zapisałby w `episode.json`
katalog tymczasowy zamiast miejsca, z którego plik naprawdę pochodzi.

**Nie pisze `project.md` i nie prowadzi wywiadu.** Zasady wspólne pisze człowiek
w edytorze, a rozwinięcie pomysłu i etap 0 prowadzą skille `develop-series`
i `prepare-project` w terminalu.

**Nie pokazuje pieniędzy.** Rachunek stoi w jednostkach, które liczy etap (wywołaniach,
obrazach, znakach, sekundach), i nigdy w dolarach. Cennika, salda ani progu „tanie kupuj
jednym kliknięciem" tu nie ma, bo próg to decyzja, którą ktoś musiałby ustalać
i utrzymywać.

**Nie wie o postępie więcej niż dysk.** Etapy nie wysyłają zdarzeń i nie dostaną takiej
sygnatury; blokada etapu daje „w toku" i na tym kończy się wiedza serwera o trwającej
pracy.

**Nie kolejkuje i nie ponawia.** Przed dwoma uruchomieniami naraz, z ekranu i z terminala,
chronią blokady etapów: te same, które chronią przed dwoma terminalami. Drugiej ochrony
nie ma i nie jest potrzebna.

**Nie zapisuje niczego od siebie i niczego nie publikuje.** Wszystko, co powstaje, zapisuje
etap w katalogu roboczym; gotowy odcinek wychodzi do internetu osobnym narzędziem
([strona wydań](strona.md)), a historia zmian to `git log`, nie widok w przeglądarce.

**Nie wychodzi poza tę maszynę.** Bez uwierzytelniania, bez konta, bez zdalnego dostępu
i bez instalatora. Nasłuch na pętli zwrotnej jest tu całym modelem bezpieczeństwa;
co z tego nie wynika, opisuje osobna sekcja niżej.

## Etap 0 i ścieżka w polu tekstowym

Etap 0 jest wyjątkiem od zdania „panel otwiera się ze strony etapu", i to nie jest
odstępstwo, tylko opis tego, czym ten etap jest. Drabina odpowiada o **odcinku**, a świeży
projekt nie ma odcinka, a świeży odcinek zwykle nie ma jeszcze kompletnego etapu 0, więc
`status` go odrzuca. Dlatego pytania etapu 0 mają własne ekrany na swoich poziomach
(„Nowy projekt”, „Obsada i narrator”, „Nowy odcinek”), a panel etapu 0 pokazuje się także
wtedy, gdy drabina odmawia. Razem doprowadzają pusty katalog do zatwierdzonego etapu 0:
załóż projekt, uzupełnij `project.md` w edytorze, dopisz obsadę, dodaj odcinek,
„Sprawdź", „Zatwierdź".

Plik podaje się **ścieżką wklejoną z Findera**, która trafia do `--source` bez zmian.
Upload przez przeglądarkę został w PRD odrzucony z jednego powodu i widać go w
`episode.json`: archiwum zapisuje `source.originPath`, czyli miejsce, z którego plik
naprawdę pochodzi, a bajty podane przez przeglądarkę zapisałyby katalog tymczasowy
i odpowiedź na pytanie „skąd to jest" przestałaby istnieć. Klient niczego z tą ścieżką nie
robi: nie przycina, nie rozwija i nie normalizuje, a pilnuje tego test słownika komend.

Jedyne pole, którego ten panel nie zastępuje, to `project.md`: zasady wspólne pisze
człowiek w edytorze, bo to jedyny artefakt tego narzędzia pisany ręcznie. Wywiadu też tu
nie ma: prowadzą go skille `prepare-project` i `develop-series` w terminalu.

## Plan wysyłki, czyli reguła 8 na ekranie

Panel etapu 4 ma jedną rzecz, której nie ma żaden panel tekstowy: **plan wysyłki per tor**.
Bierze się z `prompt-package show --track <tor> --json`, jest darmowy i niczego nie wysyła.

Jest tam, bo to pierwsze miejsce, w którym widać regułę 8: prompt do modelu obrazu albo
wideo to tekst **plus uporządkowane załączniki adresowane po pozycji**. Pakiet nie nazywa
toru, niesie `hero:ewa` i `R01`, a w jaki plik one się zamieniają, rozstrzyga dopiero etap
wysyłający, per tor. Panel numeruje więc listę sam, `Image N = <id> — <rola>`, i dlatego
pyta o obiekt zamiast czytać zdanie: liczba i kolejność to dokładnie to, co trzeba
zobaczyć, zanim cokolwiek poleci.

Tak też się go przegląda, bo zatwierdza się tu plan, a nie graf identyfikatorów. Wybierasz
tor i jedno przyszłe wywołanie (referencję, klatkę otwarcia, klatkę wejściową albo klip).
Panel pokazuje jego załączniki jako obrazy, podpisane `Image N` w kolejności wysyłki,
a pod nimi **cały złożony tekst**, czyli plik z `prompts/` razem z tym, co dokleja do niego
etap wysyłający. Dlatego resolver artefaktów nie serwuje `prompts/**`: stamtąd dostałbyś
połowę promptu, a `show --artifact` daje całość. Obraz załącznika to ten sam adres, pod
którym pokazuje go panel etapu, który go narysował. `end:Cnn` nie ma własnego adresu, więc
stoi tam klip Cnn zatrzymany na ostatniej klatce. Załącznika, którego jeszcze nie ma, nie
widać, a jego stan mówi, który etap go dorysuje.

Plan przychodzi zwykłym GET-em (`/api/send-plan/<projekt>/<odcinek>?track=&artifact=`),
a nie przez pasek komend. Jest darmowy, niczego nie zapisuje i jest pytany przy każdym
kliknięciu w inne wywołanie, więc „Gotowe” w pasku za samo patrzenie byłoby szumem. Jak
drabina, jest pytany ponownie, gdy katalog roboczy się zmieni.

## Przyciski, czyli komendy

Pod każdym przyciskiem stoi komenda, którą on uruchamia, w tej samej postaci, którą
przyjmuje terminal. To nie ozdoba: pipeline prowadzą też agenci, więc to, co klikalne,
musi dać się wkleić. Na stronie etapu komendy pokazuje przełącznik „Pokaż polecenia CLI
pod przyciskami”, domyślnie wyłączony, bo dwanaście ramek z komendami utrudniało
znalezienie przycisków. Wybór zapamiętuje ta przeglądarka i nic poza nią. Każdy przycisk
dalej uruchamia dokładnie jedno `argv`, a pasek wyniku zawsze pokazuje komendę, która
właśnie poszła. Całą gramatykę CLI zna jeden plik (`src/ui/commands.ts`), a test
sprawdza każde zbudowane `argv` względem `--help` tą samą metodą, co test dokumentacji.

„Zatwierdź" pojawia się **wyłącznie wtedy, gdy `check` nie zgłasza problemów**, a artefakt
czeka na przyjęcie. Przycisk, któremu CLI i tak by odmówiło, uczy człowieka, że ekran
kłamie. Ten warunek jest napisany **raz**, w `ui/panel.tsx`, a nie w każdym panelu: trzy
etapy tekstowe stosują go co do pola, więc trzy kopie zrobiłyby z reguły przypadek.

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

**Etap 8 nie ma tego wszystkiego i to jest jego opis, nie wyjątek.** Nie kupuje niczego, więc
nie ma rachunku, nie ma dwóch kroków i nie ma przycisku „Kup”: jest jeden przycisk. Nie ma też
pola modelu, bo nic nie leci do dostawcy; potrzebny jest `ffmpeg` na tej maszynie, a gdy go nie
ma, CLI odmawia zamiast przekodowywać i panel pokazuje **tę samą odmowę, słowo w słowo**.
Próba na sucho zostaje jako pole wyboru, bo preview bez rachunku wciąż odpowiada na drugą
połowę pytania: co i w jakiej kolejności zostałoby sklejone. Plan cięcia bierze się z raportu
etapu, a nie z drugiego pliku: lista ujęć już go niesie, a dwa pliki z jedną prawdą rozjechałyby
się przy pierwszej poprawce ręcznej.

W jakich jednostkach, rozstrzyga **etap**, nie ekran: to on wie, za co dostawca liczy.
Etapy tekstowe liczą wywołania, obrazowe obrazy, etap 7 **dwie liczby naraz**, klatki
wejściowe i klipy, których nigdy się nie sumuje, bo obraz i wideo kosztują o rząd wielkości
inaczej i suma byłaby liczbą, której nikt nie płaci, etap 9 **znaki**, bo dostawca mowy
rozlicza tekst, który dostał, a nie wywołania, a etap 10 **sekundy**, bo jego dostawca
wycenia za minutę wygenerowanego dźwięku i jedno wywołanie na trzydziestosekundowy podkład
to ta sama liczba, co jedno na trzysekundowy grzmot. Dlatego `ui/panel.tsx` trzyma samo
ułożenie rachunku, a to, które pola raportu są rachunkiem, przynosi panel etapu.

Etap 9 pokazuje też, czym rachunek **nie** jest. Jedno polecenie robi tam dwa różne zakupy
i raport mówi który: dopóki skryptu nie ma, kupuje się jedno wywołanie tekstowe; po jego
zatwierdzeniu kupuje się kwestie, które ta zgoda otworzyła. Panel czyta więc dwa różne
zestawy pól tego samego obiektu, bo wypisanie rachunku za mowę w pierwszej fazie pokazałoby
człowiekowi `0` obok przycisku, który zaraz wyda pieniądze. Znaki kontekstu (`previous_text`/`next_text`)
stoją **obok** rachunku i nigdy w nim: dostawca dokumentuje te parametry i nie mówi, czy je
rozlicza, a narzędzie nie zgaduje cudzymi pieniędzmi.

Etap 10 powtarza ten podział na dwa zakupy (arkusz, potem stemy, które jego zatwierdzenie
otworzyło) i dokłada zdanie, którego nie ma nigdzie indziej na tym ekranie: ten dostawca
nalicza przy **generacji**, a nie przy pobraniu, więc `--regenerate` tego samego cue to
druga pełna opłata, nie dopłata. Stoi obok rachunku, bo to nie jest liczba, tylko rzecz do
przeczytania, zanim ktoś kliknie drugi raz.

## Uruchamianie komendy i artefakty

Uruchomienie odpowiada **natychmiast identyfikatorem przebiegu**; wynik `run` przychodzi
później zdarzeniem `run` na strumieniu katalogu roboczego (`/api/events`), otwartym na
każdym ekranie, bo projekt zakłada się, zanim istnieje odcinek, którego strumień mógłby
tę odpowiedź przynieść. Ten sam strumień niesie listę projektów (`list`), przeliczaną po
każdej zmianie na dysku; strumień odcinka niesie drabinę. Etap 7
odpytuje dostawcę minutami, a ekran ma przez ten czas pozostać używalny. Serwer **nie
czyta przekazanego `argv`**: co jest legalną komendą, rozstrzyga CLI, odmawiając.

Artefakty są serwowane tylko do odczytu i adresowane **tym, czym są**: projektem, etapem,
własnym słowem etapu, oraz tą z trzech osi, którą ten etap ma: odcinkiem, torem, postacią.
Osie jadą obok ścieżki, a nie w niej, bo karta postaci nie leży pod żadnym odcinkiem,
a scenariusz pod żadnym torem: segment, który każdy wołający musiałby wypełnić czymkolwiek,
byłby identyfikatorem, który kłamie.

Na ścieżkę tłumaczy je jedno miejsce, przez `workspace.ts`; krotka, której układ nie zna,
dostaje 404, **zanim powstanie jakakolwiek ścieżka**, więc `..` ani ścieżka bezwzględna nie
wyprowadzą odczytu poza katalog roboczy. Obrazy wracają jako `image/png`, bo od etapu 2
zatwierdza się patrząc, a zatwierdzanie obrazu w terminalu to zatwierdzanie nazwy pliku.
Kwestie etapu 9 wracają jako `audio/wav` z tego samego powodu o jeden zmysł dalej: nagranie
ocenione po nazwie pliku to nagranie nieocenione.

Etap 9 jest też pierwszym, którego artefakty leżą na **dwóch poziomach**, i resolver to
rozróżnia po identyfikatorze, a nie po tym, co wołający wpisał w zapytaniu: skrypt i kwestie
są wspólne i nie przyjmują toru, `narrated` przyjmuje tylko z torem. Odwrotnie byłaby to
druga kopia nagrania, którego nikt nie kupił, albo narracja jednego filmu nad obrazem
drugiego. Etap 10 czyta się tak samo: `cues` i stemy (`M01`, `E01`) bez toru, `mixed` tylko
z torem. Stemy wracają jako `audio/mpeg`, bo tylko taki kontener dają oba endpointy tego
dostawcy; wybór jest jego, nie tego potoku, i dlatego werdykt na stemie chodzi po nagłówkach
ramek, a nie po nagłówku RIFF.

Od etapu 7 dochodzi film, a film się **przewija**, więc artefakt odpowiada na nagłówek
`Range`: bez niego 200 i całość, z czytelnym zakresem 206 i dokładnie te bajty (200 kazałoby
odtwarzaczowi uwierzyć, że dostał cały plik, i przestać pytać), z zakresem, którego plik nie
ma, 416 i prawdziwy rozmiar. Bez tego zatwierdzenie dwunastej sekundy wymagałoby obejrzenia
jedenastu. Samą arytmetykę zakresu liczy `src/lib/byte-range.ts`, wspólna z workerem
opublikowanej strony: co dzieli kubełek i plik na dysku, to rachunek, i nic poza nim.
Końcówki klipu (`end:Cnn`) resolver **nie serwuje**: jej format wybiera dostawca, więc nazwa
pliku jest zapisana w stanie etapu, a ten resolver buduje ścieżki i niczego nie zgaduje.

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
`auditmos-theme`, bez stopki. Tokeny kolorów są **rozwiązane dla tego renderera** w
`ui/styles.css`, bo nie ma tu Tailwinda; cyan tylko na głównym przycisku grupy
(„Przejdź do etapu N”, „Zatwierdź”, „Kup”), z ciemnym tekstem. Oba motywy są pełnymi kompozycjami. Język interfejsu jest polski, jak komunikaty
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
`list --json`, żądanie projektu to samo, co `project show --json`, odmowa zostaje odmową
z tym samym komunikatem, strumień zdarzeń wypycha
drabinę po zmianie pliku, artefakt wraca jako bajty z właściwym typem, krotka spoza układu
jako 404, a uruchomiona komenda oddaje identyfikator od razu i wynik zdarzeniem, także
na strumieniu katalogu roboczego, gdy żaden odcinek nie jest otwarty. Słownik
komend jest sprawdzany względem `--help`, a zakup osobno: że jest tą samą wysyłką bez próby
na sucho i że bez ukończonej próby nie daje się zbudować. Ścieżka z formularza etapu 0 ma
własny test przez `app.request()`: po uruchomieniu komendy `episode.json` zapisuje dokładnie
ten ciąg znaków, który dostało pole. Klient jest sprawdzany w przeglądarce, w obu motywach.
