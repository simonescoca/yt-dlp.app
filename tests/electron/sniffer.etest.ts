import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, session as electronSession, type Session } from 'electron'
import { exportSessionCookies } from '../../src/main/browser/cookies'
import { ffprobeProber } from '../../src/main/sniffer/probe'
import { browserUserAgent, sniffPage } from '../../src/main/sniffer/sniffer'
import { download } from '../../src/main/ytdlp/download'
import { ensureMedia, MEDIA_DIR } from '../fixtures/media'
import { startFixtureServer, type FixtureServer } from '../fixtures/server'
import { devEnginePaths, ffprobe } from '../integration/env'
import { after, before, run, test } from './harness'

const ROOT = resolve(__dirname, '../..')
const PAGES = join(ROOT, 'tests/fixtures/pages')
const HLSJS = join(ROOT, 'node_modules/hls.js/dist')
const paths = devEnginePaths()
let a: FixtureServer
let b: FixtureServer
let ses: Session
let ua: string

const sniff = (path: string, extra: Partial<Parameters<typeof sniffPage>[0]> = {}) =>
  sniffPage({
    url: a.origin + path,
    session: ses,
    userAgent: ua,
    timeoutMs: 20_000,
    probe: ffprobeProber(join(paths.ffmpegDir, 'ffprobe')),
    ...extra
  })

before(async () => {
  ensureMedia(join(paths.ffmpegDir, 'ffmpeg'))
  b = await startFixtureServer([PAGES, MEDIA_DIR, HLSJS], undefined, 'localhost')
  a = await startFixtureServer([PAGES, MEDIA_DIR, HLSJS], (req, res) => {
    if (req.url !== '/iframe.html') return false
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(readFileSync(join(PAGES, 'iframe.html'), 'utf8').replace('__OTHER_ORIGIN__', b.origin))
    return true
  })
  ses = electronSession.fromPartition(`sniff-test-${Date.now()}`)
  ua = browserUserAgent(app.userAgentFallback)
})

after(async () => {
  await a?.close()
  await b?.close()
})

test('user agent looks like plain Chrome', () => {
  assert.match(ua, /Chrome\/\d+/)
  assert.doesNotMatch(ua, /Electron|Grabbit/i)
})

test('mp4 page: finds the main video (even if the player waits for visibility), flags the ad', async () => {
  const r = await sniff('/mp4.html')
  assert.equal(r.pageTitle, 'Il mio video di prova')
  assert.ok(r.best, 'no best candidate')
  assert.equal(r.best.url, `${a.origin}/video.mp4`)
  assert.equal(r.best.kind, 'progressive')
  assert.equal(r.best.height, 720)
  assert.ok(Math.abs((r.best.duration ?? 0) - 8) < 0.5)
  const ad = r.candidates.find((c) => c.url.includes('/ads/preroll.mp4'))
  assert.ok(ad?.ad, 'ad not flagged')
  assert.equal(r.ambiguous, false)
})

test('hls.js page (MSE, blob: src): finds the master playlist, hides its variants', async () => {
  const r = await sniff('/hls.html')
  assert.ok(r.best)
  assert.equal(r.best.url, `${a.origin}/hls/master.m3u8`)
  assert.equal(r.best.kind, 'hls')
  assert.equal(r.best.height, 720)
  assert.ok(Math.abs((r.best.duration ?? 0) - 8) < 0.5)
  assert.ok(!r.candidates.some((c) => c.url.endsWith('/low.m3u8') || c.url.endsWith('/high.m3u8')), 'variants not merged')
})

test('custom player fetching a DASH manifest', async () => {
  const r = await sniff('/dash.html')
  assert.equal(r.best?.kind, 'dash')
  assert.equal(r.best?.height, 480)
  assert.equal(r.candidates.length, 1, 'segments must not be listed')
})

test('video inside a cross-origin iframe', async () => {
  const r = await sniff('/iframe.html')
  assert.ok(r.best, JSON.stringify(r.candidates))
  assert.equal(r.best.url, `${b.origin}/video.mp4`)
  assert.equal(r.best.referer, `${b.origin}/mp4.html`)
})

test('player that only starts on a trusted click', async () => {
  const r = await sniff('/click.html')
  assert.ok(r.best, 'click did not start the player')
  assert.equal(r.best.url, `${a.origin}/long.mp4?clicked=1`)
  assert.ok(Math.abs((r.best.duration ?? 0) - 45) < 1)
})

test('two different long videos: ambiguous, both listed', async () => {
  const r = await sniff('/two.html')
  const urls = r.candidates.map((c) => c.url).sort()
  assert.deepEqual(urls, [`${a.origin}/long.mp4`, `${a.origin}/long2.mp4`])
  assert.equal(r.ambiguous, true)
})

test('DRM-protected stream: detected, never chosen', async () => {
  const r = await sniff('/drm.html')
  assert.equal(r.drmDetected, true)
  assert.equal(r.best, null)
})

test('page without media ends cleanly with no candidates', async () => {
  const started = Date.now()
  const r = await sniff('/nothing.html', { timeoutMs: 12_000 })
  assert.equal(r.candidates.length, 0)
  assert.equal(r.best, null)
  assert.ok(Date.now() - started < 16_000)
})

test('cancel stops the scan quickly', async () => {
  const ac = new AbortController()
  const started = Date.now()
  setTimeout(() => ac.abort(), 1500)
  await sniff('/nothing.html', { timeoutMs: 30_000, signal: ac.signal })
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`)
})

test('cookie + Referer protected stream: sniffed and downloaded by yt-dlp with exported cookies', async () => {
  const r = await sniff('/protected.html')
  assert.ok(r.best, 'protected video not found')
  assert.equal(r.best.url, `${a.origin}/protected/video.mp4`)
  const dir = mkdtempSync(join(tmpdir(), 'grabbit-sniff-dl-'))
  const cookiesFile = join(dir, 'cookies.txt')
  assert.equal(await exportSessionCookies(ses, cookiesFile), true)
  const file = await download(
    {
      url: r.best.url,
      options: { mode: 'video', videoFormat: 'mp4', audioFormat: 'mp3', folder: dir, embedMetadata: true, embedThumbnail: false, preferCompatible: false },
      outputDir: dir,
      fileBase: 'protected',
      tempDir: join(dir, 'tmp'),
      headers: { Referer: r.best.referer, ...r.best.headers }
    },
    { paths, cookiesFile }
  )
  const p = ffprobe(paths, file)
  assert.ok(p.streams.some((s) => s.codec_type === 'video' && s.height === 720))
  const req = a.requests.filter((x) => x.url === '/protected/video.mp4').at(-1)!
  assert.match(String(req.headers['user-agent']), /Chrome/)
  assert.doesNotMatch(String(req.headers['user-agent']), /yt-dlp|Electron/)
})

run()
