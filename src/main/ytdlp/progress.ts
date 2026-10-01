import { MARK } from './options'

/** What the UI shows while a job runs. */
export type Stage = 'downloading' | 'merging' | 'converting' | 'embedding' | 'finishing'

export interface ProgressSnapshot {
  stage: Stage
  /** Overall progress 0..1, or null when unknown (e.g. live streams). */
  fraction: number | null
  /** Bytes per second. */
  speed: number | null
  /** Seconds remaining for the current download. */
  eta: number | null
  downloadedBytes: number
  totalBytes: number | null
}

interface RawProgress {
  status: string
  downloaded: number | null
  total: number | null
  estimate: number | null
  speed: number | null
  eta: number | null
  fragment: number | null
  fragments: number | null
  format: string | null
}

interface RawRequested {
  ids: string[] | null
  sizes: (number | null)[] | null
  approx: (number | null)[] | null
  format: string | null
  size: number | null
  sizeApprox: number | null
}

const POSTPROCESSOR_STAGE: Record<string, Stage> = {
  Merger: 'merging',
  FFmpegMerger: 'merging',
  ExtractAudio: 'converting',
  FFmpegExtractAudio: 'converting',
  VideoRemuxer: 'converting',
  FFmpegVideoRemuxer: 'converting',
  VideoConvertor: 'converting',
  FFmpegVideoConvertor: 'converting',
  EmbedThumbnail: 'embedding',
  Metadata: 'embedding',
  FFmpegMetadata: 'embedding'
}

function tryJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * Consumes the machine-readable lines printed by yt-dlp (see `reportingArgs`)
 * and keeps an overall progress across the separate video/audio downloads.
 */
export class ProgressTracker {
  private parts: { id: string; size: number | null }[] = []
  private readonly done = new Map<string, number>()
  private current: RawProgress | null = null
  private stage: Stage = 'downloading'
  finalPath: string | null = null

  /** Returns a new snapshot when the line changed the progress, else null. */
  feed(line: string): ProgressSnapshot | null {
    if (line.startsWith(MARK.requested)) {
      const r = tryJson<RawRequested>(line.slice(MARK.requested.length))
      if (!r) return null
      if (r.ids && r.ids.length) {
        this.parts = r.ids.map((id, i) => ({ id, size: r.sizes?.[i] ?? r.approx?.[i] ?? null }))
      } else if (r.format) {
        this.parts = [{ id: r.format, size: r.size ?? r.sizeApprox }]
      }
      return null
    }
    if (line.startsWith(MARK.postprocess)) {
      const p = tryJson<{ status: string; pp: string }>(line.slice(MARK.postprocess.length))
      if (!p || p.status !== 'started') return null
      const stage = POSTPROCESSOR_STAGE[p.pp]
      if (!stage) return null
      this.stage = stage
      return this.snapshot()
    }
    if (line.startsWith(MARK.progress)) {
      const p = tryJson<RawProgress>(line.slice(MARK.progress.length))
      if (!p) return null
      this.stage = 'downloading'
      if (p.status === 'finished') {
        const key = p.format ?? `part${this.done.size}`
        this.done.set(key, p.total ?? p.downloaded ?? p.estimate ?? 0)
        this.current = null
      } else {
        this.current = p
      }
      return this.snapshot()
    }
    if (line.startsWith(MARK.file)) {
      this.finalPath = tryJson<string>(line.slice(MARK.file.length))
      this.stage = 'finishing'
      return this.snapshot()
    }
    return null
  }

  snapshot(): ProgressSnapshot {
    const cur = this.current
    const doneBytes = [...this.done.values()].reduce((a, b) => a + b, 0)
    const curDownloaded = cur?.downloaded ?? 0
    const curTotal = cur ? (cur.total ?? cur.estimate ?? this.partSize(cur.format)) : null
    const downloadedBytes = doneBytes + curDownloaded

    let fraction: number | null = null
    const nParts = Math.max(this.parts.length, this.done.size + (cur ? 1 : 0), 1)
    if (this.stage !== 'downloading') {
      fraction = 1
    } else if (this.parts.length && this.parts.every((p) => p.size)) {
      // Weight by bytes when every part size is known (video parts dominate).
      const total = this.parts.reduce((a, p) => a + (p.id === cur?.format && curTotal ? curTotal : p.size!), 0)
      fraction = total > 0 ? downloadedBytes / total : null
    } else if (cur && curTotal) {
      fraction = (this.done.size + curDownloaded / curTotal) / nParts
    } else if (cur?.fragment != null && cur.fragments) {
      fraction = (this.done.size + cur.fragment / cur.fragments) / nParts
    } else if (!cur && this.done.size) {
      fraction = this.done.size / nParts
    }
    if (fraction != null) fraction = Math.min(1, Math.max(0, fraction))

    const totalBytes = this.parts.length && this.parts.every((p) => p.size) ? this.parts.reduce((a, p) => a + p.size!, 0) : curTotal
    return {
      stage: this.stage,
      fraction,
      speed: cur?.speed ?? null,
      eta: cur?.eta ?? null,
      downloadedBytes,
      totalBytes
    }
  }

  private partSize(format: string | null): number | null {
    return this.parts.find((p) => p.id === format)?.size ?? null
  }
}
