import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClickEffect } from '../../../src/renderer/src/components/ClickEffect'
import { AppShell } from '../../../src/renderer/src/components/AppShell'
import type { AppSettings } from '../../../src/shared/settings'

// The effect is an Owl feature (ADR-0072); each test says whether this build has it, what the settings say and whether
// motion is reduced.
const gate = vi.hoisted(() => ({ owl: true, reduced: false, settings: undefined as Partial<AppSettings> | undefined, watched: [] as boolean[] }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'click-effect' && gate.owl,
}))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: () => (gate.settings === undefined ? null : { settings: gate.settings }),
}))
vi.mock('../../../src/renderer/src/state/reducedMotion', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/reducedMotion')>(),
  useReducedMotion: (watch = true) => { gate.watched.push(watch); return gate.reduced },
}))

const originalGetContext = HTMLCanvasElement.prototype.getContext
let drawn = 0
let cleared = 0

beforeEach(() => {
  vi.useFakeTimers()
  drawn = 0
  cleared = 0
  // jsdom has no canvas; a stand-in counts what the layer draws.
  HTMLCanvasElement.prototype.getContext = (() => ({
    setTransform() {}, scale() {}, fillText() {}, save() {}, restore() {}, globalAlpha: 1, font: '', fillStyle: '', textAlign: '', textBaseline: '',
    clearRect() { cleared++ }, drawImage() { drawn++ },
  })) as never
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  gate.owl = true
  gate.reduced = false
  gate.settings = undefined
  gate.watched = []
})

const layer = (container: HTMLElement): HTMLCanvasElement | null => container.querySelector('canvas.click-effect')
const pressAt = (target: EventTarget, x: number, y: number, button = 0): void => {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}
const frames = (count: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(count * 17) })

describe('the click effect', () => {
  const shell = (): HTMLElement => render(<AppShell navigation={null} platform="win32" onMinimize={() => undefined} onMaximize={() => undefined} onClose={() => undefined}>room</AppShell>).container

  it('is there, hidden from assistive technology and never pressed, when the build has it and the settings leave it on', () => {
    expect(layer(shell())?.getAttribute('aria-hidden')).toBe('true')
    cleanup()
    gate.settings = { clickEffect: true }
    expect(layer(shell())).not.toBeNull()
  })

  it('does not exist where the build holds it, the switch is off, or motion is reduced', () => {
    gate.owl = false
    expect(layer(shell())).toBeNull()
    cleanup()
    gate.owl = true
    gate.settings = { clickEffect: false }
    expect(layer(shell())).toBeNull()
    cleanup()
    gate.settings = { clickEffect: true }
    gate.reduced = true
    expect(layer(shell())).toBeNull()
  })

  it('follows reduced motion only while the effect is chosen, so a held or switched-off effect starts nothing', () => {
    gate.owl = false
    shell()
    expect(gate.watched.length).toBeGreaterThan(0)
    expect(gate.watched.every(watch => !watch)).toBe(true)
    cleanup()
    gate.watched = []
    gate.owl = true
    gate.settings = { clickEffect: false }
    shell()
    expect(gate.watched.every(watch => !watch)).toBe(true)
  })

  it('draws after a primary press on the backdrop, even one the page stops, and never for another button', async () => {
    const { container } = render(<><ClickEffect /><div data-room-backdrop="" onPointerDown={event => event.stopPropagation()} /></>)
    const backdrop = container.querySelector('[data-room-backdrop]')!
    pressAt(backdrop, 300, 200, 2)
    await frames(6)
    expect(drawn).toBe(0)
    pressAt(backdrop, 300, 200)
    await frames(6)
    expect(drawn).toBeGreaterThan(0)
  })

  it('marks the shell while its layer is there, so the shell stacks it under the page, and never otherwise', () => {
    expect(shell().querySelector('.app-shell')?.hasAttribute('data-click-effect')).toBe(true)
    expect(document.querySelector('.app-shell > canvas.click-effect')).not.toBeNull()
    cleanup()
    gate.settings = { clickEffect: false }
    expect(shell().querySelector('.app-shell')?.hasAttribute('data-click-effect')).toBe(false)
    expect(document.querySelector('canvas.click-effect')).toBeNull()
  })

  // The room as the Threads page lays it out, its bare surfaces marked, with what sits on them.
  const room = (): HTMLElement => render(<><ClickEffect />
    <aside className="thread-nav" aria-label="Thread sidebar"><button type="button">Footer links</button></aside>
    <section className="thread-pane" data-room-backdrop="">
      <div className="thread-workspace__transcript" data-room-backdrop="">
        <div className="thread-transcript__content" data-room-backdrop="">
          <article className="thread-message"><div className="rich-message"><p>Fixing the footer links.</p></div><button type="button">Copy message</button></article>
          <section className="request-card"><p>Which docs path?</p><button type="button">Use /docs</button></section>
        </div>
      </div>
      <div className="thread-workspace__compose" data-room-backdrop="">
        <form className="thread-prompt"><textarea aria-label="Message" /><dialog open><button type="button">GPT-5.4</button></dialog></form>
      </div>
    </section>
    <div className="management-view settings-view"><button type="button" role="switch" aria-checked="true">Click effect</button></div>
  </>).container

  it('sends waves for a press on the bare backdrop: behind the panes, around the messages and around the composer', async () => {
    for (const selector of ['.thread-pane', '.thread-workspace__transcript', '.thread-transcript__content', '.thread-workspace__compose']) {
      cleanup()
      drawn = 0
      pressAt(room().querySelector(selector)!, 600, 300)
      await frames(6)
      expect(drawn, selector).toBeGreaterThan(0)
    }
  })

  it("sends none for a press on a message's words, its copy action, an answer, the composer, its menu, the sidebar or Settings", async () => {
    const container = room()
    const pressed = {
      words: container.querySelector('.rich-message p')!,
      message: container.querySelector('.thread-message')!,
      copy: container.querySelector('.thread-message button')!,
      answer: container.querySelector('.request-card button')!,
      card: container.querySelector('.request-card')!,
      composer: container.querySelector('textarea')!,
      menu: container.querySelector('dialog button')!,
      sidebar: container.querySelector('.thread-nav')!,
      row: container.querySelector('.thread-nav button')!,
      settings: container.querySelector('.settings-view')!,
      option: container.querySelector('[role="switch"]')!,
    }
    for (const target of Object.values(pressed)) pressAt(target, 600, 300)
    await frames(6)
    expect(drawn).toBe(0)
  })

  it('stops and clears when it goes, and a press afterwards draws nothing', async () => {
    const backdrop = document.body.appendChild(document.createElement('div'))
    backdrop.setAttribute('data-room-backdrop', '')
    const { unmount } = render(<ClickEffect />)
    pressAt(backdrop, 300, 200)
    await frames(3)
    const before = cleared
    unmount()
    expect(cleared).toBeGreaterThan(before)
    drawn = 0
    pressAt(backdrop, 300, 200)
    await frames(6)
    expect(drawn).toBe(0)
    backdrop.remove()
  })

})
