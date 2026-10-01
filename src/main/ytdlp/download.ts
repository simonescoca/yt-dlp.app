import type { DownloadOptions, JobError } from '@shared/types'
import { extractError } from './errors'
import { escapeTemplate, formatArgs, reportingArgs } from './options'
import { ProgressTracker, type ProgressSnapshot } from './progress'
import { baseArgs, runYtdlp, type EngineContext } from './runner'

export interface DownloadRequest {
  /** Page URL, or the media URL found by the page scanner. Ignored when `infoJsonFile` is set. */
  url: string
  /** Info dict saved by the analysis: skips a second extraction. */
  infoJsonFile?: string | null
  options: DownloadOptions
  /** Final folder (the chosen folder, or a playlist sub-folder inside it). */
  outputDir: string
  /** File name without extension (already sanitized and unique). */
  fileBase: string
  /** Per-job folder for partial files; removed by the caller. */
  tempDir: string
  /** Extra HTTP headers (Referer, User-Agent... for streams found by the scanner). */
  headers?: Record<string, string>
}

export class DownloadError extends Error {
  constructor(readonly error: JobError) {
    super(error.message)
  }
}

/** Builds the full yt-dlp command line for a download (without the executable). */
export function downloadArgs(req: DownloadRequest, ctx: EngineContext): string[] {
  const args = [
    ...baseArgs(ctx),
    ...reportingArgs(),
    ...formatArgs(req.options),
    '--no-playlist',
    '--concurrent-fragments',
    '4',
    '--no-mtime',
    '--paths',
    `home:${req.outputDir}`,
    '--paths',
    `temp:${req.tempDir}`,
    '--output',
    `${escapeTemplate(req.fileBase)}.%(ext)s`
  ]
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (name.toLowerCase() === 'user-agent') args.push('--user-agent', value)
    else args.push('--add-header', `${name}:${value}`)
  }
  if (req.infoJsonFile) args.push('--load-info-json', req.infoJsonFile)
  else args.push('--', req.url)
  return args
}

/** Runs one download; resolves with the final file path. */
export async function download(
  req: DownloadRequest,
  ctx: EngineContext,
  opts: { signal?: AbortSignal; onProgress?: (p: ProgressSnapshot) => void; onLog?: (line: string) => void } = {}
): Promise<string> {
  const tracker = new ProgressTracker()
  // Download progress arrives on stdout, post-processing progress on stderr.
  const onLine = (line: string): void => {
    const snap = tracker.feed(line)
    if (snap) opts.onProgress?.(snap)
    else if (!line.startsWith('@@')) opts.onLog?.(line)
  }
  const res = await runYtdlp(ctx.paths.ytdlp, downloadArgs(req, ctx), {
    signal: opts.signal,
    onStdoutLine: onLine,
    onStderrLine: onLine
  })
  if (res.cancelled) throw new DownloadError({ code: 'cancelled', message: 'Download annullato' })
  if (res.code !== 0) throw new DownloadError(extractError(res.stderr))
  if (!tracker.finalPath) {
    throw new DownloadError({ code: 'unknown', message: 'yt-dlp non ha prodotto alcun file' })
  }
  return tracker.finalPath
}
