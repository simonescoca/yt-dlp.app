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
- [ ] **T2** Gestore componenti: download con progresso, verifica SHA-256, estrazione zip/tar.xz, versioni, controllo aggiornamenti (yt-dlp nightly, Deno, ffmpeg); firma ad-hoc/rimozione quarantena su macOS
  - *Test:* unit (parsing versioni/checksum, URL per piattaforma) + installazione reale dei componenti Linux nel container
- [ ] **T3** Wrapper yt-dlp: costruzione argomenti (video/audio, contenitori, compatibilità, metadati), analisi `-J`, parser di progresso, esecuzione annullabile, classificazione errori
  - *Test:* unit sul builder e sul parser + download reali (fixture locali mp4/HLS/DASH generate con ffmpeg, siti reali se raggiungibili)
- [ ] **T4** Sniffer di rete: finestra Chromium nascosta, cattura `webRequest` su tutti i frame, ispezione DOM, autoplay silenzioso, classificazione (m3u8/mpd/mp4/webm…), parsing di master m3u8/mpd, esclusione segmenti e pubblicità, ranking e rilevamento ambiguità, rilevamento DRM
  - *Test:* unit su classificazione/ranking/parsing + pagine fixture locali (mp4 diretto, HLS via hls.js, DASH, iframe cross-origin, pubblicità finta, player che si avvia solo al click)
- [ ] **T5** Orchestrazione: job, coda con concorrenza, pipeline analisi → playlist → sniff → download, nomi file duplicati, annullamento, persistenza della cronologia
  - *Test:* unit sulla coda + integrazione end-to-end senza UI
- [ ] **T6** Impostazioni persistenti (cartella, formati, concorrenza, lingua, tema, compatibilità, extra) e selettore cartella nativo
- [ ] **T7** Browser interno di login (partizione persistente condivisa con lo sniffer) ed esportazione dei cookie in formato Netscape per yt-dlp
  - *Test:* unit sull'esportazione dei cookie + verifica che i cookie arrivino al server fixture

### Fase 3 — Interfaccia
- [ ] **T8** Design system (token, tema chiaro/scuro, tipografia, componenti base) + i18n it/en
- [ ] **T9** Bridge IPC tipizzato (preload/contextBridge) tra renderer e main
- [ ] **T10** Schermata principale: campo URL (incolla), Video/Solo audio, formato, cartella, pulsante Scarica
- [ ] **T11** Lista download: card con miniatura, stato, progresso/velocità/ETA, annulla, riprova, apri file/cartella, cronologia
- [ ] **T12** Dialoghi e pannelli: playlist, scelta del flusso, errori, impostazioni, gestione componenti, onboarding del primo avvio

### Fase 4 — Qualità
- [ ] **T13** Test E2E con Playwright su Electron (flussi completi con le fixture locali) + screenshot dell'interfaccia
- [ ] **T14** Casi limite: offline, URL non valido, DRM, annullamento durante l'unione, file esistenti, cartella non scrivibile, errori di aggiornamento

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
