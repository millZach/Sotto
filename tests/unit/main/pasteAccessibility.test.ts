import { describe, expect, it, vi } from 'vitest'

import type { PasteInvocation } from '../../../src/main/output/pasteCommand'
import {
  ALWAYS_TRUSTED_ACCESSIBILITY,
  createAccessibilityGate,
  createAccessibilityGatedPasteAdapter,
  type AccessibilityTrustAdapter,
} from '../../../src/main/output/pasteAccessibility'

const INVOCATION: PasteInvocation = Object.freeze({
  executable: '/usr/bin/osascript',
  args: Object.freeze(['-e', 'static script']),
})

function trustAdapter(
  answers: readonly boolean[] | (() => boolean),
): AccessibilityTrustAdapter & { readonly prompts: boolean[] } {
  const prompts: boolean[] = []
  let index = 0
  return {
    prompts,
    isTrusted(prompt): boolean {
      prompts.push(prompt)
      if (typeof answers === 'function') return answers()
      const answer = answers[Math.min(index, answers.length - 1)] ?? false
      index += 1
      return answer
    },
  }
}

describe('createAccessibilityGate', () => {
  it('reports trust without prompting', () => {
    const adapter = trustAdapter([true])
    const gate = createAccessibilityGate(adapter)

    expect(gate.status()).toBe('trusted')
    expect(adapter.prompts).toEqual([false])
  })

  it('prompts at most once per run and keeps answering afterwards', () => {
    const adapter = trustAdapter([false])
    const gate = createAccessibilityGate(adapter)

    expect(gate.requestOnce()).toBe('untrusted')
    expect(gate.requestOnce()).toBe('untrusted')
    expect(gate.requestOnce()).toBe('untrusted')

    expect(adapter.prompts).toEqual([true, false, false])
  })

  it('reports untrusted instead of propagating a failing trust API', () => {
    const gate = createAccessibilityGate({
      isTrusted(): boolean {
        throw new Error('private OS detail')
      },
    })

    expect(gate.status()).toBe('untrusted')
    expect(gate.requestOnce()).toBe('untrusted')
  })

  it('treats the always-trusted adapter as granted without any prompt', () => {
    const gate = createAccessibilityGate(ALWAYS_TRUSTED_ACCESSIBILITY)

    expect(gate.status()).toBe('trusted')
    expect(gate.requestOnce()).toBe('trusted')
  })
})

describe('createAccessibilityGatedPasteAdapter', () => {
  it('delegates to the inner adapter while trust is granted', async () => {
    const run = vi.fn(() => Promise.resolve(true))
    const onUntrusted = vi.fn()
    const adapter = createAccessibilityGatedPasteAdapter({
      gate: createAccessibilityGate(ALWAYS_TRUSTED_ACCESSIBILITY),
      inner: { run },
      onUntrusted,
    })

    await expect(adapter.run(INVOCATION)).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith(INVOCATION)
    expect(onUntrusted).not.toHaveBeenCalled()
  })

  it('never pastes while untrusted, prompts once, and reports every denial', async () => {
    const run = vi.fn(() => Promise.resolve(true))
    const onUntrusted = vi.fn()
    const trust = trustAdapter(() => false)
    const adapter = createAccessibilityGatedPasteAdapter({
      gate: createAccessibilityGate(trust),
      inner: { run },
      onUntrusted,
    })

    expect(await adapter.run(INVOCATION)).toBe(false)
    expect(await adapter.run(INVOCATION)).toBe(false)
    expect(await adapter.run(INVOCATION)).toBe(false)

    expect(run).not.toHaveBeenCalled()
    expect(onUntrusted).toHaveBeenCalledTimes(3)
    expect(trust.prompts.filter((prompt) => prompt)).toHaveLength(1)
  })

  it('starts pasting once trust is granted mid-run without prompting again', async () => {
    const run = vi.fn(() => Promise.resolve(true))
    const onUntrusted = vi.fn()
    const trust = trustAdapter([false, false, true, true])
    const adapter = createAccessibilityGatedPasteAdapter({
      gate: createAccessibilityGate(trust),
      inner: { run },
      onUntrusted,
    })

    expect(await adapter.run(INVOCATION)).toBe(false)
    await expect(adapter.run(INVOCATION)).resolves.toBe(true)

    expect(run).toHaveBeenCalledTimes(1)
    expect(onUntrusted).toHaveBeenCalledTimes(1)
    expect(trust.prompts.filter((prompt) => prompt)).toHaveLength(1)
  })

  it('returns false without pasting when the trust adapter throws', async () => {
    const run = vi.fn(() => Promise.resolve(true))
    const onUntrusted = vi.fn()
    const adapter = createAccessibilityGatedPasteAdapter({
      gate: createAccessibilityGate({
        isTrusted(): boolean {
          throw new Error('private OS detail')
        },
      }),
      inner: { run },
      onUntrusted,
    })

    expect(await adapter.run(INVOCATION)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(onUntrusted).toHaveBeenCalledTimes(1)
  })

  it('still reports a denied paste when the notice publisher throws', async () => {
    const run = vi.fn(() => Promise.resolve(true))
    const adapter = createAccessibilityGatedPasteAdapter({
      gate: createAccessibilityGate(trustAdapter(() => false)),
      inner: { run },
      onUntrusted: () => {
        throw new Error('private notice detail')
      },
    })

    expect(await adapter.run(INVOCATION)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
