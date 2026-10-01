/**
 * Where each engine component (yt-dlp, Deno, ffmpeg) comes from, for every
 * supported platform. Pure data + helpers so it can be unit-tested.
 */

export type { ComponentId } from '@shared/types'
import type { ComponentId } from '@shared/types'
export const COMPONENT_IDS: readonly ComponentId[] = ['yt-dlp', 'deno', 'ffmpeg']

export type Target = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64'
export type { YtdlpChannel } from '@shared/types'
import type { YtdlpChannel } from '@shared/types'

export function detectTarget(platform: string = process.platform, arch: string = process.arch): Target {
  const t = `${platform}-${arch}`
  switch (t) {
    case 'darwin-arm64':
    case 'darwin-x64':
    case 'win32-x64':
    case 'linux-x64':
      return t
    // Windows on ARM runs x64 binaries through emulation.
    case 'win32-arm64':
      return 'win32-x64'
    default:
      throw new Error(`Piattaforma non supportata: ${t}`)
  }
}

export const exeSuffix = (target: Target): string => (target.startsWith('win32') ? '.exe' : '')

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

export const YTDLP_REPOS: Record<YtdlpChannel, string> = {
  nightly: 'yt-dlp/yt-dlp-nightly-builds',
  stable: 'yt-dlp/yt-dlp'
}

/** One-dir builds start much faster than the one-file ones (no unpacking on every run). */
const YTDLP_ASSETS: Record<Target, { asset: string; exe: string }> = {
  'darwin-arm64': { asset: 'yt-dlp_macos.zip', exe: 'yt-dlp_macos' },
  'darwin-x64': { asset: 'yt-dlp_macos.zip', exe: 'yt-dlp_macos' },
  'win32-x64': { asset: 'yt-dlp_win.zip', exe: 'yt-dlp.exe' },
  'linux-x64': { asset: 'yt-dlp_linux.zip', exe: 'yt-dlp_linux' }
}

export function ytdlpAsset(target: Target): { asset: string; exe: string } {
  return YTDLP_ASSETS[target]
}

/** A tiny file whose "latest" redirect reveals the newest release tag. */
export function ytdlpLatestProbeUrl(channel: YtdlpChannel): string {
  return `https://github.com/${YTDLP_REPOS[channel]}/releases/latest/download/SHA2-256SUMS`
}

export function ytdlpReleaseFileUrl(channel: YtdlpChannel, tag: string, file: string): string {
  return `https://github.com/${YTDLP_REPOS[channel]}/releases/download/${tag}/${file}`
}

/** Extracts the release tag from a GitHub `releases/download/<tag>/<file>` URL. */
export function tagFromReleaseUrl(url: string): string | null {
  const m = /\/releases\/download\/([^/]+)\//.exec(url)
  return m ? decodeURIComponent(m[1]!) : null
}

// ---------------------------------------------------------------------------
// Deno (JavaScript runtime required by yt-dlp for YouTube)
// ---------------------------------------------------------------------------

const DENO_TRIPLES: Record<Target, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu'
}

export const DENO_LATEST_URL = 'https://dl.deno.land/release-latest.txt'

export function denoAssetUrl(target: Target, version: string): string {
  return `https://dl.deno.land/release/${version}/deno-${DENO_TRIPLES[target]}.zip`
}

// ---------------------------------------------------------------------------
// ffmpeg + ffprobe
// ---------------------------------------------------------------------------

export interface FfmpegArchive {
  url: string
  /** URL of a checksum file, and how to read the hash for this archive from it. */
  checksumUrl: string
  checksumName: string
  kind: 'zip' | 'tar.xz'
}

export type FfmpegSource =
  | {
      /** macOS builds by Martin Riedl: one zip per binary, "latest" is a redirect. */
      provider: 'martin-riedl'
      latestProbeUrl: string
      archives: (revisionPath: string) => FfmpegArchive[]
    }
  | {
      /** yt-dlp's own FFmpeg builds (Windows / Linux), recommended by yt-dlp. */
      provider: 'yt-dlp'
      archive: FfmpegArchive
      /** Folder inside the archive that holds the binaries. */
      binSubdir: string
    }

const RIEDL = 'https://ffmpeg.martin-riedl.de'
const FFBUILDS = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest'

export function ffmpegSource(target: Target): FfmpegSource {
  if (target === 'darwin-arm64' || target === 'darwin-x64') {
    const arch = target === 'darwin-arm64' ? 'arm64' : 'amd64'
    return {
      provider: 'martin-riedl',
      latestProbeUrl: `${RIEDL}/redirect/latest/macos/${arch}/release/ffmpeg.zip`,
      archives: (revisionPath) =>
        ['ffmpeg', 'ffprobe'].map((bin) => ({
          url: `${RIEDL}/download/macos/${arch}/${revisionPath}/${bin}.zip`,
          checksumUrl: `${RIEDL}/download/macos/${arch}/${revisionPath}/${bin}.zip.sha256`,
          checksumName: `${bin}.zip`,
          kind: 'zip' as const
        }))
    }
  }
  const name = target === 'win32-x64' ? 'ffmpeg-master-latest-win64-gpl' : 'ffmpeg-master-latest-linux64-gpl'
  const kind = target === 'win32-x64' ? 'zip' : 'tar.xz'
  return {
    provider: 'yt-dlp',
    archive: {
      url: `${FFBUILDS}/${name}.${kind}`,
      checksumUrl: `${FFBUILDS}/checksums.sha256`,
      checksumName: `${name}.${kind}`,
      kind
    },
    binSubdir: `${name}/bin`
  }
}

/** From ".../download/macos/arm64/1789931890_9.0.2/ffmpeg.zip" → "1789931890_9.0.2". */
export function riedlRevisionFromUrl(url: string): string | null {
  const m = /\/download\/macos\/[^/]+\/([^/]+)\/[^/]+$/.exec(url)
  return m ? m[1]! : null
}

/** "1789931890_9.0.2" → "9.0.2"; snapshot names like "1790504560_N-126899-gd97" are kept after the "_". */
export function riedlVersion(revision: string): string {
  const i = revision.indexOf('_')
  return i >= 0 ? revision.slice(i + 1) : revision
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/**
 * Parses `sha256sum`-style files ("<hash>  <name>" or "<hash> *<name>" per line)
 * into a map name → lowercase hash. A file holding a bare hash maps to "".
 */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/.exec(line)
    if (m) out.set(m[2]?.trim() ?? '', m[1]!.toLowerCase())
  }
  return out
}

/** Looks up a hash for `name`; single-entry files (e.g. "file.zip.sha256") match regardless of name. */
export function findChecksum(text: string, name: string): string | null {
  const map = parseChecksums(text)
  const direct = map.get(name)
  if (direct) return direct
  if (map.size === 1) return [...map.values()][0]!
  return null
}
