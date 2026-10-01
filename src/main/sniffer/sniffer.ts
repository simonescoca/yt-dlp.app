import { BrowserWindow, type Session, type WebContents } from 'electron'
import type { SniffResult, StreamCandidate } from '@shared/types'
import { classifyResponse, looksLikeAd, looksLikeDrmLicense, type Classified } from './classify'
import { parseDash, parseHls } from './manifest'
import { rankCandidates, scoreCandidate } from './rank'

/** Optional prober for progressive files (ffprobe), used when the page does not tell the duration. */
export type Prober = (url: string, headers: Record<string, string>) => Promise<{ duration: number | null; width: number | null; height: number | null } | null>

export interface SniffOptions {
  url: string
  session: Session
  userAgent: string
  /** Hard limit for the automatic scan. */
  timeoutMs?: number
  /** Interactive mode: shows the page so the user can click "play"; ends when the window is closed or `signal` aborts. */
  visible?: boolean
  signal?: AbortSignal
  probe?: Prober
  /** Called whenever the candidate list changes (live list in interactive mode). */
  onUpdate?: (result: SniffResult) => void
  log?: (msg: string) => void
}

interface RawHit {
  url: string
  method: string
  classified: Classified
  referer: string
  requestHeaders: Record<string, string>
}

interface Listener {
  onHit(hit: RawHit): void
  onDrm(): void
  onRedirect(from: string, to: string): void
}

// ---------------------------------------------------------------------------
// Network tap: one set of webRequest listeners per session, routed by webContents.
// ---------------------------------------------------------------------------

const taps = new WeakMap<Session, Map<number, Listener>>()
const REPLAY_HEADERS = ['referer', 'origin', 'user-agent', 'authorization', 'x-requested-with']

function lowerHeaders(h: Record<string, string | string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = Array.isArray(v) ? v[0] ?? '' : v
  return out
}

function tapFor(session: Session): Map<number, Listener> {
  let listeners = taps.get(session)
  if (listeners) return listeners
  const routes = new Map<number, Listener>()
  listeners = routes
  taps.set(session, routes)
  const requestHeaders = new Map<number, Record<string, string>>()
  const pick = (id: number | undefined): Listener[] => {
    if (id != null && routes.has(id)) return [routes.get(id)!]
    // Requests without a webContents (e.g. service workers): give them to every active scan.
    return id == null ? [...routes.values()] : []
  }

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (routes.size) {
      const h = lowerHeaders(details.requestHeaders)
      requestHeaders.set(details.id, h)
      if (looksLikeDrmLicense(details.url, details.method)) pick(details.webContentsId).forEach((l) => l.onDrm())
    }
    callback({ requestHeaders: details.requestHeaders })
  })
  session.webRequest.onHeadersReceived((details, callback) => {
    if (routes.size) {
      const classified = classifyResponse({
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        headers: lowerHeaders(details.responseHeaders),
        resourceType: details.resourceType
      })
      if (classified) {
        const req = requestHeaders.get(details.id) ?? {}
        const replay: Record<string, string> = {}
        for (const k of REPLAY_HEADERS) if (req[k]) replay[k] = req[k]!
        const hit: RawHit = {
          url: details.url,
          method: details.method,
          classified,
          referer: req['referer'] ?? details.referrer ?? '',
          requestHeaders: replay
        }
        pick(details.webContentsId).forEach((l) => l.onHit(hit))
      }
    }
    callback({})
  })
  session.webRequest.onBeforeRedirect((details) => {
    if (routes.size) pick(details.webContentsId).forEach((l) => l.onRedirect(details.url, details.redirectURL))
  })
  const forget = (details: { id: number }): void => {
    requestHeaders.delete(details.id)
  }
  session.webRequest.onCompleted(forget)
  session.webRequest.onErrorOccurred(forget)
  return listeners
}

// ---------------------------------------------------------------------------
// In-page scripts (run in every frame, also cross-origin iframes).
// ---------------------------------------------------------------------------

interface DomMedia {
  src: string
  duration: number | null
  width: number | null
  height: number | null
}

interface DomInfo {
  url: string
  title: string
  media: DomMedia[]
  metas: Record<string, string>
}

const COLLECT_SCRIPT = `(() => {
  const media = []
  for (const v of document.querySelectorAll('video, audio')) {
    const srcs = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)]
    for (const src of new Set(srcs.filter(Boolean))) {
      media.push({
        src,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        width: v.videoWidth || null,
        height: v.videoHeight || null
      })
    }
  }
  const metas = {}
  for (const m of document.querySelectorAll('meta[property], meta[name]')) {
    const k = m.getAttribute('property') || m.getAttribute('name')
    if (k && /^(og:|twitter:)/.test(k)) metas[k] = m.getAttribute('content') || ''
  }
  return { url: location.href, title: document.title || '', media, metas }
})()`

const PLAY_SCRIPT = `(() => {
  let n = 0
  for (const v of document.querySelectorAll('video')) {
    try { v.muted = true; const p = v.play(); if (p) p.catch(() => {}); n++ } catch {}
  }
  return n
})()`

const CLICK_PLAY_BUTTONS_SCRIPT = `(() => {
  const sel = [
    'button[aria-label*="play" i]', '[role="button"][aria-label*="play" i]', 'button[title*="play" i]',
    '.vjs-big-play-button', '.jw-icon-display', '.jw-display-icon-container', '.plyr__control--overlaid',
    '.ytp-large-play-button', '.fp-ui', '.mejs__overlay-play', '.bmpui-ui-hugeplaybacktogglebutton',
    '[class*="play-button" i]', '[class*="playButton" i]', '[class*="big-play" i]', '[data-testid*="play" i]',
    'button[aria-label*="riproduci" i]'
  ].join(',')
  let n = 0
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width > 4 && r.height > 4) { try { el.click(); n++ } catch {} }
    if (n >= 3) break
  }
  return n
})()`

/** Centre of the biggest visible video / iframe / player box in the top page. */
const FIND_PLAYER_SCRIPT = `(() => {
  let best = null
  for (const el of document.querySelectorAll('video, iframe, [class*="player" i], [id*="player" i]')) {
    const r = el.getBoundingClientRect()
    const area = r.width * r.height
    if (r.width < 120 || r.height < 80 || r.bottom < 0 || r.right < 0) continue
    if (!best || area > best.area) best = { area, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  return best
})()`

async function inAllFrames<T>(wc: WebContents, script: string): Promise<T[]> {
  const frames = wc.mainFrame?.framesInSubtree ?? []
  const results = await Promise.all(
    frames.map((f) =>
      Promise.race<T | null>([
        (f.executeJavaScript(script) as Promise<T>).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 2000))
      ])
    )
  )
  const out: T[] = []
  for (const r of results) if (r != null) out.push(r as T)
  return out
}

function trustedClick(wc: WebContents, x: number, y: number): void {
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Opens `url` in a hidden (or, in interactive mode, visible) Chromium window,
 * watches every network request like the DevTools Network tab, tries to start
 * playback, and returns the media streams it found, ranked.
 */
export async function sniffPage(opts: SniffOptions): Promise<SniffResult> {
  const log = opts.log ?? (() => undefined)
  const timeoutMs = opts.timeoutMs ?? 25_000
  const win = new BrowserWindow({
    show: !!opts.visible,
    width: 1280,
    height: 800,
    title: 'Grabbit',
    autoHideMenuBar: true,
    webPreferences: {
      session: opts.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      // Offscreen rendering keeps the page "visible" to players that pause when hidden.
      offscreen: !opts.visible
    }
  })
  const wc = win.webContents
  if (opts.visible) {
    // Tell the user what to do, in the window title (the page itself is not ours).
    wc.on('page-title-updated', (e, title) => {
      e.preventDefault()
      win.setTitle(`▶ Avvia il video, poi chiudi questa finestra — ${title}`)
    })
  }
  wc.setAudioMuted(!opts.visible)
  wc.setUserAgent(opts.userAgent)
  if (!opts.visible) wc.setFrameRate(10)

  const hits = new Map<string, RawHit>()
  const enriched = new Map<string, Partial<StreamCandidate>>()
  const variantUrls = new Set<string>()
  const redirects = new Map<string, string>()
  const dom = new Map<string, DomMedia>()
  let pageTitle = ''
  let thumbnail: string | null = null
  let drmDetected = false
  let lastNewHit = Date.now()
  let pageLoaded = false
  let closed = false
  const pending: Promise<void>[] = []

  const build = (): SniffResult => {
    const list: StreamCandidate[] = []
    for (const [url, hit] of hits) {
      if (variantUrls.has(url)) continue
      const e = enriched.get(url) ?? {}
      const d = dom.get(url)
      const base = {
        url,
        kind: hit.classified.kind,
        mime: hit.classified.mime,
        size: e.size ?? hit.classified.size,
        width: e.width ?? d?.width ?? null,
        height: e.height ?? d?.height ?? null,
        duration: e.duration ?? d?.duration ?? null,
        live: e.live ?? false,
        drm: e.drm ?? false,
        ad: looksLikeAd(url),
        referer: hit.referer || opts.url,
        headers: { 'User-Agent': opts.userAgent, ...(hit.requestHeaders['origin'] ? { Origin: hit.requestHeaders['origin'] } : {}) }
      }
      list.push({ ...base, id: url, score: scoreCandidate(base) })
    }
    if (list.some((c) => c.drm)) drmDetected = true
    const { sorted, best, ambiguous } = rankCandidates(list)
    return { pageUrl: opts.url, pageTitle: pageTitle || opts.url, thumbnail, candidates: sorted, best, ambiguous, drmDetected }
  }

  const fetchText = async (url: string, hit: RawHit): Promise<string | null> => {
    try {
      const res = await opts.session.fetch(url, {
        headers: { 'User-Agent': opts.userAgent, ...(hit.referer ? { Referer: hit.referer } : {}) },
        credentials: 'include'
      } as RequestInit)
      if (!res.ok) return null
      const text = await res.text()
      return text.length > 5_000_000 ? null : text
    } catch {
      return null
    }
  }

  const enrich = async (hit: RawHit): Promise<void> => {
    const { kind } = hit.classified
    if (kind === 'hls') {
      const text = await fetchText(hit.url, hit)
      const info = text ? parseHls(text, hit.url) : null
      if (!info) return
      if (info.type === 'master') {
        info.variants.forEach((v) => variantUrls.add(v.url))
        info.audioUrls.forEach((u) => variantUrls.add(u))
        const top = [...info.variants].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
        const e: Partial<StreamCandidate> = { width: top?.width ?? null, height: top?.height ?? null, drm: info.drm }
        if (top) {
          const media = await fetchText(top.url, hit)
          const m = media ? parseHls(media, top.url) : null
          if (m?.type === 'media') Object.assign(e, { duration: m.live ? null : m.duration, live: m.live, drm: info.drm || m.drm })
        }
        enriched.set(hit.url, e)
      } else {
        enriched.set(hit.url, { duration: info.live ? null : info.duration, live: info.live, drm: info.drm })
      }
    } else if (kind === 'dash') {
      const text = await fetchText(hit.url, hit)
      const info = text ? parseDash(text) : null
      if (info) enriched.set(hit.url, { duration: info.duration, live: info.live, width: info.width, height: info.height, drm: info.drm })
    } else if ((kind === 'progressive' || kind === 'audio') && opts.probe) {
      const p = await opts.probe(hit.url, { 'User-Agent': opts.userAgent, ...(hit.referer ? { Referer: hit.referer } : {}) }).catch(() => null)
      if (p) enriched.set(hit.url, p)
    }
  }

  const listener: Listener = {
    onHit(hit) {
      const prev = hits.get(hit.url)
      if (prev) {
        // Keep the largest known size (range requests report the full size).
        if (hit.classified.size && (!prev.classified.size || hit.classified.size > prev.classified.size)) prev.classified.size = hit.classified.size
        return
      }
      hits.set(hit.url, hit)
      lastNewHit = Date.now()
      log(`[sniffer] ${hit.classified.kind} ${hit.url}`)
      const p = enrich(hit).then(() => opts.onUpdate?.(build()))
      pending.push(p)
      opts.onUpdate?.(build())
    },
    onDrm() {
      drmDetected = true
    },
    onRedirect(from, to) {
      redirects.set(from, to)
    }
  }
  /** Follows recorded redirects (e.g. <video src> → CDN URL). */
  const finalUrl = (url: string): string => {
    for (let i = 0; i < 10 && redirects.has(url); i++) url = redirects.get(url)!
    return url
  }

  const routes = tapFor(opts.session)
  routes.set(wc.id, listener)

  // Never leave the page: block popups and top-level navigations started by ads after load.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, navUrl) => {
    if (!pageLoaded || opts.visible) return
    try {
      if (new URL(navUrl).origin !== new URL(wc.getURL()).origin) e.preventDefault()
    } catch {
      e.preventDefault()
    }
  })
  win.on('closed', () => {
    closed = true
  })

  const readDom = async (): Promise<void> => {
    if (closed) return
    const infos = await inAllFrames<DomInfo>(wc, COLLECT_SCRIPT)
    for (const info of infos) {
      for (const m of info.media) {
        if (!/^https?:/.test(m.src)) continue
        const url = finalUrl(m.src)
        dom.set(url, m)
        // Elements with a real URL are media even if the network tap missed them (cache).
        if (!hits.has(url)) {
          const kind = classifyResponse({ url, method: 'GET', statusCode: 200, headers: {}, resourceType: 'media' })
          if (kind) listener.onHit({ url, method: 'GET', classified: kind, referer: info.url, requestHeaders: {} })
        }
      }
    }
    const top = infos[0]
    if (top) {
      pageTitle = cleanTitle(top.metas['og:title'] || top.metas['twitter:title'] || top.title || pageTitle)
      thumbnail = top.metas['og:image'] || top.metas['twitter:image'] || thumbnail
    }
  }

  const finish = async (): Promise<SniffResult> => {
    if (!closed) await readDom().catch(() => undefined)
    await Promise.race([Promise.allSettled(pending), sleep(8000)])
    routes.delete(wc.id)
    if (!closed) win.destroy()
    return build()
  }

  try {
    const started = Date.now()
    const deadline = started + timeoutMs
    const loaded = wc.loadURL(opts.url, { userAgent: opts.userAgent }).then(
      () => undefined,
      (err: Error) => log(`[sniffer] load: ${err.message}`)
    )
    await Promise.race([loaded, sleep(Math.min(timeoutMs, 30_000), opts.signal)])
    pageLoaded = true

    if (opts.visible) {
      // Interactive: the user drives the page; keep reading the DOM until the window closes.
      while (!closed && !opts.signal?.aborted) {
        await readDom().catch(() => undefined)
        opts.onUpdate?.(build())
        await sleep(1500, opts.signal)
      }
      return await finish()
    }

    // Automatic: escalate from autoplay to clicks, stop once things settle.
    const steps: (() => Promise<unknown>)[] = [
      () => inAllFrames(wc, PLAY_SCRIPT),
      () => inAllFrames(wc, CLICK_PLAY_BUTTONS_SCRIPT),
      async () => {
        const target = (await wc.executeJavaScript(FIND_PLAYER_SCRIPT).catch(() => null)) as { x: number; y: number } | null
        if (target) trustedClick(wc, target.x, target.y)
      },
      () => inAllFrames(wc, PLAY_SCRIPT)
    ]
    await sleep(1500, opts.signal)
    for (const step of steps) {
      if (closed || opts.signal?.aborted || Date.now() > deadline) break
      await readDom().catch(() => undefined)
      const current = build()
      const plausible = current.candidates.some((c) => !c.ad && !c.drm && c.kind !== 'audio')
      // Clicking around does not help with DRM-protected content.
      if (plausible || current.drmDetected) break
      await step().catch(() => undefined)
      await sleep(2500, opts.signal)
    }
    // Wait for the network to settle (no new media for 3 s) or the deadline.
    // With nothing found after every attempt, give late players 3 more seconds and stop.
    const giveUpAt = Math.min(deadline, Date.now() + 3000)
    while (!closed && !opts.signal?.aborted && Date.now() < (hits.size ? deadline : giveUpAt)) {
      if (hits.size && Date.now() - lastNewHit > 3000) break
      await sleep(500, opts.signal)
    }
    return await finish()
  } catch (err) {
    routes.delete(wc.id)
    if (!closed) win.destroy()
    throw err
  }
}

/** Chrome-like user agent without the "Electron/x" and app tokens some sites block. */
export function browserUserAgent(fallback: string): string {
  return fallback.replace(/\s(Electron|Grabbit|grabbit)\/\S+/g, '')
}
