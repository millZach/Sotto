import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWhereFit } from '../../../../src/renderer/src/agents/headerWhereFit'

/** The header's box as ThreadPane draws it: the project in the crumb, then the branch's name in the toolbar's slot. */
function Where(): React.ReactElement {
  const fit = useWhereFit()
  return <span className="thread-workspace__where" ref={fit} data-testid="where">
    <span className="thread-workspace__crumb"><span data-testid="project">sotto</span></span>
    <span className="thread-workspace__branches"><button type="button" className="branch-toolbar__branch"><span data-testid="branch">feat/thread-store-worker</span></button></span>
  </span>
}

let resized: Array<() => void> = []
const room = { branch: 160, project: 40 }

beforeEach(() => {
  resized = []
  room.branch = 160
  vi.stubGlobal('ResizeObserver', class { constructor(private readonly callback: () => void) { resized.push(callback) } observe(): void {} disconnect(): void {} })
  // jsdom lays nothing out, so the branch's name is as wide as the room it is given and the project as wide as its words.
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.testid === 'branch' ? 170 : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid !== 'branch') return 0
    const where = this.closest('[data-testid="where"]')!
    return where.hasAttribute('data-crowded') ? room.branch + room.project : room.branch
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'project' && !this.closest('[data-crowded]') ? room.project : 0
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('a pane header\'s project and branch', () => {
  it('lets the project leave when the branch\'s name would be cut beside it', () => {
    const { getByTestId } = render(<Where />)
    expect(getByTestId('where')).toHaveAttribute('data-crowded')
  })

  it('brings the project back once both fit', () => {
    const { getByTestId } = render(<Where />)
    room.branch = 200
    act(() => { for (const callback of resized) callback() })
    expect(getByTestId('where')).not.toHaveAttribute('data-crowded')
  })
})
