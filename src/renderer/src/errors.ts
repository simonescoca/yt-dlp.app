import type { ErrorCode } from '@shared/types'
import type { MessageKey } from './i18n'

export type ErrorAction = 'retry' | 'openPage' | 'login'

export interface ErrorInfo {
  message: MessageKey
  hint?: MessageKey
  actions: ErrorAction[]
}

/** How each failure is explained to the user, and what they can do about it. */
export function errorInfo(code: ErrorCode): ErrorInfo {
  switch (code) {
    case 'unsupported':
    case 'no_media':
      return { message: 'error.no_media', hint: 'error.no_media.hint', actions: ['openPage', 'retry'] }
    case 'forbidden':
      return { message: 'error.forbidden', actions: ['openPage', 'login', 'retry'] }
    case 'login_required':
    case 'private':
    case 'age_restricted':
      return { message: `error.${code}`, hint: 'error.login_required.hint', actions: ['login', 'retry'] }
    case 'drm':
      return { message: 'error.drm', actions: [] }
    case 'geo_blocked':
    case 'unavailable':
    case 'not_found':
      return { message: `error.${code}`, actions: ['retry'] }
    case 'live_not_started':
    case 'network':
    case 'rate_limited':
    case 'disk_full':
    case 'permission':
    case 'ffmpeg':
    case 'engine_missing':
    case 'interrupted':
    case 'cancelled':
    case 'unknown':
      return { message: `error.${code}`, actions: ['retry'] }
  }
}
