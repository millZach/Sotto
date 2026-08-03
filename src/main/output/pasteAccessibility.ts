import type { PasteProcessAdapter } from './outputService'

export type AccessibilityTrust = 'trusted' | 'untrusted'

export interface AccessibilityTrustAdapter {
  isTrusted(prompt: boolean): boolean
}

export interface AccessibilityGate {
  status(): AccessibilityTrust
  requestOnce(): AccessibilityTrust
}

export interface AccessibilityGatedPasteOptions {
  readonly gate: AccessibilityGate
  readonly inner: PasteProcessAdapter
  readonly onUntrusted: () => void
}

// Platforms without a trust requirement wrap the same gate so both code paths
// are identical and Windows-testable.
export const ALWAYS_TRUSTED_ACCESSIBILITY: AccessibilityTrustAdapter = Object.freeze({
  isTrusted(): boolean {
    return true
  },
})

export function createAccessibilityGate(adapter: AccessibilityTrustAdapter): AccessibilityGate {
  let prompted = false

  const probe = (prompt: boolean): AccessibilityTrust => {
    try {
      return adapter.isTrusted(prompt) ? 'trusted' : 'untrusted'
    } catch {
      // An unusable trust API degrades to untrusted: the transcript still lands
      // on the clipboard instead of the delivery failing.
      return 'untrusted'
    }
  }

  return {
    status(): AccessibilityTrust {
      return probe(false)
    },

    // The OS dialog appears at most once per run, and only once a paste has
    // actually been attempted.
    requestOnce(): AccessibilityTrust {
      if (prompted) {
        return probe(false)
      }
      prompted = true
      return probe(true)
    },
  }
}

export function createAccessibilityGatedPasteAdapter(
  options: AccessibilityGatedPasteOptions,
): PasteProcessAdapter {
  return {
    run(invocation): boolean | Promise<boolean> {
      if (options.gate.status() === 'trusted') {
        return options.inner.run(invocation)
      }

      options.gate.requestOnce()
      try {
        options.onUntrusted()
      } catch {
        // Publishing the notice must never turn a copied outcome into a failure.
      }
      return false
    },
  }
}
