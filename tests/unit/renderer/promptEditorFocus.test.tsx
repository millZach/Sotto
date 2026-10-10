import React, { useRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PromptEditor, type PromptEditorElement } from '../../../src/renderer/src/agents/PromptEditor'
import { promptText } from './helpers/promptEditor'

afterEach(cleanup)

function Field({ editable }: { editable: boolean }) {
  const field = useRef<PromptEditorElement>(null)
  return <PromptEditor fieldRef={field} text="Keep this draft" skills={[]} sigils={['$']} label="Prompt" editable={editable}
    onChange={() => undefined} onKeyDown={() => undefined} />
}

it('keeps the prompt keyboard-focusable while a permission makes it read-only', () => {
  const view = render(<Field editable={false} />)
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  expect(prompt).toHaveAttribute('tabindex', '0')
  prompt.focus()
  expect(prompt).toHaveFocus()
  expect(prompt).toHaveAttribute('contenteditable', 'false')
  expect(promptText(prompt)).toBe('Keep this draft')
  view.rerender(<Field editable />)
  expect(prompt).toHaveFocus()
  view.rerender(<Field editable={false} />)
  expect(prompt).toHaveFocus()
  expect(promptText(prompt)).toBe('Keep this draft')
})
