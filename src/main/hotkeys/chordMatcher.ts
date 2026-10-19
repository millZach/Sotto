import type { WidgetSnapshot } from '../../shared/dictation'

export type ChordRole = 'hold' | 'press'
export type ChordEventType = 'start' | 'stop' | 'cancel' | 'toggle'

export interface MatcherChord {
  readonly id: string
  readonly chord: string
  readonly role: ChordRole
}

export interface ChordEvent {
  readonly id: string
  readonly role: ChordRole
  readonly type: ChordEventType
}

export interface ChordMatcherOptions {
  /** Whether a hold may start a session now. */
  readonly canStart: () => boolean
}

/**
 * A hold may start unless dictation is already under way; a finished session (success, error, cancelled) does not
 * block it, except an error that kept its recording for Try again, which a stray hold would otherwise throw away.
 */
export function holdCanStart(state: { readonly status: WidgetSnapshot['status']; readonly kept?: boolean | undefined }): boolean {
  if (state.status === 'error' && state.kept === true) return false
  return state.status !== 'requesting-permission' && state.status !== 'listening' && state.status !== 'processing'
}

export interface ChordMatcher {
  key(type: 'down' | 'up', token: string): void
  reset(): void
  /** Every started hold goes inert with no event: a press shortcut took the session over. */
  releaseHolds(): void
  watchedTokens(): string[]
}

const MODIFIERS: ReadonlySet<string> = new Set(['Fn', 'Control', 'Alt', 'Shift', 'CommandOrControl', 'Super'])

interface ChordState {
  readonly id: string
  readonly role: ChordRole
  readonly tokens: readonly string[]
  readonly modifiers: ReadonlySet<string>
  readonly key: string | null
  // inert: a cancelled or skipped hold, or a fired press, waiting for its tokens to go up.
  phase: 'idle' | 'started' | 'inert'
}

function parseChord(chord: string): { tokens: string[]; modifiers: Set<string>; key: string | null } {
  const tokens = [...new Set(chord.split('+').map((token) => token.trim()).filter((token) => token.length > 0))]
  return {
    tokens,
    modifiers: new Set(tokens.filter((token) => MODIFIERS.has(token))),
    key: tokens.find((token) => !MODIFIERS.has(token)) ?? null,
  }
}

export function createChordMatcher(
  chords: readonly MatcherChord[],
  emit: (event: ChordEvent) => void,
  options: ChordMatcherOptions,
): ChordMatcher {
  const states: ChordState[] = chords.map(({ id, chord, role }) => ({ id, role, ...parseChord(chord), phase: 'idle' }))
  const held = new Set<string>()

  const heldModifiersEqual = (modifiers: ReadonlySet<string>): boolean => {
    let count = 0
    for (const token of held) {
      if (!MODIFIERS.has(token)) continue
      if (!modifiers.has(token)) return false
      count += 1
    }
    return count === modifiers.size
  }

  const activates = (state: ChordState, token: string): boolean => {
    if (state.tokens.length === 0 || !heldModifiersEqual(state.modifiers)) return false
    return state.key === null ? state.modifiers.has(token) : state.key === token
  }

  const down = (token: string): void => {
    for (const state of states) {
      if (state.phase === 'started' && state.role === 'hold' && state.key === null) {
        state.phase = 'inert'
        emit({ id: state.id, role: state.role, type: 'cancel' })
      }
    }
    for (const state of states) {
      if (state.phase !== 'idle' || !activates(state, token)) continue
      if (state.role === 'press') {
        state.phase = 'inert'
        emit({ id: state.id, role: state.role, type: 'toggle' })
      } else if (options.canStart()) {
        state.phase = 'started'
        emit({ id: state.id, role: state.role, type: 'start' })
      } else {
        state.phase = 'inert'
      }
    }
  }

  const up = (token: string): void => {
    for (const state of states) {
      if (!state.tokens.includes(token)) continue
      if (state.phase === 'started') {
        state.phase = 'idle'
        emit({ id: state.id, role: state.role, type: 'stop' })
      } else if (state.phase === 'inert' && (state.role === 'press' || state.tokens.every((t) => !held.has(t)))) {
        state.phase = 'idle'
      }
    }
  }

  return {
    key(type, token) {
      if (type === 'down') {
        if (held.has(token)) return
        held.add(token)
        down(token)
      } else {
        if (!held.delete(token)) return
        up(token)
      }
    },

    reset() {
      held.clear()
      for (const state of states) {
        const started = state.phase === 'started'
        state.phase = 'idle'
        if (started && state.role === 'hold') emit({ id: state.id, role: state.role, type: 'cancel' })
      }
    },

    releaseHolds() {
      for (const state of states) if (state.phase === 'started') state.phase = 'inert'
    },

    watchedTokens() {
      return [...new Set(states.flatMap((state) => state.tokens))]
    },
  }
}
