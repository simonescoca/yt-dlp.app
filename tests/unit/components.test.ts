import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ComponentManager } from '../../src/main/engine/components'
import type { Http } from '../../src/main/engine/http'

const isLinux = process.platform === 'linux'

type Route = { redirect: string } | { text: string } | { file: string } | { status: number }

/** An in-memory fake of the network used by the component manager. */
function fakeHttp(routes: Map<string, Route>): Http & { calls: string[] } {
  const calls: string[] = []
  const lookup = (url: string): Route => {
    calls.push(url)
    return routes.get(url) ?? { status: 404 }
  }
  const fetchFn = async (url: string): Promise<Response> => {
    const r = lookup(url)
    if ('status' in r) return new Response('nope', { status: r.status })
    if ('text' in r) return new Response(r.text)
    if ('file' in r) {
      const buf = readFileSync(r.file)
      return new Response(buf, { headers: { 'content-length': String(buf.length) } })
    }
    return new Response(null, { status: 302, headers: { location: r.redirect } })
  }
  return {
    calls,
    fetch: (url) => fetchFn(String(url)),
    async getText(url) {
      const res = await fetchFn(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    },
    async resolveRedirect(url) {
      const r = lookup(url)
      if ('status' in r) throw new Error(`HTTP ${r.status}`)
      return 'redirect' in r ? r.redirect : null
    }
  }
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

function script(path: string, output: string): void {
  writeFileSync(path, `#!/bin/sh\necho "${output}"\n`)
  chmodSync(path, 0o755)
}

/** Builds fake upstream releases (real zip / tar.xz archives holding shell scripts). */
function buildUpstream(root: string, ytdlpTag: string) {
  const work = join(root, `src-${ytdlpTag}`)
  mkdirSync(join(work, 'ytdlp', '_internal'), { recursive: true })
  script(join(work, 'ytdlp', 'yt-dlp_linux'), ytdlpTag)
  writeFileSync(join(work, 'ytdlp', '_internal', 'lib.txt'), 'x')
  const ytZip = join(root, `yt-dlp_linux-${ytdlpTag}.zip`)
  execFileSync('zip', ['-qr', ytZip, '.'], { cwd: join(work, 'ytdlp') })

  mkdirSync(join(work, 'deno'), { recursive: true })
  script(join(work, 'deno', 'deno'), 'deno 2.9.7 (stable, release, x86_64-unknown-linux-gnu)')
  const denoZip = join(root, 'deno.zip')
  execFileSync('zip', ['-qr', denoZip, '.'], { cwd: join(work, 'deno') })

  const ffRoot = join(work, 'ff', 'ffmpeg-master-latest-linux64-gpl', 'bin')
  mkdirSync(ffRoot, { recursive: true })
  script(join(ffRoot, 'ffmpeg'), 'ffmpeg version N-126899-gd975849594-20260930 Copyright')
  script(join(ffRoot, 'ffprobe'), 'ffprobe version N-126899')
  const ffTar = join(root, 'ffmpeg.tar.xz')
  execFileSync('tar', ['-cJf', ffTar, '-C', join(work, 'ff'), 'ffmpeg-master-latest-linux64-gpl'])
  return { ytZip, denoZip, ffTar }
}

function routesFor(up: ReturnType<typeof buildUpstream>, ytdlpTag: string): Map<string, Route> {
  const gh = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases'
  const deno = 'https://dl.deno.land/release/v2.9.7/deno-x86_64-unknown-linux-gnu.zip'
  const ff = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest'
  return new Map<string, Route>([
    [`${gh}/latest/download/SHA2-256SUMS`, { redirect: `${gh}/download/${ytdlpTag}/SHA2-256SUMS` }],
    [`${gh}/download/${ytdlpTag}/SHA2-256SUMS`, { text: `${sha(up.ytZip)}  yt-dlp_linux.zip\n` }],
    [`${gh}/download/${ytdlpTag}/yt-dlp_linux.zip`, { file: up.ytZip }],
    ['https://dl.deno.land/release-latest.txt', { text: 'v2.9.7\n' }],
    [deno, { file: up.denoZip }],
    [`${deno}.sha256sum`, { text: `${sha(up.denoZip)}  deno-x86_64-unknown-linux-gnu.zip` }],
    [`${ff}/checksums.sha256`, { text: `${sha(up.ffTar)}  ffmpeg-master-latest-linux64-gpl.tar.xz\n` }],
    [`${ff}/ffmpeg-master-latest-linux64-gpl.tar.xz`, { file: up.ffTar }]
  ])
}

describe.runIf(isLinux)('ComponentManager', () => {
  let root: string
  let binDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grabbit-components-'))
    binDir = join(root, 'bin')
  })

  const manager = (http: Http) =>
    new ComponentManager({ binDir, target: 'linux-x64', http, channel: () => 'nightly' })

  it('installs every missing component and reports versions', async () => {
    const up = buildUpstream(root, '2026.09.27.232945')
    const m = manager(fakeHttp(routesFor(up, '2026.09.27.232945')))
    await m.init()
    expect(m.isReady()).toBe(false)
    expect(m.getStates().map((s) => s.phase)).toEqual(['missing', 'missing', 'missing'])

    const phases = new Set<string>()
    m.on('change', (states) => states.forEach((s) => phases.add(s.phase)))
    await m.ensureInstalled()

    expect(m.isReady()).toBe(true)
    expect(phases).toContain('downloading')
    expect(phases).toContain('installing')
    const states = Object.fromEntries(m.getStates().map((s) => [s.id, s]))
    expect(states['yt-dlp']!.version).toBe('2026.09.27.232945')
    expect(states['deno']!.version).toBe('v2.9.7')
    expect(states['ffmpeg']!.version).toBe('N-126899-gd975849594-20260930')

    const paths = m.getPaths()
    expect(execFileSync(paths.ytdlp).toString().trim()).toBe('2026.09.27.232945')
    expect(existsSync(join(paths.ffmpegDir, 'ffprobe'))).toBe(true)
    expect(readdirSync(binDir).sort()).toEqual(['deno', 'ffmpeg', 'manifest.json', 'yt-dlp'])
  })

  it('keeps the installed version when nothing changed, updates when a new release appears', async () => {
    const up1 = buildUpstream(root, '2026.09.27.232945')
    const http1 = fakeHttp(routesFor(up1, '2026.09.27.232945'))
    const m1 = manager(http1)
    await m1.init()
    await m1.ensureInstalled()
    const firstPath = m1.getPaths().ytdlp

    // A new app start sees the installed components and does not download again.
    const http2 = fakeHttp(routesFor(up1, '2026.09.27.232945'))
    const m2 = manager(http2)
    await m2.init()
    expect(m2.isReady()).toBe(true)
    await m2.checkForUpdates(['yt-dlp'])
    expect(http2.calls.some((u) => u.endsWith('.zip'))).toBe(false)

    // A newer nightly is published: it gets installed in a new folder, the old one is removed.
    const up2 = buildUpstream(root, '2026.09.30.010203')
    const m3 = manager(fakeHttp(routesFor(up2, '2026.09.30.010203')))
    await m3.init()
    await m3.checkForUpdates(['yt-dlp'])
    const newPath = m3.getPaths().ytdlp
    expect(newPath).not.toBe(firstPath)
    expect(execFileSync(newPath).toString().trim()).toBe('2026.09.30.010203')
    expect(existsSync(firstPath)).toBe(false)
  })

  it('skips checks done recently (maxAge)', async () => {
    const up = buildUpstream(root, '2026.09.27.232945')
    const http = fakeHttp(routesFor(up, '2026.09.27.232945'))
    const m = manager(http)
    await m.init()
    await m.ensureInstalled()
    const before = http.calls.length
    await m.checkForUpdates(['yt-dlp'], 60 * 60 * 1000)
    expect(http.calls.length).toBe(before)
  })

  it('rejects archives whose checksum does not match', async () => {
    const up = buildUpstream(root, '2026.09.27.232945')
    const routes = routesFor(up, '2026.09.27.232945')
    routes.set('https://dl.deno.land/release/v2.9.7/deno-x86_64-unknown-linux-gnu.zip.sha256sum', {
      text: `${'0'.repeat(64)}  deno-x86_64-unknown-linux-gnu.zip`
    })
    const m = manager(fakeHttp(routes))
    await m.init()
    await expect(m.ensureInstalled()).rejects.toThrow(/Checksum non valido/)
    const deno = m.getStates().find((s) => s.id === 'deno')!
    expect(deno.phase).toBe('error')
    expect(existsSync(join(binDir, 'deno'))).toBe(true)
    expect(readdirSync(join(binDir, 'deno'))).toEqual([])
  })

  it('keeps working offline when a version is already installed', async () => {
    const up = buildUpstream(root, '2026.09.27.232945')
    const m1 = manager(fakeHttp(routesFor(up, '2026.09.27.232945')))
    await m1.init()
    await m1.ensureInstalled()

    const offline = manager(fakeHttp(new Map()))
    await offline.init()
    await expect(offline.checkForUpdates()).resolves.toBeUndefined()
    const y = offline.getStates().find((s) => s.id === 'yt-dlp')!
    expect(y.phase).toBe('ready')
    expect(y.error).toMatch(/404/)
  })
})
