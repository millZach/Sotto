import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSidebarSize } from '../../../src/renderer/src/agents/sidebarSize'

function Probe() {
  const size = useSidebarSize()
  return <><output>{size.width} {size.collapsed ? 'collapsed' : 'expanded'}</output><button onClick={() => size.resize(400)}>Resize</button><button onClick={() => size.collapse(true)}>Collapse</button><button onClick={size.reset}>Reset</button></>
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

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
  expect(screen.getByRole('status')).toHaveTextContent('320 expanded')
  expect(JSON.parse(localStorage.getItem('sotto.threadWorkspace.sidebar')!)).toEqual({ width: 320, collapsed: false })
})
