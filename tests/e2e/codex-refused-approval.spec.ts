import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { startCodexThread, withNativeCodexFixture } from './support/nativeCodexFixture'
import { openThreads } from './support/sottoLaunch'

test('Codex shows a refused child approval without approving or routing it', async () => {
  await withNativeCodexFixture('sotto-e2e-codex-refusal-', { reply: 'Ready for the next request.' }, async ({ launched, root }) => {
    const { page } = launched
    await startCodexThread(page, root, { project: 'Approval notice', thread: 'Child approval', prompt: 'Start the session.' })
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Child approval', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Ready for the next request.')
    // A previous command error must not mask the later refused-approval notice.
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      const state = await agents.get()
      const result = await agents.command({ type: 'configure-thread', threadId: state.activeThreadId!, modelId: 'missing-model' })
      if (!result.error) throw new Error('The synthetic invalid model was not refused')
    })
    const native = Object.values(JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')).threads)[0] as { id: string }
    await writeFile(join(root, 'codex', 'control.json'), JSON.stringify({ id: randomUUID(), threadId: native.id,
      type: 'permission', text: 'Build?', params: { threadId: 'unknown-child' } }))
    const notice = page.getByRole('alert').filter({ hasText: 'Codex asked for an approval Sotto could not show' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('The request was refused. Nothing was approved.')
    await expect(page.locator('.agent-request')).toHaveCount(0)
    const frames = JSON.parse(`[${(await readFile(join(root, 'codex', 'requests.jsonl'), 'utf8')).trim().split('\n').join(',')}]`) as { error?: { code?: number }; result?: { decision?: string } }[]
    expect(frames.some(frame => frame.error?.code === -32601)).toBe(true)
    expect(frames.some(frame => frame.result?.decision?.startsWith('accept'))).toBe(false)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await launched.app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setContentSize(size[0]!, size[1]!)
        }, [width!, height!])
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await expect(notice).toBeVisible()
        const bounds = await notice.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
            overflow: document.documentElement.scrollWidth - innerWidth }
        })
        expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.width)
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.height); expect(bounds.overflow).toBe(0)
        await page.screenshot({ path: test.info().outputPath(`refusal-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(notice).toBeVisible()
  })
})
