import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptEditor, promptSelection, type PromptEditorElement } from '../../../src/renderer/src/agents/PromptEditor'
import { promptDocText } from '../../../src/renderer/src/agents/promptDocument'
import { promptText, setPromptSelection, setPromptText } from './helpers/promptEditor'

afterEach(cleanup)
const skills = [{ name: 'review', path: '/review' }]
function Field({ initial = '$review next\n\n', external, onChange = vi.fn() }: { initial?: string; external?: string; onChange?: (text: string) => void }) {
  const field = useRef<PromptEditorElement>(null)
  const [text, setText] = useState(initial)
  return <PromptEditor fieldRef={field} text={external ?? text} skills={skills} sigils={['$', '/']} label="Prompt" placeholder="Write here"
    onChange={value => { setText(value); onChange(value) }} onKeyDown={() => undefined} />
}

describe('the plain Tiptap prompt', () => {
  it.each([['Backspace', 7], ['Delete', 0]] as const)('%s removes the whole atom', async (key, caret) => {
    render(<Field />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    await waitFor(() => expect(prompt.querySelector('[data-skill-token]')).toHaveAttribute('data-skill-token', '$review'))
    setPromptSelection(prompt, caret)
    fireEvent.keyDown(prompt, { key })
    expect(promptText(prompt)).toBe(' next\n\n')
    expect(prompt.querySelector('[data-skill-token]')).toBeNull()
  })
  it('applies external text without echoing and leaves an unchanged caret alone', () => {
    const change = vi.fn()
    const view = render(<Field onChange={change} />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as PromptEditorElement
    setPromptSelection(prompt, 9)
    view.rerender(<Field onChange={change} />)
    expect(promptSelection(prompt.editor).selectionStart).toBe(9)
    view.rerender(<Field external={'dictated\n\n'} onChange={change} />)
    expect(promptText(prompt)).toBe('dictated\n\n')
    expect(change).not.toHaveBeenCalled()
  })
  it('pastes literal text at the caret and keeps rich HTML out of the schema', () => {
    render(<Field initial="ab" />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as PromptEditorElement
    setPromptSelection(prompt, 1)
    fireEvent.paste(prompt, { clipboardData: { items: [], getData: (type: string) => type === 'text/plain' ? '**bold**\n\n' : '<h1>bold</h1>' } })
    expect(promptText(prompt)).toBe('a**bold**\n\nb')
    expect(prompt.querySelector('strong, h1')).toBeNull()
    expect(prompt.editor.getJSON().content).toHaveLength(1)
  })
  it('offers image paste to the screenshot parent without inserting HTML', () => {
    const paste = vi.fn()
    render(<div onPaste={paste}><Field initial="" /></div>)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.paste(prompt, { clipboardData: { items: [{ kind: 'file' }], getData: () => '<img src="fake">' } })
    expect(paste).toHaveBeenCalledOnce()
    expect(promptText(prompt)).toBe('')
  })
  it.each(['type', 'paste'] as const)('keeps both pill boundaries during %s and undoes the added space with the text', async method => {
    render(<Field initial="$review" />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as PromptEditorElement
    await waitFor(() => expect(prompt.querySelector('[data-skill-token]')).toBeInTheDocument())
    const insert = (text: string): void => {
      if (method === 'type') act(() => { prompt.editor.commands.insertContent(text) })
      else fireEvent.paste(prompt, { clipboardData: { items: [], getData: () => text } })
    }
    setPromptSelection(prompt, 0)
    insert('before')
    expect(promptText(prompt)).toBe('before $review')
    setPromptSelection(prompt, 'before $review'.length)
    insert('after')
    expect(promptText(prompt)).toBe('before $review after')
    expect(prompt.querySelectorAll('[data-skill-token]')).toHaveLength(1)
    act(() => { prompt.editor.commands.undo() })
    expect(promptText(prompt)).toBe('before $review')
  })
  it('keeps valid sentence punctuation beside a pill', async () => {
    render(<Field initial="$review" />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as PromptEditorElement
    await waitFor(() => expect(prompt.querySelector('[data-skill-token]')).toBeInTheDocument())
    setPromptSelection(prompt, '$review'.length)
    act(() => { prompt.editor.commands.insertContent(', next') })
    expect(promptText(prompt)).toBe('$review, next')
    expect(prompt.querySelectorAll('[data-skill-token]')).toHaveLength(1)
  })
  it('reports pill removal even when replacing it with the same plain text', async () => {
    const change = vi.fn()
    render(<Field initial="$review" onChange={change} />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as PromptEditorElement
    await waitFor(() => expect(prompt.querySelector('[data-skill-token]')).toBeInTheDocument())
    setPromptSelection(prompt, 0, '$review'.length)
    act(() => { prompt.editor.commands.insertContent('$review') })
    expect(promptText(prompt)).toBe('$review')
    expect(prompt.querySelector('[data-skill-token]')).toBeNull()
    expect(change).toHaveBeenCalledWith('$review')
  })
  it('keeps plain typed tokens plain and supports newline and history', () => {
    render(<Field initial="" />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as PromptEditorElement
    setPromptText(prompt, '$unpicked ')
    expect(prompt.querySelector('[data-skill-token]')).toBeNull()
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true })
    expect(promptText(prompt)).toBe('$unpicked \n')
    act(() => { prompt.editor.commands.undo() })
    expect(promptDocText(prompt.editor.getJSON())).toBe('')
  })
})
