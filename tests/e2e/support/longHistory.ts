import type { Page } from '@playwright/test'

/** Gives `threadId` sixteen messages, `<idPrefix>-0` to `<idPrefix>-15`, long enough to read back through. */
export async function longHistory(page: Page, threadId: string, idPrefix: string): Promise<void> {
  await page.evaluate(async ({ threadId, idPrefix }) => {
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', messages: Array.from({ length: 16 }, (_, index) => ({
      id: `${idPrefix}-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      text: index % 2
        ? `Reply ${(index + 1) / 2}. The preview plays a two-second sample through the selected voice, and the key stays in the system keychain rather than settings.json. Nothing else in the window changed.`
        : `Question ${index / 2 + 1}: can the preview button sit beside each voice, and can the key move into the keychain?`,
      createdAt: new Date(Date.UTC(2026, 9, 23, 9, index * 3)).toISOString() })) })
  }, { threadId, idPrefix })
}
