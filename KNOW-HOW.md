# Doci CLI

Jeden plik `doci.mjs`, Node.js 22+, bez zależności npm. Pobiera pojedyncze pliki i katalogi; rozpoznaje typ strony po `+fID` / `+dID`. Dry run, whitelistę formatów i odpytywanie metadanych do estymacji usunięto.

## Uruchomienie

```sh
# Jednorazowo; drugi argument ZAWSZE oznacza katalog docelowy:
node doci.mjs 'URL_PLIKU_LUB_KATALOGU' './pobrane' --recursive --filter-max-size-mb 5 --concurrency 100

# Cały proces z jedną konfiguracją, URL-e wpisywane na bieżąco:
node doci.mjs --interactive './pobrane' --recursive --filter-max-size-mb 5 --concurrency 100
```

W interactive wpisz URL i Enter. Można wkleić kilka linii lub kilka URL-i oddzielonych białymi znakami. Kolejne URL-e są przyjmowane podczas pobierania. Gdy kolejka jest pusta, proces nadal czeka na input.

- `/status`: stan procesu.
- `/exit`, `/quit` lub Ctrl-D/EOF: przestań przyjmować URL-e, opróżnij kolejkę i zakończ.
- Ctrl-C: przerwij proces od razu; `.part` pozostają.
- Nieprawidłowy URL jest odrzucany bez zamykania sesji. Błąd joba nie zatrzymuje pozostałych.
- Ten sam URL, który już jest aktywny lub zakolejkowany, nie jest dodawany drugi raz. Po jego zakończeniu można podać go ponownie: istniejące pliki zostaną pominięte.

Kolejka URL-i jest w pamięci procesu. Manifesty utrwalają ukończone pobrania i błędy, nie historię inputu. Po restarcie podaj potrzebne URL-e ponownie.

## Opcje wspólne dla procesu

| Opcja | Znaczenie |
|---|---|
| `--interactive` | Zamiast argumentu URL przyjmuje URL-e ze stdin |
| `--recursive` | Schodzi do podkatalogów każdego dodanego katalogu |
| `--concurrency N` | Maks. N jednoczesnych zadań sieciowych: transfery plików i listowania katalogów, wspólnie dla wszystkich jobów; domyślnie 5 |
| `--filter-max-size-mb N` | Każdy nowy plik może mieć maks. N MB; domyślnie 50; 0 = bez limitu |
| `--limit N` | Maksymalnie N nowych, skutecznie pobranych plików w całym procesie, nie na każdy URL |
| `--list` | Tylko listuje URL-e; nie pobiera ani nie zapisuje manifestów |
| `--help` | Pomoc |

1 MB = 1 000 000 bajtów. Dozwolone są wartości ułamkowe, np. 2.5 MB. Pasek transferu używa MiB/KiB. Dokładnie równy limit rozmiar przechodzi; większy jest pomijany. W interactive `--limit` jest globalny: po jego osiągnięciu proces dalej przyjmuje input, ale kolejne joby nie rozpoczynają pobierania. Bez `--limit` nie ma limitu liczby plików.

Katalog docelowy dotyczy każdego dodanego URL-a. Pojedyncze pliki trafiają bezpośrednio do niego pod nazwą z Content-Disposition. Katalogi zapisują własne pliki bezpośrednio w celu, a podkatalogi jako `NAZWA--ID`. Jeśli dodasz dwa katalogi do tego samego celu, ich pliki głównego poziomu trafią do wspólnego folderu. Kolizja nazwy nie nadpisuje istniejącego pliku. Bez celu interactive używa bieżącego folderu. W jednorazowym trybie URL pliku używa bieżącego folderu, a URL katalogu — folderu ze sluga URL.

## Współbieżność i terminal

Jest jedna pula FIFO na proces. Dodanie 10 URL-i z `--concurrency 5` nie tworzy 10 pul po 5. Listowanie katalogów oraz pełne flow pojedynczego pliku zajmują miejsca w tej samej puli. Retry zachowuje miejsce. Różne joby mogą być na różnych etapach: skan katalogu jednego URL-a może działać obok pobierania z drugiego. Zakończenie odbywa się w kolejności wynikającej z czasów serwera, a nie kolejności inputu.

Każdy plik ma osobny cookie jar, aby równoległe payment_info i /download nie nadpisywały sobie sesji. Zapisy jednego manifestu są kolejkowane i korzystają ze wspólnego stanu w pamięci również między jobami. Ścieżki `.part` są blokowane między zadaniami o tej samej nazwie wyjściowej. `--limit` ma wspólne rezerwacje miejsc: nie zostanie przekroczony przez zadania już w locie.

Terminal pokazuje jedno wspólne drzewo katalogów wszystkich jobów, niżej paski aktywnych transferów i input `URL>`. Liczniki katalogów sumują potomków. Istniejące pliki liczą się jako ukończone; wykluczenia rozmiaru i błędy są osobne. Nieznana zawartość po błędzie listowania oznacza NIEPEŁNE. Numery plików dotyczą spisu danego joba. Przy małym terminalu część wierszy jest skracana; po wyjściu wyświetlane jest końcowe drzewo. Bez TTY używane są zwykłe logi, bez animacji ANSI.

## Idempotencja, rozmiar i błędy

- Istniejący plik końcowy oznacza ukończenie i jest pomijany, także bez manifestu. Nie przeliczamy jego sumy. Uszkodzony plik końcowy trzeba usunąć albo przemianować na `.part`.
- Pobieranie używa pliku tymczasowego o nazwie docelowego pliku z dopisanym `.part`. Po pełnym transferze publikuje plik końcowy atomowo, bez nadpisania. Błąd zachowuje `.part`; ponowienie pobiera od początku, bez append/Range.
- Manifest `.doci-downloads.json` zawiera ukończone pliki, błędy i wykluczenia rozmiaru. Przy znanej ścieżce pomijanie następuje bez żądań do pliku. Bez manifestu nazwa jest przewidywana z HTML; ostateczne sprawdzenie następuje też po Content-Disposition, przed odczytem ciała pliku.
- Limit rozmiaru jest sprawdzany w data-size strony, następnie w Content-Length, a przy braku wiarygodnych danych — podczas streamingu. Ostatni wariant może odczytać jeden dodatkowy chunk ponad próg. Duże pliki nie mają retry i nie zużywają limitu liczby pobrań.
- `skippedLarge` jest porównywane z aktualnym progiem. Zwiększenie progu lub ustawienie 0 dopuszcza wcześniejsze wykluczenia. Jeśli plik na serwerze zmienił rozmiar i stary wpis nadal go blokuje, usuń wpis z `skippedLarge`, aby ponownie sprawdzić.
- Każdy plik i katalog ma maks. 3 próby, z przerwami 1 i 2 sekundy. Pętla przekierowań nie jest ponawiana. Po wyczerpaniu prób kontynuujemy pozostałe zadania; kod wyjścia 1 oznacza niepełny wynik.
- `.doci-scan-errors.json` zawiera błędy listowania, rozdzielone według startowego URL-a. Nieznanej zawartości nie wliczamy do liczby plików. Powtórne dodanie URL-a ponownie skanuje katalogi, a ukończone pliki pomija.
- Błędy zapisu manifestu kończą dany job po rozliczeniu zleconych zadań, pozostałe joby pozostają aktywne.
- Ochrona współdzielenia dotyczy jednego procesu CLI. Nie uruchamiaj dwóch procesów do tego samego katalogu wyjściowego. Manifest zapisuje ścieżki absolutne.

## PR ID

PR ID to numer akcji PRowej. Skrypt nie zawiera domyślnego numeru. Każdy uprawniony użytkownik musi samodzielnie odczytać go ze swojej przeglądarki, wyłącznie jeśli otrzymał dostęp w ramach takiej akcji.

```sh
DOCI_PR_ID=TWOJ_NUMER_AKCJI_PR node doci.mjs --interactive './pobrane'
node doci.mjs 'URL' './pobrane'  # bez ustawionego DOCI_PR_ID skrypt nie dodaje cookie akcji PR
```

Jeśli otrzymałeś takie uprawnienie, w swojej przeglądarce otwórz narzędzia deweloperskie → Network, znajdź żądanie `download/payment_info` i odczytaj wartość cookie `cookie_cookieaccess_pr_id` z nagłówka żądania. Zastąp `TWOJ_NUMER_AKCJI_PR` własną wartością liczbową. Nie używaj cudzych numerów ani nie zgaduj wartości. Posiadanie numeru nie zastępuje uprawnienia do dostępu ani praw do pobieranych materiałów.

Ważność i zakres akcji określa usługodawca; działająca odpowiedź serwera nie potwierdza trwałego uprawnienia. `Max-Age` cookie sesyjnego nie określa ważności akcji PR.

## Przebieg pobierania

1. GET strony dokumentu i odczyt `data-file-id`.
2. POST `https://doci.pl/download/payment_info`. Pola `item_id` i `file_id` pochodzą z aktualnej strony dokumentu.
3. Odpowiedź `success:true` zawiera `download_data.download_url`, `time` i `item_id`. Zachowujemy cookies odpowiedzi; timestamp pochodzi z serwera.
4. GET `{download_url}/{item_id}/{time}`.
5. Backend zwraca przekierowanie do kompletnego adresu pobierania. Skrypt korzysta z adresu serwera bez samodzielnego generowania ani modyfikowania tokenów.
6. Podążamy za przekierowaniem i zapisujemy plik strumieniowo.

Kolejne nagłówki `Set-Cookie` o tej samej nazwie, domenie i ścieżce przetwarzamy w kolejności.

## Granice i diagnostyka

Parser katalogów czyta linki z `<article>`, usuwa szablony w script i pomija boczne drzewo/rodziców. Rekurencja trzyma się konta użytkownika i deduplikuje ID katalogów. Licznik plików w serwisie może różnić się od liczby linków dostępnych w HTML. Przy wykryciu rel=next przerywamy dany skan zamiast udawać kompletność; przyszłe formaty paginacji mogą wymagać zmiany parsera.

Żądania i przekierowania są ograniczone do HTTPS w doci.pl. Location z UTF-8 jest dekodowane, a powtarzający się URL oznacza pętlę. Pętle przekierowań i błędy HTTP mogą wynikać z problemów po stronie serwisu; nie każdy błąd oznacza throttling. Cookie jar jest dopasowany do zaobserwowanego flow i kluczuje cookies po nazwie, nie jest pełnym magazynem przeglądarki. Timeout listowania: 60 s; pojedynczego żądania/transferu: 5 min.

Weryfikacja: `node --check doci.mjs` oraz `node --test doci.test.mjs`. Testy symulują HTTP i input stdin: idempotencja, częściowe transfery, retry, globalna concurrency i limit, izolacja cookies, rozmiary, wspólny manifest między jobami, przyjmowanie URL-i podczas pobierania i oczekiwanie po opróżnieniu kolejki. Nie pobierają rzeczywistych plików z serwisu.
