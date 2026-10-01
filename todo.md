# Grabbit — todo & diario di viaggio

App desktop (Windows + macOS Apple Silicon) con interfaccia SPA che, dato un URL,
scarica il video (o solo l'audio) alla massima qualità disponibile usando
**yt-dlp** (sempre aggiornato) come motore, con fallback di **scansione del
traffico di rete** della pagina (come la tab *Network* dei DevTools) per i siti
non supportati.

> Legenda stato: `[ ]` da fare · `[~]` in corso · `[x]` completata · `[!]` bloccata / problema aperto

---

## 1. Requisiti e decisioni (fase di progettazione)

### Requisiti dell'utente
| # | Requisito | Come viene soddisfatto |
|---|-----------|------------------------|
| R1 | Scaricare il video di un URL alla massima qualità | yt-dlp `bv*+ba/b` con ordinamento di default (risoluzione > fps > HDR > codec) |
| R2 | Funzionare su YouTube e altri siti | 1800+ extractor di yt-dlp + extractor "generic" |
| R3 | Scansionare la pagina come la tab Network per trovare mp4/m3u8/mpd… | Sniffer: Chromium interno nascosto + `session.webRequest` (tutti i frame, anche iframe cross-origin) + ispezione DOM, classificazione e ranking dei flussi |
| R4 | Usare sempre l'ultima versione di yt-dlp | Canale **nightly**; controllo aggiornamenti all'avvio e prima di ogni analisi (se l'ultimo controllo è > 1 h fa); verifica SHA-256 |
| R5 | Formato file a scelta (default mp4) | Video: mp4 · mkv · webm · mov |
| R6 | Cartella a scelta (default Download) | Selettore cartella nativo, default `~/Downloads` |
| R7 | Solo audio, massima qualità, formato a scelta (default mp3) | `ba/b` + `-x --audio-format … --audio-quality 0`; formati mp3 · m4a · opus · flac · wav · ogg |
| R8 | Windows + macOS (Apple Silicon) | Electron; build `.exe` (NSIS x64) e `.dmg` (arm64) con GitHub Actions |
| R9 | SPA con interfaccia bella, minimal, pulita, intuitiva | React + TypeScript + Vite nel renderer Electron |

### Decisioni prese con l'utente (Q&A del 2026-09-30)
- **Architettura:** Electron + SPA (finestra nativa).
- **Qualità vs mp4:** massima qualità assoluta, **nessuna ricodifica** (remux nel contenitore scelto). Nelle impostazioni c'è l'opzione "Compatibilità: preferisci H.264/AAC".
- **Sniffing con più flussi trovati:** scelta automatica del migliore; **lista di scelta solo se ambiguo**.
- **Canale yt-dlp:** **nightly**.
- **Playlist:** **chiedere ogni volta** (solo questo video / tutta la playlist).
- **Download multipli:** **coda + cronologia** persistente.
- **Login:** **browser interno di login** (i cookie restano nell'app e sono usati da yt-dlp e dallo sniffer).
- **Lingua:** **italiano + inglese** (automatica dalla lingua di sistema + selettore).
- **Extra nei file:** **metadati + copertina**.
- **Dipendenze (ffmpeg, Deno):** **scaricate al primo avvio** e tenute aggiornate.
- **Tema:** **chiaro/scuro automatico** + selettore.
- **Firma:** **app non firmata** (firma ad-hoc su macOS) + istruzioni per il primo avvio.

### Decisioni tecniche
- **Nome provvisorio:** *Grabbit* (modificabile in un solo punto: `package.json` → `productName`).
- **Stack:** Electron (ultima stabile) · electron-vite · React 19 · TypeScript · CSS con design token · lucide-react (icone) · Vitest (unit) · Playwright (E2E su Electron).
- **Motore gestito dall'app** (cartella dati dell'app, `bin/`):
  - **yt-dlp** nightly, build *onedir* (`yt-dlp_macos.zip`, `yt-dlp_win.zip`, `yt-dlp_linux.zip`): avvio molto più rapido della versione "onefile". Ultima versione ricavata dal redirect di `releases/latest/download/SHA2-256SUMS` (senza API GitHub, quindi senza rate limit), integrità verificata con SHA-256.
  - **Deno** (runtime JS richiesto da yt-dlp per YouTube dal 2025): `dl.deno.land/release-latest.txt`.
  - **ffmpeg + ffprobe**: macOS arm64 da `ffmpeg.martin-riedl.de`; Windows (e Linux, solo per sviluppo/test) da `yt-dlp/FFmpeg-Builds` (build consigliate da yt-dlp).
  - yt-dlp viene sempre avviato con `--ignore-config --ffmpeg-location … --js-runtimes deno:…`, così la configurazione globale dell'utente non interferisce.
- **Flusso di un download:**
  1. *Analisi*: `yt-dlp -J --flat-playlist` → titolo, miniatura, playlist?
  2. Se è una playlist → dialogo (solo questo video / tutta la playlist → un elemento in coda per ogni video, nella sottocartella della playlist).
  3. Se yt-dlp fallisce ("Unsupported URL", nessun formato…) → *scansione della pagina* (sniffer) → flusso migliore (o lista se ambiguo) → yt-dlp scarica il flusso con Referer/User-Agent/cookie corretti.
  4. *Download* con `--load-info-json` (niente seconda estrazione) e progresso in JSON (`--progress-template`).
  5. *Post-processing*: unione/remux (ffmpeg), estrazione audio, metadati + copertina.
- **DRM:** i contenuti protetti da DRM (Widevine/FairPlay: Netflix, Disney+, Prime Video…) **non** sono supportati; l'app lo segnala in modo chiaro.
- **Linux:** supportato solo come piattaforma di sviluppo/test (il container di sviluppo è Linux), non distribuito.

---

## 2. Task

### Fase 0 — Progettazione
- [x] **T0.1** Analisi dei requisiti, studio delle tecnologie, domande all'utente
- [x] **T0.2** Scelta dell'architettura e dello stack, verifica delle fonti di download dei componenti
- [x] **T0.3** Stesura del todo.md (questo file)

### Fase 1 — Fondamenta
- [x] **T1** Scaffolding del progetto: Electron + electron-vite + React + TS, struttura cartelle (`src/main`, `src/preload`, `src/renderer`, `src/shared`), script npm, Vitest, TypeScript strict
  - *Test:* typecheck, build, avvio dell'app in Xvfb con screenshot

### Fase 2 — Motore
- [x] **T2** Gestore componenti: download con progresso, verifica SHA-256, estrazione zip/tar.xz, versioni, controllo aggiornamenti (yt-dlp nightly, Deno, ffmpeg); firma ad-hoc/rimozione quarantena su macOS
  - *Test:* unit (parsing versioni/checksum, URL per piattaforma) + installazione reale dei componenti Linux nel container
- [x] **T3** Wrapper yt-dlp: costruzione argomenti (video/audio, contenitori, compatibilità, metadati), analisi `-J`, parser di progresso, esecuzione annullabile, classificazione errori
  - *Test:* unit sul builder e sul parser + download reali (fixture locali mp4/HLS/DASH generate con ffmpeg, siti reali se raggiungibili)
- [x] **T4** Sniffer di rete: finestra Chromium nascosta, cattura `webRequest` su tutti i frame, ispezione DOM, autoplay silenzioso, classificazione (m3u8/mpd/mp4/webm…), parsing di master m3u8/mpd, esclusione segmenti e pubblicità, ranking e rilevamento ambiguità, rilevamento DRM
  - *Test:* unit su classificazione/ranking/parsing + pagine fixture locali (mp4 diretto, HLS via hls.js, DASH, iframe cross-origin, pubblicità finta, player che si avvia solo al click)
- [x] **T5** Orchestrazione: job, coda con concorrenza, pipeline analisi → playlist → sniff → download, nomi file duplicati, annullamento, persistenza della cronologia
  - *Test:* unit sulla coda + integrazione end-to-end senza UI
- [x] **T6** Impostazioni persistenti (cartella, formati, concorrenza, lingua, tema, compatibilità, extra) e selettore cartella nativo
- [x] **T7** Browser interno di login (partizione persistente condivisa con lo sniffer) ed esportazione dei cookie in formato Netscape per yt-dlp
  - *Test:* unit sull'esportazione dei cookie + verifica che i cookie arrivino al server fixture

### Fase 3 — Interfaccia
- [x] **T8** Design system (token, tema chiaro/scuro, tipografia, componenti base) + i18n it/en
- [x] **T9** Bridge IPC tipizzato (preload/contextBridge) tra renderer e main
- [x] **T10** Schermata principale: campo URL (incolla), Video/Solo audio, formato, cartella, pulsante Scarica
- [x] **T11** Lista download: card con miniatura, stato, progresso/velocità/ETA, annulla, riprova, apri file/cartella, cronologia
- [x] **T12** Dialoghi e pannelli: playlist, scelta del flusso, errori, impostazioni, gestione componenti, onboarding del primo avvio

### Fase 4 — Qualità
- [x] **T13** Test E2E con Playwright su Electron (flussi completi con le fixture locali) + screenshot dell'interfaccia
- [x] **T14** Casi limite: offline, URL non valido, DRM, annullamento durante l'unione, file esistenti, cartella non scrivibile, errori di aggiornamento

### Fase 5 — Distribuzione
- [ ] **T15** Packaging con electron-builder: `.dmg` arm64 (firma ad-hoc), `.exe` NSIS x64, icona
- [ ] **T16** GitHub Actions: CI (typecheck, lint, unit test) + build delle release su tag
- [ ] **T17** README: installazione, primo avvio su macOS/Windows senza firma, uso, sviluppo

### Fase 6 — Conclusione
- [ ] **T18** Revisione finale rispetto ai requisiti, retrospettiva, problemi aperti

---

## 3. Diario di bordo

### 2026-09-30 — T0.1 / T0.2 / T0.3 · Progettazione
- Repository vuoto: si parte da zero.
- Studio dell'ambiente: Node 22, Python 3.11, ffmpeg di sistema, Chromium per Playwright, Xvfb disponibile → l'app Electron si può avviare e testare nel container (Linux).
- **Scoperta importante:** dal 2025 yt-dlp richiede un **runtime JavaScript esterno** per YouTube (Deno di default; supportati anche node ≥ 22, bun, quickjs). Verificato sul codice sorgente di yt-dlp 2026.8.19 (`--js-runtimes`, default `deno`). Deno entra quindi tra i componenti gestiti dall'app.
- **Scivolone 1:** l'API GitHub (`api.github.com/.../releases/latest`) risponde 403 dal container, e così anche la pagina HTML `releases/latest`. Il redirect di `releases/latest/download/<file>` invece funziona e il suo header `Location` contiene il tag della release. **Soluzione:** la versione più recente di yt-dlp si ricava dal redirect di `SHA2-256SUMS` (piccolo file che serve anche a verificare l'integrità). Così l'app non dipende più dalle API GitHub, che hanno anche un rate limit di 60 richieste/ora.
- Scoperte le build **onedir** di yt-dlp (`yt-dlp_macos.zip`, `yt-dlp_win.zip`): si avviano più velocemente della versione onefile, che a ogni avvio si scompatta in una cartella temporanea. Si usano quelle.
- Verificate le fonti di ffmpeg: `ffmpeg.martin-riedl.de` (macOS arm64, 9.0.2, il redirect contiene la versione) e `yt-dlp/FFmpeg-Builds` (Windows/Linux). Deno: `dl.deno.land` (v2.9.7).
- Domande all'utente in 3 round (12 decisioni, vedi §1). Scritto questo todo.md.

### 2026-09-30 — T1 · Scaffolding ✅
- Stack installato: Electron 44.5.1 (Chromium 152, Node 24), electron-vite 5, Vite 7.3, React 19.3, TypeScript 6.0, Vitest 5, Playwright 1.63, electron-builder 26.
- **Scivolone 2 (compatibilità delle versioni):** le versioni più recenti in assoluto non sono compatibili tra loro. electron-vite 5 supporta Vite fino alla 7, mentre Vite 8 e plugin-react 6 escono dal suo intervallo. TypeScript 7 (il port nativo in Go) è troppo nuovo per la toolchain. **Soluzione:** Vite 7 + plugin-react 5.2 + TypeScript 6.
- **Scivolone 3:** TypeScript 6 segnala come errore l'opzione `baseUrl`, deprecata. **Soluzione:** rimossa; i `paths` ora sono relativi al tsconfig.
- **Scivolone 4:** il primo avvio del test smoke è fallito, perché la finestra non era pronta entro i 5 s di timeout di Playwright (primo avvio "a freddo" di Electron/Chromium in Xvfb). I 4 avvii successivi sono passati in circa 1 s. **Soluzione:** timeout di `expect` portato a 20 s.
- **Scivolone 5:** electron-vite di default non minifica il renderer (bundle da 641 kB). Attivato `minify` → 222 kB.
- In container Electron gira come root e richiede `--no-sandbox`: aggiunto solo nei test, mai nell'app.
- *Test:* `npm run typecheck` ✅ · `npm run build` ✅ · E2E smoke (avvio in Xvfb + screenshot) ✅

### 2026-09-30 — T2 · Gestore componenti ✅
- Scritti `src/main/engine/sources.ts` (fonti per piattaforma, funzioni pure), `http.ts` (rete Electron/Node, download in streaming con SHA-256), `archive.ts` (zip / tar.xz) e `components.ts` (`ComponentManager`).
- Ogni versione viene installata nella propria cartella (`bin/<componente>/<revisione>/`), così un aggiornamento non tocca i file di un processo yt-dlp in esecuzione. Le cartelle vecchie vengono eliminate dopo l'installazione o al successivo avvio. Il manifest viene scritto in modo atomico.
- Se il controllo degli aggiornamenti fallisce (es. offline) ma c'è già una versione installata, l'app continua a funzionare e mostra l'errore solo come informazione.
- Su macOS: rimozione della quarantena e, se il binario viene bloccato, firma ad-hoc (`codesign -s -`) e nuovo tentativo.
- **Scivolone 6 (bug trovato dai test):** installando i 3 componenti in parallelo, le scritture del manifest usavano lo stesso file temporaneo e andavano in conflitto (`ENOENT` su `rename`). **Soluzione:** scritture serializzate tramite una catena di promise.
- **Scivolone 7:** dopo le installazioni restava una cartella `.tmp` vuota. **Soluzione:** `rmdir` a fine installazione (riesce solo quando non ci sono altre installazioni in corso).
- **Scivolone 8 (solo ambiente di sviluppo):** il Chromium di Electron nel container rifiutava i certificati del proxy HTTPS (`ERR_CERT_AUTHORITY_INVALID`), perché non legge la CA dalle variabili d'ambiente. **Soluzione:** CA aggiunta allo store NSS dell'utente (`~/.pki/nssdb`), senza disattivare la verifica TLS e senza toccare il codice dell'app.
- **Scoperta:** `net.fetch` di Electron con `redirect: 'manual'` non restituisce il 302 ma va in errore ("Redirect was cancelled"). **Soluzione:** per leggere il redirect si usa `net.request` con l'evento `redirect`.
- *Test:* 10 test unitari sulle fonti + 5 sul `ComponentManager`, eseguiti con un server finto e archivi zip/tar.xz veri (installazione, nessun download superfluo al riavvio, aggiornamento a una nuova nightly con rimozione della vecchia, `maxAge`, checksum errato, modalità offline) ✅.
- *Test di integrazione reale* (`npm run test:integration`): installati yt-dlp nightly 2026.09.27.232945, Deno v2.9.7 e ffmpeg N-127043 in 17 s. yt-dlp in versione onedir si avvia in 0,48 s ✅.
- ⚠️ *Da verificare:* i percorsi macOS e Windows non si possono provare nel container Linux. Verranno verificati con GitHub Actions (runner `macos-14` arm64 e `windows-latest`) in T16.

### 2026-10-01 — T3 · Wrapper yt-dlp ✅ (con un limite d'ambiente aperto)
- Moduli in `src/main/ytdlp/`:
  - `options.ts`: selezione dei formati e contenitori (funzioni pure), nomi file sicuri per Windows/macOS, nomi univoci ("titolo (2).mp4").
  - `progress.ts`: progresso complessivo pesato sui byte di video e audio, fasi (download, unione, conversione, incorporamento).
  - `errors.ts`: 19 categorie di errore leggibili.
  - `runner.ts`: avvio annullabile; su macOS/Linux termina l'intero gruppo di processi, ffmpeg compreso, su Windows usa `taskkill /T`.
  - `analyze.ts`: `-J --flat-playlist` + rilevamento di "solo questo video" nelle playlist.
  - `download.ts`.
- Le scelte sui contenitori derivano dallo studio del sorgente di yt-dlp (`get_compatible_ext`): **mp4/mkv** accettano qualsiasi codec, quindi solo remux; **mov** preferisce H.264/HEVC + AAC; **webm** preferisce VP9/AV1 + Opus e ricodifica solo come ultima risorsa.
- Il progresso esce in JSON tramite `--progress-template` e `--print before_dl/after_move`, così non si dipende dal testo in inglese di yt-dlp.
- **Scivolone 9:** i segmenti HLS di test hanno estensione `.ts` (MPEG Transport Stream) e TypeScript ha provato a compilarli 😅. **Soluzione:** cartella media esclusa dal tsconfig.
- **Scivolone 10:** in `-J` i valori `None` vengono stampati come `NA`, non come `null`. **Soluzione:** template con `|null` (es. `%(progress.total_bytes|null)s`), così l'output è JSON valido.
- **Scivolone 11:** non si riesce a sapere se l'URL di una playlist punta anche a un video specifico. Il messaggio "add --no-playlist…" viene soppresso da `-J`, e con `--no-quiet` finisce su stdout e rompe il JSON. **Soluzione:** quando l'analisi restituisce una playlist, si lancia una seconda analisi veloce con `--no-playlist --flat-playlist`.
- **Scivolone 12 (bug trovato dai test):** la fase "Unione" non compariva mai. I test di integrazione hanno mostrato che yt-dlp stampa il progresso del post-processing su **stderr**. **Soluzione:** anche stderr passa dal parser.
- **Scivolone 13 (aperto, solo ambiente):** dal container YouTube risponde 403 al download, anche con la CLI di yt-dlp pura, perché gli IP dei datacenter richiedono un *PO token*. Dopo qualche richiesta anche l'analisi riceve "Sign in to confirm you're not a bot". Da `-v` risulta che Deno viene usato correttamente per la sfida JS. Su una connessione domestica non dovrebbe succedere. Se capita, l'errore è classificato `login_required` e l'app propone l'accesso tramite il browser interno. Il test del download da YouTube è attivabile con `GRABBIT_YT_DOWNLOAD=1` e **va verificato dall'utente**.
- *Test:* 32 nuovi test unitari (argomenti, progresso, 14 casi di errore, nomi file, parsing) ✅. 13 test di integrazione con yt-dlp vero su fixture locali ✅:
  - scelta della variante HLS migliore (720p su 240p) → mp4;
  - DASH video + audio → mp4/mkv/mov senza ricodifica (H.264 + AAC verificati con ffprobe);
  - mp4 H.264 → WebM VP9 + Opus vero;
  - audio mp3/m4a/opus/flac/wav/ogg con codec corretti e metadati;
  - annullamento a metà download (< 15 s, nessun file residuo);
  - errore 404.

### 2026-10-01 — T4 · Sniffer di rete ("tab Network") ✅
- Moduli in `src/main/sniffer/`:
  - `classify.ts`: riconosce HLS, DASH, ISM, file progressivi e audio da MIME, estensione e tipo di risorsa; scarta segmenti, redirect ed errori; euristiche per pubblicità e licenze DRM.
  - `manifest.ts`: lettura di m3u8 master/media (varianti, durata, live, DRM SAMPLE-AES/FairPlay/Widevine) e di MPD (durata ISO-8601, risoluzione massima, ContentProtection).
  - `rank.ts`: punteggio e rilevamento dell'ambiguità. Due video "principali" sono ambigui se hanno durate diverse; con la stessa durata sono varianti dello stesso video.
  - `sniffer.ts`, il motore:
    - cattura delle richieste con `session.webRequest`, che copre **tutti i frame, anche gli iframe cross-origin**, smistate per `webContentsId`; i redirect vengono seguiti;
    - lettura del DOM in ogni frame (`<video>`/`<source>`, og:title, og:image);
    - escalation per avviare il player: `play()` muto → clic sui pulsanti "play" più comuni → clic **trusted** (`sendInputEvent`) al centro del player più grande;
    - blocco di popup e di navigazioni pubblicitarie;
    - arresto quando la rete si stabilizza (3 s senza novità) o alla scadenza del timeout; annullabile.
  - Modalità interattiva (finestra visibile, lista dal vivo) pronta per l'interfaccia.
  - `probe.ts`: durata e risoluzione dei file progressivi tramite ffprobe.
- `src/main/browser/cookies.ts`: esportazione dei cookie della sessione in formato Netscape per yt-dlp (anticipata da T7).
- **Decisione:** la finestra di scansione usa il **rendering offscreen** invece di una finestra nascosta. Molti player non partono se `document.visibilityState` è `hidden`; con l'offscreen la pagina risulta "visibile" senza comparire sullo schermo. Una fixture lo verifica: un player che parte solo se la pagina è visibile.
- **Scoperta:** al sniffer basta Chromium per catturare il manifest anche quando il player usa MSE (`src="blob:…"`): il blob non passa in rete, ma il .m3u8/.mpd sì.
- **Ottimizzazione:** con DRM rilevato la scansione si ferma subito invece di provare tutti i clic (da 11,5 s a 3 s).
- *Test:* 15 nuovi test unitari (classificazione, HLS, DASH, ranking, cookies.txt) ✅. 11 test E2E dentro Electron (harness con esbuild, `npm run test:electron`) su 9 pagine fixture ✅:
  - mp4 con pubblicità e player che aspetta la visibilità;
  - hls.js/MSE, con varianti nascoste sotto il master;
  - DASH via fetch, senza segmenti in lista;
  - iframe cross-origin, con il Referer corretto;
  - player che parte solo con un clic trusted;
  - due video lunghi → ambiguo;
  - DRM → rilevato e mai scelto;
  - pagina vuota;
  - annullamento in < 2 s;
  - flusso protetto da cookie + Referer, trovato **e scaricato da yt-dlp** con i cookie esportati e uno User-Agent Chrome pulito.
- *Test reale:* sulla pagina demo di hls.js (rete) è stato trovato il master m3u8 di Big Buck Bunny, 1080p e 634 s, con le varianti nascoste ✅.

### 2026-10-01 — T5 · T6 · T7 · T9 · Core dell'app ✅
- `src/main/core/jobs.ts` (`JobManager`): coda con concorrenza configurabile (default 2), pipeline analisi → scelta della playlist → *fallback* sullo sniffer → download.
  - Nomi file mai sovrascritti: "titolo (2).mp4", con prenotazione dei nomi per evitare collisioni tra download paralleli.
  - Playlist in una sottocartella con numerazione "01 - …".
  - Se le URL salvate dall'analisi sono scadute, nuovo tentativo con un'estrazione fresca.
  - Annullamento, nuovo tentativo, cronologia persistente; i lavori interrotti dalla chiusura dell'app vengono segnati come tali.
  - Tutte le dipendenze sono iniettate, quindi testabile senza Electron.
- `src/main/core/settings.ts` + `store.ts`:
  - impostazioni validate campo per campo, così un file corrotto o vecchio non rompe l'app;
  - scritture JSON atomiche e *debounced*;
  - preferenze ricordate (ultima modalità/formato/cartella); al primo avvio restano mp4 / mp3 / Download come richiesto.
- `src/main/core/app-core.ts`: collega motore, coda, sniffer, login e log su file (`logs/main.log` con rotazione a 5 MB). yt-dlp viene aggiornato a ogni avvio, ogni 6 ore e prima di ogni analisi se l'ultimo controllo ha più di un'ora; Deno ogni 24 ore, ffmpeg ogni 7 giorni.
- `src/main/browser/web.ts` (T7): profilo browser persistente condiviso tra la finestra di login e lo sniffer; i popup OAuth restano nello stesso profilo; lista dei siti visitati per accedere; "Esci da tutti" cancella cookie, storage e cache.
- `src/main/ipc.ts` + `src/preload/index.ts` (T9): API tipizzata `window.grabbit` (20 metodi + eventi push). Il renderer resta in sandbox, con `contextIsolation` attivo e senza Node.
- Altro: istanza singola, notifica di sistema a download completato (se la finestra non ha il focus), link esterni aperti nel browser di sistema.
- **Scivolone 14 (race condition trovata dai test):** con "riprova", o con la scelta della playlist subito dopo l'analisi, la pulizia del run precedente cancellava la cartella temporanea e il controller di quello nuovo. **Soluzione:** una cartella temporanea per ogni run, e il controller viene rimosso solo se appartiene ancora a quel run.
- **Scoperta:** in Electron 44 `clipboard.readText()` è diventato **asincrono** (restituisce una Promise). Il typecheck l'ha segnalato.
- *Test:* 12 test unitari sul `JobManager` (download semplice, nomi univoci, concorrenza massima, playlist "solo questo video" / voci scelte in sottocartella, *fallback* sullo sniffer, scelta in caso di ambiguità, DRM/nessun media/login, annullamento, nuova estrazione con URL scadute, motore mancante + riprova, ripristino della cronologia) ✅.
- *Test E2E nell'app vera (Playwright + Electron):* HLS diretto → `master.mp4`; pagina non supportata → sniffer → `Diretta HLS (hls.js).mp3`, con il titolo preso dalla pagina; impostazioni e cronologia sopravvivono al riavvio ✅.

### 2026-10-01 — T8 · T10 · T11 · T12 · Interfaccia ✅
- **Design system** (`styles.css`): token di colore definiti con `light-dark()`, così un solo set di variabili copre i due temi; il tema "Sistema / Chiaro / Scuro" forza `color-scheme` tramite `[data-theme]`. Font di sistema (SF su Mac, Segoe UI su Windows) e nessuna risorsa esterna, quindi l'app funziona offline. Rispetta `prefers-reduced-motion`; layout adattivo fino a 600 px.
- **i18n** (`i18n.ts`): oltre 150 testi in italiano e inglese; la lingua è automatica (italiano se il sistema è in italiano) e si può cambiare. Ogni codice d'errore ha una spiegazione semplice e le azioni possibili (Riprova / Apri la pagina / Accedi al sito) + "Dettagli" con il messaggio originale.
- **Schermata unica:**
  - campo URL grande con "Incolla" + incolla con ⌘V/Ctrl+V ovunque nella finestra + trascinamento dei link;
  - interruttore Video / Solo audio;
  - menu del formato con una spiegazione per ognuno ("MP4 — Compatibile ovunque"…);
  - scelta della cartella con il selettore nativo;
  - pulsante Scarica.
  Formato, modalità e cartella vengono ricordati.
- **Lista download:** card con miniatura, durata, formato e fonte ("trovato nella pagina" se viene dallo sniffer). Il progresso mostra % · scaricato/totale · velocità · tempo rimanente, poi le fasi (unione, conversione, copertina). Azioni: apri, mostra nella cartella, riprova, annulla, rimuovi, svuota completati.
- **Dialoghi:**
  - playlist: solo questo video / tutta la playlist / scegli quali video (con caselle di selezione);
  - scelta del flusso quando lo sniffer trova più video (risoluzione, durata, peso, badge "Consigliato" / "probabile pubblicità" / "DRM").
  Si aprono da soli una volta; dalla card si riaprono con "Scegli".
- **Pannello impostazioni:** lingua, tema, download simultanei (1–5), massima compatibilità, metadati, copertina, accesso ai siti (YouTube, Vimeo, Instagram, Facebook, X, TikTok o indirizzo libero) con "Esci da tutti", canale di yt-dlp, versioni dei componenti, "Controlla aggiornamenti", info. Al primo avvio un banner mostra la preparazione del motore; in basso c'è la versione di yt-dlp con un indicatore di stato.
- **Scivolone 15:** il tema scuro non si applicava nei test, perché Playwright forza `prefers-color-scheme: light` sulle finestre Electron. **Soluzione:** i token passano a `light-dark()` + `color-scheme` impostato da `[data-theme]`, così il tema non dipende dall'emulazione. Il codice è anche più pulito, senza blocchi duplicati.
- **Scivolone 16 (bug UX trovato dai test):** il campo `type="url"` attivava la validazione nativa del browser, che bloccava l'invio con un suo fumetto al posto del nostro messaggio. **Soluzione:** `noValidate`.
- **Scivolone 17 (bug trovato dai test):** nelle playlist "generiche" (più video nella stessa pagina) tutte le voci avevano la stessa URL, perché il `webpage_url` di ogni voce è la pagina stessa. Il risultato era "Scarica 1 video" con 2 video selezionati. **Soluzione:** si preferisce l'`url` della voce e si scartano i duplicati, + test unitario.
- **Scivolone 18 (stile):** un pulsante principale disabilitato diventava grigio al passaggio del mouse, perché la regola generica `.btn:hover` lo sovrascriveva. **Soluzione:** `:hover:not(:disabled)`.
- **Miglioramenti:** se lo sniffer non trova nulla, la card mostra comunque il titolo della pagina invece del solo host. Nelle pagine senza video, la scansione si ferma 3 s dopo l'ultimo tentativo invece di aspettare il timeout (errore in 16 s invece di 27).
- *Test:* 13 test E2E sull'interfaccia vera (Playwright → Electron) ✅:
  - stato vuoto in italiano con mp4 di default;
  - testo non valido rifiutato;
  - incolla ovunque;
  - download con barra di avanzamento e completamento;
  - solo audio in M4A;
  - playlist con scelta delle voci e sottocartella;
  - sniffer con scelta del flusso;
  - pagina senza video con errore chiaro + "Apri la pagina" + "Dettagli";
  - annullamento;
  - impostazioni (tema scuro, inglese, versioni del motore);
  - svuota completati.
  Gli screenshot sono in `test-results/screens/`.

### 2026-10-01 — T13 · T14 · Test end-to-end e casi limite ✅
- Nuova suite `tests/e2e/edge.spec.ts`:
  - **primo avvio senza internet** (proxy che rifiuta ogni connessione) → banner "Non riesco a preparare il motore" con "Riprova"; un download spiega "Il motore di download non è pronto";
  - **cartella non scrivibile** → "Non posso scrivere nella cartella scelta";
  - **"Apri la pagina"** su un sito dove il video parte solo cliccando un piccolo link in un angolo (l'automatismo non ci riesce, per scelta del test) → l'utente clicca nella finestra, la chiude → la lista dei flussi si apre → download completato;
  - **finestra di accesso** → il sito compare nella lista e il cookie è nel profilo; "Esci da tutti i siti" lo cancella;
  - **primo avvio online** → il banner mostra l'avanzamento e il motore vero (yt-dlp nightly + Deno + ffmpeg) viene scaricato **tramite la rete di Electron** in 14,5 s.
- Nella modalità interattiva, il titolo della finestra dice cosa fare ("▶ Avvia il video, poi chiudi questa finestra") e la card mostra lo stesso suggerimento.
- **Scivolone 19 (bug trovato prima dei test):** `siteOf("127.0.0.1")` restituiva "0.1" (un IP trattato come dominio). **Soluzione:** IP e host senza punti vengono mostrati così come sono, + test unitario.
- **Scivolone 20 (ambiente):** il test "cartella non scrivibile" usava `/proc/...`, dove `mkdir -p` di Node **si blocca per sempre** (stranezza del filesystem virtuale). Inoltre come root i permessi non si possono simulare. **Soluzione:** si usa un percorso "dentro" un file (ENOTDIR), che fallisce anche per root.
- **Scivolone 21 (mio):** un `pkill -f <pattern>` ha ucciso anche la shell che lo eseguiva, perché la riga di comando conteneva lo stesso pattern, e la modifica successiva non è stata applicata. Me ne sono accorto con un `grep` di controllo e ho rieseguito.
- **Scivolone 22:** Playwright svuota `test-results/` a ogni esecuzione, quindi gli screenshot sparivano. **Soluzione:** salvati in `docs/screenshots/`, così si possono usare anche nel README.
- *Totale test a questo punto:* 77 unitari ✅ · 14 integrazione yt-dlp/motore ✅ · 12 sniffer dentro Electron ✅ · 18 E2E sull'app vera ✅.
