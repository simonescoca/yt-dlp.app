import type { StreamCandidate } from '@shared/types'

/** Below this duration a stream is most likely an ad, a preview or a background loop. */
export const SHORT_CLIP_SECONDS = 30

const KIND_WEIGHT: Record<StreamCandidate['kind'], number> = {
  hls: 30,
  dash: 30,
  ism: 25,
  progressive: 25,
  audio: 5
}

/** Scores a candidate: kind, resolution, duration, size; ads, DRM and short clips sink. */
export function scoreCandidate(c: Omit<StreamCandidate, 'score' | 'id'>): number {
  let s = KIND_WEIGHT[c.kind]
  if (c.height) s += Math.min(c.height, 4320) / 40 // 1080p → +27
  if (c.duration != null) {
    s += Math.min(Math.log2(1 + c.duration), 13) * 2 // longer is more likely the main video
    if (c.duration < SHORT_CLIP_SECONDS) s -= 25
  }
  if (c.kind === 'progressive' && c.size != null) {
    if (c.size < 512 * 1024) s -= 25
    else s += Math.min(Math.log2(c.size / (1024 * 1024) + 1), 12)
  }
  if (c.live) s -= 5
  if (c.ad) s -= 60
  if (c.drm) s -= 100
  return Math.round(s * 10) / 10
}

/** Plausible "main" videos: downloadable, not ads, not short clips, not audio-only. */
export function isPlausibleMain(c: StreamCandidate): boolean {
  if (c.drm || c.ad || c.kind === 'audio') return false
  if (c.duration != null && c.duration < SHORT_CLIP_SECONDS) return false
  if (c.kind === 'progressive' && c.size != null && c.size < 512 * 1024) return false
  return true
}

/**
 * Sorts candidates (best first) and decides whether the choice is ambiguous:
 * two or more plausible main videos whose durations differ (variants of the
 * same video have the same duration) and whose scores are close.
 */
export function rankCandidates(list: StreamCandidate[]): { sorted: StreamCandidate[]; best: StreamCandidate | null; ambiguous: boolean } {
  const sorted = [...list].sort((a, b) => b.score - a.score)
  const best = sorted.find((c) => !c.drm) ?? null
  const plausible = sorted.filter(isPlausibleMain)
  let ambiguous = false
  if (best && plausible.length >= 2) {
    const [a, b] = plausible as [StreamCandidate, StreamCandidate]
    const sameVideo = a.duration != null && b.duration != null && Math.abs(a.duration - b.duration) <= Math.max(2, a.duration * 0.02)
    ambiguous = !sameVideo && b.score >= a.score * 0.7
  }
  return { sorted, best, ambiguous }
}
