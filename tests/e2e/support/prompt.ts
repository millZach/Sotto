import { expect, type Locator, type Page } from '@playwright/test'

/** Thread fields only. Managed voice drafts, personal chats and the widget keep their textareas. */
export function promptField(scope: Page | Locator, name: 'Prompt' | 'Your answer' | 'Edit queued message' = 'Prompt'): Locator {
  return scope.getByRole('textbox', { name, exact: true })
}

export async function fillPrompt(field: Locator, text: string): Promise<void> {
  await field.fill(text)
  // Chromium's insertion precedes ProseMirror's document update. Wait for the
  // serialized draft before a spec navigates, reloads or edits another pane.
  await expectPromptText(field, text)
}

/** Visible pill text omits its sigil; this attribute preserves native tokens and exact newlines. */
export async function expectPromptText(field: Locator, text: string | RegExp, options?: { timeout?: number }): Promise<void> {
  await expect(field).toHaveAttribute('data-prompt-text', text, options)
}
