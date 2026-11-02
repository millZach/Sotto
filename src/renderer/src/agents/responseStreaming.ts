import { createContext, useContext } from 'react'
import type { AppSettings } from '../../../shared/settings'

/**
 * Settings › Threads' Response streaming, for the transcript. It is a context of its own, not a field read from the agent
 * context: that context's value is new with every agent update, so a transcript reading it would be drawn again for every
 * word any thread streamed, through its pane's memo boundary (#993).
 */
const ResponseStreamingContext = createContext<AppSettings['responseStreaming']>('live')

export const ResponseStreamingProvider = ResponseStreamingContext.Provider

export function useResponseStreaming(): AppSettings['responseStreaming'] {
  return useContext(ResponseStreamingContext)
}
