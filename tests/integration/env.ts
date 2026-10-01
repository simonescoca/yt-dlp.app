import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EnginePaths } from '../../src/main/engine/components'
import { exeSuffix, detectTarget, ytdlpAsset } from '../../src/main/engine/sources'

export const DEV_BIN_DIR = resolve(__dirname, '../../.dev-data/bin')

/** Paths of the engine installed by engine-install.test.ts (run it first). */
export function devEnginePaths(): EnginePaths {
  const manifest = JSON.parse(readFileSync(join(DEV_BIN_DIR, 'manifest.json'), 'utf8')) as {
    components: Record<string, { folder: string }>
  }
  const target = detectTarget()
  const sfx = exeSuffix(target)
  return {
    ytdlp: join(DEV_BIN_DIR, 'yt-dlp', manifest.components['yt-dlp']!.folder, ytdlpAsset(target).exe),
    deno: join(DEV_BIN_DIR, 'deno', manifest.components['deno']!.folder, `deno${sfx}`),
    ffmpegDir: join(DEV_BIN_DIR, 'ffmpeg', manifest.components['ffmpeg']!.folder)
  }
}

export interface ProbeStream {
  codec_type: string
  codec_name: string
  width?: number
  height?: number
}

export interface Probe {
  format: { format_name: string; duration?: string; tags?: Record<string, string> }
  streams: ProbeStream[]
}

export function ffprobe(paths: EnginePaths, file: string): Probe {
  const out = execFileSync(join(paths.ffmpegDir, `ffprobe${exeSuffix(detectTarget())}`), [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file
  ])
  return JSON.parse(out.toString()) as Probe
}
