import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProjectChooser } from '../../../src/renderer/src/agents/ProjectChooser'
import { ThreadNameField } from '../../../src/renderer/src/agents/ThreadName'
import { threadsStateFixture } from './liveAgentState'

afterEach(cleanup)

describe.each([{ isComposing: true }, { keyCode: 229 }])('composition Enter %j', composition => {
  it('keeps the rename open until a separate Enter confirms it', () => {
    const onRename = vi.fn(), onDone = vi.fn()
    render(<ThreadNameField title="Old name" label="Rename thread" onRename={onRename} onDone={onDone} />)
    const input = screen.getByRole('textbox', { name: 'Rename thread' })
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter', ...composition })
    expect(onRename).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('New name')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('keeps the project chooser open until a separate Enter chooses a project', () => {
    const onChoose = vi.fn()
    const state = threadsStateFixture()
    function Chooser() {
      const chooser = useProjectChooser(state, onChoose)
      return <>{chooser.search}{chooser.choices}</>
    }
    render(<Chooser />)
    const input = screen.getByRole('searchbox', { name: 'Search projects' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter', ...composition })
    expect(onChoose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChoose).toHaveBeenCalledWith({ project: state.host.projects[0] })
  })
})
