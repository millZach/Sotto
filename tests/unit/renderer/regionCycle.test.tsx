import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { useRegionCycle } from '../../../src/renderer/src/components/regionCycle'

/**
 * F6 and Shift+F6 between a page's regions (ADR-0164): the sidebar, each thread pane and its composer, or the room
 * beside the sidebar. In a split the trip from the sidebar starts at the focused pane and goes round the others.
 */
function Keys({ settings }: { readonly settings?: Partial<typeof DEFAULT_SETTINGS> | undefined }): null {
  useRegionCycle({ settings: { ...DEFAULT_SETTINGS, ...settings }, platform: 'win32' })
  return null
}

function pane(id: string, focused = false): React.ReactNode {
  return <section data-region="pane" data-thread-id={id} data-focused={focused || undefined} aria-label={id}>
    <button type="button">Watch {id}</button>
    <div role="log" tabIndex={0} aria-label={`transcript ${id}`} />
    <div data-region="composer"><div className="prompt-editor" contentEditable="true" tabIndex={0} aria-label={`prompt ${id}`} suppressContentEditableWarning /></div>
  </section>
}

function threadsPage(focused: 'one' | 'two' = 'two', settings?: Partial<typeof DEFAULT_SETTINGS>) {
  return render(<>
    <Keys settings={settings} />
    <main data-region="room">
      <aside data-region="sidebar">
        <input type="search" aria-label="Search threads" data-region-entry="2" />
        <div data-region-entry="1"><button type="button" tabIndex={-1}>Row one</button><button type="button" tabIndex={0}>Row two</button></div>
      </aside>
      {pane('one', focused === 'one')}{pane('two', focused === 'two')}
    </main>
  </>)
}
const named = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[aria-label="${name}"]`) ?? [...document.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === name)!
const f6 = (shiftKey = false): boolean => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F6', shiftKey })

afterEach(cleanup)

describe('F6 between regions (ADR-0164)', () => {
  it('enters the sidebar at the list\'s stop, then the focused pane, its composer, the other pane, and back', () => {
    threadsPage('two')
    expect(f6()).toBe(false)
    expect(named('Row two')).toHaveFocus()
    f6(); expect(named('transcript two')).toHaveFocus()
    f6(); expect(named('prompt two')).toHaveFocus()
    f6(); expect(named('transcript one')).toHaveFocus()
    f6(); expect(named('prompt one')).toHaveFocus()
    f6(); expect(named('Row two')).toHaveFocus()
  })

  it('goes the other way with Shift+F6, the focused pane\'s composer first', () => {
    threadsPage('one')
    named('Row two').focus()
    f6(true); expect(named('prompt one')).toHaveFocus()
    f6(true); expect(named('transcript one')).toHaveFocus()
    f6(true); expect(named('prompt two')).toHaveFocus()
    f6(true); expect(named('transcript two')).toHaveFocus()
    f6(true); expect(named('Row two')).toHaveFocus()
  })

  it('enters the sidebar at its search field when the list holds nothing, and a room beside it at its first control', () => {
    render(<>
      <Keys />
      <aside data-region="sidebar"><input type="search" aria-label="Search threads" data-region-entry="2" /><div data-region-entry="1" /></aside>
      <main data-region="room" tabIndex={-1}><h1 tabIndex={-1}>Usage</h1><button type="button">Refresh</button></main>
    </>)
    f6(); expect(named('Search threads')).toHaveFocus()
    f6(); expect(named('Refresh')).toHaveFocus()
    f6(); expect(named('Search threads')).toHaveFocus()
  })

  it('visits Tools after the panes, and the Threads page\'s workspace only while it holds no pane', () => {
    const page = render(<>
      <Keys />
      <main data-region="room">
        <aside data-region="sidebar"><div data-region-entry="1"><button type="button" tabIndex={0}>Row two</button></div></aside>
        <section data-region="room">{pane('two', true)}<aside data-region="tools"><button type="button">Close tools panel</button></aside></section>
      </main>
    </>)
    named('Row two').focus()
    f6(); expect(named('transcript two')).toHaveFocus()
    f6(); expect(named('prompt two')).toHaveFocus()
    f6(); expect(named('Close tools panel')).toHaveFocus()
    f6(); expect(named('Row two')).toHaveFocus()
    page.unmount()
    render(<>
      <Keys />
      <main data-region="room">
        <aside data-region="sidebar"><div data-region-entry="1"><button type="button" tabIndex={0}>Row two</button></div></aside>
        <section data-region="room"><button type="button">New thread</button></section>
      </main>
    </>)
    named('Row two').focus()
    f6(); expect(named('New thread')).toHaveFocus()
    f6(); expect(named('Row two')).toHaveFocus()
  })

  it('does nothing while a dialog is open, leaves a terminal its F6, and stands down for dictation\'s keys', () => {
    const page = threadsPage('two')
    named('Row two').focus()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    expect(f6()).toBe(false)
    expect(named('Row two')).toHaveFocus()
    dialog.remove()
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    terminal.tabIndex = 0
    document.body.append(terminal)
    terminal.focus()
    expect(f6()).toBe(true)
    expect(terminal).toHaveFocus()
    terminal.remove()
    page.unmount()
    threadsPage('two', { hotkey: 'F6' })
    named('Row two').focus()
    expect(f6()).toBe(true)
    expect(named('Row two')).toHaveFocus()
    // Shift+F6 is its own keys, still Sotto's.
    expect(f6(true)).toBe(false)
    expect(named('prompt two')).toHaveFocus()
  })
})
