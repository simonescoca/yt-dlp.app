import type { GrabbitApi } from '../shared/types'

declare global {
  interface Window {
    grabbit: GrabbitApi
  }
}
