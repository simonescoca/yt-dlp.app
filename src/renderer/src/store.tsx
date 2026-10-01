import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import type { AppEvent, AppState, Job } from '@shared/types'

type Action = { type: 'init'; state: AppState } | { type: 'event'; event: AppEvent }

function reducer(state: AppState | null, action: Action): AppState | null {
  if (action.type === 'init') return action.state
  if (!state) return state
  const e = action.event
  switch (e.type) {
    case 'job': {
      const i = state.jobs.findIndex((j) => j.id === e.job.id)
      const jobs = i >= 0 ? state.jobs.map((j, k) => (k === i ? e.job : j)) : [e.job, ...state.jobs]
      return { ...state, jobs }
    }
    case 'job-removed':
      return { ...state, jobs: state.jobs.filter((j) => j.id !== e.id) }
    case 'components':
      return { ...state, components: e.components }
    case 'settings':
      return { ...state, settings: e.settings }
    case 'logins':
      return { ...state, loggedInSites: e.sites }
  }
}

const StateContext = createContext<AppState | null>(null)

export function StoreProvider({ children }: { children: (state: AppState) => ReactNode }): React.JSX.Element | null {
  const [state, dispatch] = useReducer(reducer, null)
  useEffect(() => {
    // Subscribe first so no event is lost between the snapshot and the subscription.
    const off = window.grabbit.onEvent((event) => dispatch({ type: 'event', event }))
    void window.grabbit.getState().then((s) => dispatch({ type: 'init', state: s }))
    return off
  }, [])
  if (!state) return null
  return <StateContext.Provider value={state}>{children(state)}</StateContext.Provider>
}

export function useAppState(): AppState {
  const s = useContext(StateContext)
  if (!s) throw new Error('useAppState outside StoreProvider')
  return s
}

export function useSortedJobs(): Job[] {
  const { jobs } = useAppState()
  return useMemo(() => [...jobs].sort((a, b) => b.createdAt - a.createdAt), [jobs])
}

export const api = (): Window['grabbit'] => window.grabbit
