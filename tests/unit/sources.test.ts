import { describe, expect, it } from 'vitest'
import {
  denoAssetUrl,
  detectTarget,
  ffmpegSource,
  findChecksum,
  parseChecksums,
  riedlRevisionFromUrl,
  riedlVersion,
  tagFromReleaseUrl,
  ytdlpAsset,
  ytdlpLatestProbeUrl,
  ytdlpReleaseFileUrl
} from '../../src/main/engine/sources'

describe('detectTarget', () => {
  it('maps supported platforms', () => {
    expect(detectTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(detectTarget('win32', 'x64')).toBe('win32-x64')
    expect(detectTarget('win32', 'arm64')).toBe('win32-x64')
    expect(detectTarget('linux', 'x64')).toBe('linux-x64')
  })
  it('rejects unsupported platforms', () => {
    expect(() => detectTarget('freebsd', 'x64')).toThrow(/non supportata/)
  })
})

describe('yt-dlp sources', () => {
  it('uses the nightly repository and one-dir builds', () => {
    expect(ytdlpLatestProbeUrl('nightly')).toBe(
      'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/SHA2-256SUMS'
    )
    expect(ytdlpAsset('darwin-arm64')).toEqual({ asset: 'yt-dlp_macos.zip', exe: 'yt-dlp_macos' })
    expect(ytdlpAsset('win32-x64')).toEqual({ asset: 'yt-dlp_win.zip', exe: 'yt-dlp.exe' })
    expect(ytdlpReleaseFileUrl('stable', '2026.08.19', 'yt-dlp_win.zip')).toBe(
      'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_win.zip'
    )
  })
  it('extracts the tag from a release redirect', () => {
    expect(
      tagFromReleaseUrl('https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.09.27.232945/SHA2-256SUMS')
    ).toBe('2026.09.27.232945')
    expect(tagFromReleaseUrl('https://release-assets.githubusercontent.com/whatever')).toBeNull()
  })
})

describe('deno sources', () => {
  it('builds per-platform URLs', () => {
    expect(denoAssetUrl('darwin-arm64', 'v2.9.7')).toBe('https://dl.deno.land/release/v2.9.7/deno-aarch64-apple-darwin.zip')
    expect(denoAssetUrl('win32-x64', 'v2.9.7')).toBe('https://dl.deno.land/release/v2.9.7/deno-x86_64-pc-windows-msvc.zip')
  })
})

describe('ffmpeg sources', () => {
  it('uses Martin Riedl builds on macOS', () => {
    const src = ffmpegSource('darwin-arm64')
    expect(src.provider).toBe('martin-riedl')
    if (src.provider !== 'martin-riedl') return
    expect(src.latestProbeUrl).toBe('https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip')
    const archives = src.archives('1789931890_9.0.2')
    expect(archives.map((a) => a.url)).toEqual([
      'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip',
      'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip'
    ])
  })
  it('uses yt-dlp FFmpeg-Builds on Windows', () => {
    const src = ffmpegSource('win32-x64')
    expect(src.provider).toBe('yt-dlp')
    if (src.provider !== 'yt-dlp') return
    expect(src.archive.url).toMatch(/ffmpeg-master-latest-win64-gpl\.zip$/)
    expect(src.binSubdir).toBe('ffmpeg-master-latest-win64-gpl/bin')
  })
  it('parses revisions', () => {
    expect(riedlRevisionFromUrl('https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip')).toBe(
      '1789931890_9.0.2'
    )
    expect(riedlVersion('1789931890_9.0.2')).toBe('9.0.2')
  })
})

describe('checksums', () => {
  const sums = [
    '36de87e6276c4bbaa2d9fd4d1295b25f4e824fe9bbfa20e05e175fd0cecee858  yt-dlp',
    '36f09490817a70b12de29c9bc48c848f3f42ac1ec17af37d43d6c31a56e071ae  yt-dlp_win.zip',
    'E870A19610F46E13E6B76EB3D4BC2C637A04C7CECC98951BB03173CF8C023FED *yt-dlp_macos.zip',
    ''
  ].join('\n')
  it('parses sha256sum files', () => {
    const map = parseChecksums(sums)
    expect(map.size).toBe(3)
    expect(map.get('yt-dlp_macos.zip')).toBe('e870a19610f46e13e6b76eb3d4bc2c637a04c7cecc98951bb03173cf8c023fed')
  })
  it('finds a hash by name, or the only hash of single-entry files', () => {
    expect(findChecksum(sums, 'yt-dlp_win.zip')).toBe('36f09490817a70b12de29c9bc48c848f3f42ac1ec17af37d43d6c31a56e071ae')
    expect(findChecksum(sums, 'missing.zip')).toBeNull()
    expect(findChecksum('c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924  ffmpeg.zip\n', 'other')).toBe(
      'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924'
    )
  })
})
