/** Types shared between the main process, the preload script and the UI. */

export type ComponentId = 'yt-dlp' | 'deno' | 'ffmpeg'

export type ComponentPhase = 'missing' | 'ready' | 'checking' | 'downloading' | 'installing' | 'error'

export interface ComponentState {
  id: ComponentId
  phase: ComponentPhase
  /** Installed version, if any. */
  version: string | null
  /** Newest upstream version seen at the last check. */
  latestVersion: string | null
  /** Download progress 0..1 while `phase === 'downloading'`. */
  progress: number | null
  /** Last error (install or update check). */
  error: string | null
  lastCheck: number | null
}
