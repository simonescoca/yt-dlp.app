import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ComponentState } from '@shared/types'
import { extractArchive } from './archive'
import { downloadFile, type Http } from './http'
import {
  COMPONENT_IDS,
  DENO_LATEST_URL,
  denoAssetUrl,
  exeSuffix,
  ffmpegSource,
  findChecksum,
  riedlRevisionFromUrl,
  riedlVersion,
  tagFromReleaseUrl,
  ytdlpAsset,
  ytdlpLatestProbeUrl,
  ytdlpReleaseFileUrl,
  type ComponentId,
  type Target,
  type YtdlpChannel
} from './sources'

const execFileAsync = promisify(execFile)

interface InstalledComponent {
  /** Human readable version, e.g. "2026.09.27.232945", "v2.9.7", "9.0.2". */
  version: string
  /** Identity used to decide whether an update is available. */
  revision: string
  /** Folder name inside `<binDir>/<id>/`. */
  folder: string
  installedAt: number
}

interface Manifest {
  components: Partial<Record<ComponentId, InstalledComponent>>
  lastCheck: Partial<Record<ComponentId, number>>
}

interface Archive {
  url: string
  sha256: string
  kind: 'zip' | 'tar.xz'
}

/** What the newest upstream release looks like, and how to install it. */
interface LatestRelease {
  version: string
  revision: string
  archives: Archive[]
  /** Moves the binaries from the extracted archives into the final folder. */
  arrange: (staging: string, final: string) => Promise<void>
}

export interface EnginePaths {
  ytdlp: string
  deno: string
  ffmpegDir: string
}

export interface ComponentManagerOptions {
  binDir: string
  target: Target
  http: Http
  channel: () => YtdlpChannel
  log?: (msg: string) => void
}

const RUN_TIMEOUT_MS = 120_000

/**
 * Installs and keeps up to date the external programs the app relies on.
 * Each version lives in its own folder so an update never touches the files
 * of a yt-dlp process that is still running; old folders are removed later.
 */
export class ComponentManager extends EventEmitter<{ change: [ComponentState[]] }> {
  private manifest: Manifest = { components: {}, lastCheck: {} }
  private readonly states = new Map<ComponentId, ComponentState>()
  private readonly running = new Map<ComponentId, Promise<void>>()
  private manifestWrite: Promise<void> = Promise.resolve()
  private readonly log: (msg: string) => void

  constructor(private readonly opts: ComponentManagerOptions) {
    super()
    this.log = opts.log ?? (() => undefined)
    for (const id of COMPONENT_IDS) {
      this.states.set(id, {
        id,
        phase: 'missing',
        version: null,
        latestVersion: null,
        progress: null,
        error: null,
        lastCheck: null
      })
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    await mkdir(this.opts.binDir, { recursive: true })
    try {
      const raw = await readFile(this.manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Manifest>
      this.manifest = { components: parsed.components ?? {}, lastCheck: parsed.lastCheck ?? {} }
    } catch {
      this.manifest = { components: {}, lastCheck: {} }
    }
    for (const id of COMPONENT_IDS) {
      const inst = this.manifest.components[id]
      const present = inst ? await exists(this.executablePath(id, inst)) : false
      if (inst && !present) delete this.manifest.components[id]
      this.patch(id, {
        phase: present ? 'ready' : 'missing',
        version: present ? inst!.version : null,
        lastCheck: this.manifest.lastCheck[id] ?? null
      })
    }
    await this.cleanupStaleFolders()
  }

  getStates(): ComponentState[] {
    return COMPONENT_IDS.map((id) => ({ ...this.states.get(id)! }))
  }

  isReady(): boolean {
    return COMPONENT_IDS.every((id) => this.manifest.components[id])
  }

  /** Absolute paths of the installed binaries. Throws when something is missing. */
  getPaths(): EnginePaths {
    const y = this.manifest.components['yt-dlp']
    const d = this.manifest.components.deno
    const f = this.manifest.components.ffmpeg
    if (!y || !d || !f) throw new Error('Il motore non è ancora installato')
    return {
      ytdlp: this.executablePath('yt-dlp', y),
      deno: this.executablePath('deno', d),
      ffmpegDir: join(this.opts.binDir, 'ffmpeg', f.folder)
    }
  }

  /** Installs every missing component (in parallel). Rejects if any of them fails. */
  async ensureInstalled(): Promise<void> {
    const missing = COMPONENT_IDS.filter((id) => !this.manifest.components[id])
    const results = await Promise.allSettled(missing.map((id) => this.update(id)))
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) throw (failed as PromiseRejectedResult).reason
  }

  /**
   * Checks for (and installs) updates of the given components whose last check
   * is older than `maxAgeMs`. Failures of the check itself (e.g. offline) do not
   * reject when an older version is installed: the app keeps working with it.
   */
  async checkForUpdates(ids: readonly ComponentId[] = COMPONENT_IDS, maxAgeMs = 0): Promise<void> {
    const now = Date.now()
    const due = ids.filter((id) => now - (this.manifest.lastCheck[id] ?? 0) >= maxAgeMs)
    await Promise.all(
      due.map(async (id) => {
        try {
          await this.update(id)
        } catch (err) {
          if (!this.manifest.components[id]) throw err
          this.log(`[${id}] controllo aggiornamenti fallito: ${errorMessage(err)}`)
        }
      })
    )
  }

  /** Waits for any install/update of `id` currently in progress. */
  async whenIdle(id: ComponentId): Promise<void> {
    await this.running.get(id)?.catch(() => undefined)
  }

  /** Checks the latest release of `id` and installs it if it differs from the installed one. */
  update(id: ComponentId, force = false): Promise<void> {
    const current = this.running.get(id)
    if (current) return current
    const p = this.doUpdate(id, force).finally(() => this.running.delete(id))
    this.running.set(id, p)
    return p
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private get manifestPath(): string {
    return join(this.opts.binDir, 'manifest.json')
  }

  private executablePath(id: ComponentId, inst: InstalledComponent): string {
    const dir = join(this.opts.binDir, id, inst.folder)
    const sfx = exeSuffix(this.opts.target)
    switch (id) {
      case 'yt-dlp':
        return join(dir, ytdlpAsset(this.opts.target).exe)
      case 'deno':
        return join(dir, `deno${sfx}`)
      case 'ffmpeg':
        return join(dir, `ffmpeg${sfx}`)
    }
  }

  private patch(id: ComponentId, partial: Partial<ComponentState>): void {
    this.states.set(id, { ...this.states.get(id)!, ...partial })
    this.emit('change', this.getStates())
  }

  private async doUpdate(id: ComponentId, force: boolean): Promise<void> {
    const installed = this.manifest.components[id]
    this.patch(id, { phase: 'checking', error: null, progress: null })
    try {
      const latest = await this.resolveLatest(id)
      this.manifest.lastCheck[id] = Date.now()
      this.patch(id, { latestVersion: latest.version, lastCheck: this.manifest.lastCheck[id]! })
      if (!force && installed && installed.revision === latest.revision) {
        await this.saveManifest()
        this.patch(id, { phase: 'ready' })
        return
      }
      this.log(`[${id}] installazione ${latest.version} (era ${installed?.version ?? 'assente'})`)
      await this.install(id, latest)
    } catch (err) {
      // With an older version installed the app keeps working: the error is only informative.
      this.patch(id, { phase: installed ? 'ready' : 'error', error: errorMessage(err), progress: null })
      throw err
    }
  }

  private async resolveLatest(id: ComponentId): Promise<LatestRelease> {
    const { http, target } = this.opts
    switch (id) {
      case 'yt-dlp': {
        const channel = this.opts.channel()
        const redirect = await http.resolveRedirect(ytdlpLatestProbeUrl(channel))
        const tag = redirect ? tagFromReleaseUrl(redirect) : null
        if (!tag) throw new Error('Impossibile determinare l’ultima versione di yt-dlp')
        const { asset, exe } = ytdlpAsset(target)
        const sums = await http.getText(ytdlpReleaseFileUrl(channel, tag, 'SHA2-256SUMS'))
        const sha256 = findChecksum(sums, asset)
        if (!sha256) throw new Error(`Checksum di ${asset} non trovato`)
        return {
          version: tag,
          revision: `${channel}:${tag}`,
          archives: [{ url: ytdlpReleaseFileUrl(channel, tag, asset), sha256, kind: 'zip' }],
          arrange: async (staging, final) => {
            await rename(staging, final)
            await chmod(join(final, exe), 0o755)
          }
        }
      }
      case 'deno': {
        const version = (await http.getText(DENO_LATEST_URL)).trim()
        if (!/^v\d+\.\d+\.\d+/.test(version)) throw new Error(`Versione di Deno non valida: ${version}`)
        const url = denoAssetUrl(target, version)
        const sha256 = findChecksum(await http.getText(`${url}.sha256sum`), url.split('/').pop()!)
        if (!sha256) throw new Error('Checksum di Deno non trovato')
        return {
          version,
          revision: version,
          archives: [{ url, sha256, kind: 'zip' }],
          arrange: async (staging, final) => {
            await rename(staging, final)
            await chmod(join(final, `deno${exeSuffix(target)}`), 0o755)
          }
        }
      }
      case 'ffmpeg': {
        const src = ffmpegSource(target)
        const sfx = exeSuffix(target)
        if (src.provider === 'martin-riedl') {
          const redirect = await http.resolveRedirect(src.latestProbeUrl)
          const revision = redirect ? riedlRevisionFromUrl(redirect) : null
          if (!revision) throw new Error('Impossibile determinare l’ultima versione di ffmpeg')
          const archives: Archive[] = []
          for (const a of src.archives(revision)) {
            const sha256 = findChecksum(await http.getText(a.checksumUrl), a.checksumName)
            if (!sha256) throw new Error(`Checksum di ${a.checksumName} non trovato`)
            archives.push({ url: a.url, sha256, kind: a.kind })
          }
          return {
            version: riedlVersion(revision),
            revision,
            archives,
            arrange: async (staging, final) => {
              await rename(staging, final)
              for (const bin of ['ffmpeg', 'ffprobe']) await chmod(join(final, bin + sfx), 0o755)
            }
          }
        }
        const sha256 = findChecksum(await http.getText(src.archive.checksumUrl), src.archive.checksumName)
        if (!sha256) throw new Error('Checksum di ffmpeg non trovato')
        return {
          // The real version string is read from `ffmpeg -version` after install.
          version: `build ${sha256.slice(0, 8)}`,
          revision: sha256,
          archives: [{ url: src.archive.url, sha256, kind: src.archive.kind }],
          arrange: async (staging, final) => {
            await mkdir(final, { recursive: true })
            for (const bin of ['ffmpeg', 'ffprobe']) {
              await rename(join(staging, src.binSubdir, bin + sfx), join(final, bin + sfx))
              await chmod(join(final, bin + sfx), 0o755)
            }
            await rm(staging, { recursive: true, force: true })
          }
        }
      }
    }
  }

  private async install(id: ComponentId, latest: LatestRelease): Promise<void> {
    const { binDir } = this.opts
    const tmpDir = join(binDir, '.tmp', `${id}-${Date.now()}`)
    const folder = safeFolderName(latest.revision)
    const finalDir = join(binDir, id, folder)
    const staging = join(tmpDir, 'staging')
    await mkdir(tmpDir, { recursive: true })
    await mkdir(join(binDir, id), { recursive: true })
    try {
      // 1. Download + verify every archive (progress is spread across them).
      this.patch(id, { phase: 'downloading', progress: 0 })
      const files: string[] = []
      for (const [i, a] of latest.archives.entries()) {
        const file = join(tmpDir, `archive-${i}.${a.kind}`)
        const hash = await downloadFile(this.opts.http, a.url, file, ({ received, total }) => {
          const part = total ? received / total : 0
          this.patch(id, { progress: (i + part) / latest.archives.length })
        })
        if (hash !== a.sha256) throw new Error(`Checksum non valido per ${a.url} (atteso ${a.sha256}, ottenuto ${hash})`)
        files.push(file)
      }
      // 2. Extract and move into place.
      this.patch(id, { phase: 'installing', progress: null })
      for (const [i, file] of files.entries()) await extractArchive(file, staging, latest.archives[i]!.kind)
      await rm(finalDir, { recursive: true, force: true })
      await latest.arrange(staging, finalDir)
      const inst: InstalledComponent = { version: latest.version, revision: latest.revision, folder, installedAt: Date.now() }
      // 3. Make sure the binary actually runs on this machine.
      inst.version = await this.verify(id, inst)
      const previous = this.manifest.components[id]
      this.manifest.components[id] = inst
      await this.saveManifest()
      this.patch(id, { phase: 'ready', version: inst.version, progress: null, error: null })
      if (previous && previous.folder !== folder) {
        await rm(join(binDir, id, previous.folder), { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (err) {
      await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      // Only succeeds once no other install is using the folder.
      await rmdir(join(binDir, '.tmp')).catch(() => undefined)
    }
  }

  /** Runs the freshly installed binary; returns the version string to display. */
  private async verify(id: ComponentId, inst: InstalledComponent): Promise<string> {
    const exe = this.executablePath(id, inst)
    if (process.platform === 'darwin') await prepareMacBinaries(join(this.opts.binDir, id, inst.folder))
    const args = id === 'ffmpeg' ? ['-hide_banner', '-version'] : ['--version']
    const run = () => execFileAsync(exe, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true })
    let stdout: string
    try {
      ;({ stdout } = await run())
    } catch (err) {
      // Apple Silicon kills binaries without a valid signature: sign ad-hoc and retry once.
      if (process.platform !== 'darwin') throw err
      await adhocSignTree(join(this.opts.binDir, id, inst.folder))
      ;({ stdout } = await run())
    }
    const first = stdout.split(/\r?\n/)[0]?.trim() ?? ''
    if (id === 'yt-dlp') return first || inst.version
    if (id === 'deno') return /deno (\S+)/.exec(first)?.[1] ? `v${/deno (\S+)/.exec(first)![1]}` : inst.version
    return /ffmpeg version (\S+)/.exec(first)?.[1] ?? inst.version
  }

  /** Writes the manifest atomically; writes are serialized because installs run in parallel. */
  private saveManifest(): Promise<void> {
    const write = async (): Promise<void> => {
      const tmp = `${this.manifestPath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(this.manifest, null, 2))
      await rename(tmp, this.manifestPath)
    }
    this.manifestWrite = this.manifestWrite.then(write, write)
    return this.manifestWrite
  }

  /** Removes folders of versions that are no longer in use (left behind when a delete failed). */
  private async cleanupStaleFolders(): Promise<void> {
    await rm(join(this.opts.binDir, '.tmp'), { recursive: true, force: true }).catch(() => undefined)
    for (const id of COMPONENT_IDS) {
      const current = this.manifest.components[id]?.folder
      const entries = await readdir(join(this.opts.binDir, id)).catch(() => [] as string[])
      for (const name of entries) {
        if (name !== current) await rm(join(this.opts.binDir, id, name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

/**
 * Ad-hoc signs every executable / library in `dir` (yt-dlp's one-dir build ships its
 * Python runtime as separate .dylib/.so files, each of which must carry a signature).
 */
async function adhocSignTree(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile()) continue
    const file = join(e.parentPath, e.name)
    const isLib = /\.(dylib|so)$/.test(e.name)
    const isExec = ((await stat(file)).mode & 0o111) !== 0
    if (isLib || isExec) await execFileAsync('codesign', ['--force', '--sign', '-', file]).catch(() => undefined)
  }
}

/** Removes the quarantine flag macOS may attach to downloaded files. */
async function prepareMacBinaries(dir: string): Promise<void> {
  await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', dir]).catch(() => undefined)
}

function safeFolderName(revision: string): string {
  return revision.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
