import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'

/**
 * Minimal HTTP surface used by the engine. The Electron implementation goes
 * through Chromium's network stack (system proxy settings and certificates);
 * the Node one is used by unit tests and scripts.
 */
export interface Http {
  getText(url: string, signal?: AbortSignal): Promise<string>
  /** Returns the target of the first redirect of `url` (absolute), or null when it does not redirect. */
  resolveRedirect(url: string): Promise<string | null>
  fetch(url: string, init?: RequestInit): Promise<Response>
}

export interface DownloadProgress {
  received: number
  total: number | null
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number
  ) {
    super(`HTTP ${status} per ${url}`)
  }
}

const USER_AGENT = 'Grabbit (+https://github.com/simonescoca/yt-dlp.app)'

async function getTextWith(fetchFn: Http['fetch'], url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchFn(url, { signal, headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new HttpError(url, res.status)
  return res.text()
}

/** Streams `url` to `dest`, returning the SHA-256 of the downloaded bytes. Removes partial files on failure. */
export async function downloadFile(
  http: Http,
  url: string,
  dest: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const res = await http.fetch(url, { signal, headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok || !res.body) throw new HttpError(url, res.status)
  const lengthHeader = res.headers.get('content-length')
  const total = lengthHeader ? Number(lengthHeader) || null : null
  const hash = createHash('sha256')
  const out = createWriteStream(dest)
  let received = 0
  let lastEmit = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.byteLength
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      const now = Date.now()
      if (onProgress && now - lastEmit > 150) {
        lastEmit = now
        onProgress({ received, total })
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    onProgress?.({ received, total })
    return hash.digest('hex')
  } catch (err) {
    out.destroy()
    await rm(dest, { force: true })
    throw err
  }
}

/** Node implementation (global fetch / undici). Proxies need NODE_USE_ENV_PROXY=1. */
export function createNodeHttp(): Http {
  const fetchFn: Http['fetch'] = (url, init) => fetch(url, init)
  return {
    fetch: fetchFn,
    getText: (url, signal) => getTextWith(fetchFn, url, signal),
    async resolveRedirect(url) {
      // GET, not HEAD: some servers (ffmpeg.martin-riedl.de) answer 404 to HEAD. The body is never read.
      const ac = new AbortController()
      const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT }, signal: ac.signal })
      ac.abort()
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) return new URL(loc, url).toString()
      if (res.status >= 400) throw new HttpError(url, res.status)
      return null
    }
  }
}

/** Electron implementation, through the main process `net` module (Chromium network stack). */
export function createElectronHttp(net: typeof import('electron').net): Http {
  const fetchFn: Http['fetch'] = (url, init) => net.fetch(url, init as RequestInit)
  return {
    fetch: fetchFn,
    getText: (url, signal) => getTextWith(fetchFn, url, signal),
    resolveRedirect(url) {
      // net.fetch rejects manual redirects, so use the lower level request API.
      return new Promise((resolve, reject) => {
        // GET, not HEAD: some servers (ffmpeg.martin-riedl.de) answer 404 to HEAD. Aborted at the redirect.
        const req = net.request({ url, method: 'GET', redirect: 'manual' })
        req.setHeader('User-Agent', USER_AGENT)
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          req.abort()
          reject(new Error(`Timeout durante la richiesta a ${url}`))
        }, 30_000)
        req.on('redirect', (_status, _method, redirectUrl) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          req.abort()
          resolve(new URL(redirectUrl, url).toString())
        })
        req.on('response', (res) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          req.abort()
          if (res.statusCode >= 400) reject(new HttpError(url, res.statusCode))
          else resolve(null)
        })
        req.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        })
        req.end()
      })
    }
  }
}
