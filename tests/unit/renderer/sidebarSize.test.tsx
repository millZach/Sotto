import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultSidebarWidth, useSidebarSize } from '../../../src/renderer/src/agents/sidebarSize'

function Probe() {
  const size = useSidebarSize()
  return <><output>{size.width} {size.collapsed ? 'collapsed' : 'expanded'}</output><button onClick={() => size.resize(400)}>Resize</button><button onClick={() => size.collapse(true)}>Collapse</button><button onClick={size.reset}>Reset</button></>
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 }) })

it('keeps resizing and collapse usable when storage reads succeed but writes fail', () => {
  localStorage.clear()
  render(<Probe />)
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage is full') })
  fireEvent.click(screen.getByRole('button', { name: 'Resize' }))
  expect(screen.getByRole('status')).toHaveTextContent('400 expanded')
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
  expect(screen.getByRole('status')).toHaveTextContent('400 collapsed')
  write.mockRestore()
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(screen.getByRole('status')).toHaveTextContent('280 expanded')
  // Reset forgets the dragged width, so the sidebar follows the default again.
  expect(JSON.parse(localStorage.getItem('sotto.threadWorkspace.sidebar')!)).toEqual({ collapsed: false })
})

function atWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  fireEvent(window, new Event('resize'))
}

it('starts at 30% of the window, from 260 up to 280 pixels, and follows the window until the user drags it', () => {
  localStorage.clear()
  expect([819, 820, 900, 933, 1280, 1600].map(defaultSidebarWidth)).toEqual([260, 260, 270, 280, 280, 280])
  atWindowWidth(1600)
  render(<Probe />)
  expect(screen.getByRole('status')).toHaveTextContent('280 expanded')
  act(() => atWindowWidth(820))
  expect(screen.getByRole('status')).toHaveTextContent('260 expanded')
  // Collapsing and expanding again writes no width down, so the default still follows the window.
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
  expect(JSON.parse(localStorage.getItem('sotto.threadWorkspace.sidebar')!)).toEqual({ collapsed: true })
})

it('keeps a width the user dragged, and reads the old 320 default as no choice at all', () => {
  atWindowWidth(1600)
  localStorage.setItem('sotto.threadWorkspace.sidebar', JSON.stringify({ width: 300, collapsed: false }))
  render(<Probe />)
  expect(screen.getByRole('status')).toHaveTextContent('300 expanded')
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
  expect(JSON.parse(localStorage.getItem('sotto.threadWorkspace.sidebar')!)).toEqual({ width: 300, collapsed: true })
  cleanup()
  localStorage.setItem('sotto.threadWorkspace.sidebar', JSON.stringify({ width: 320, collapsed: false }))
  render(<Probe />)
  expect(screen.getByRole('status')).toHaveTextContent('280 expanded')
})
