// Test-only page: the rich message components inside the real Threads layout classes and tokens.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AttachmentPreviews, MessageContent, type MessageAttachment } from '../../../src/renderer/src/agents/MessageContent'
import '../../../src/renderer/src/styles/global.css'
import '../../../src/renderer/src/agents/threads.css'

declare global {
  interface Window {
    richFixture?: { stream: (text: string, streaming: boolean) => void }
  }
}

const ANSWER = [
  'Fixed the footer links. The old `/docs/help` path is gone and every page now points at **`/help`**.',
  '',
  '## What changed',
  '',
  '1. `site/partials/footer.html` uses the new path.',
  '2. Added a redirect so bookmarks keep working.',
  '   - `/docs/help` → `/help` (301)',
  '   - `/docs/help/` → `/help` (301)',
  '3. Checked the [Netlify redirect docs](https://docs.netlify.com/routing/redirects/) for trailing slashes.',
  '',
  '| File | Change | Lines |',
  '| --- | --- | --- |',
  '| site/partials/footer.html | Footer links now use /help instead of the retired docs path | 4 |',
  '| site/_redirects | New permanent redirects for /docs/help and /docs/help/ with and without trailing slashes | 2 |',
  '| tests/links.spec.ts | Crawls every page and fails on any 404 in the footer | 38 |',
  '',
  '```ts',
  "import { test, expect } from '@playwright/test'",
  '',
  "test('footer links resolve', async ({ page, request }) => {",
  "  await page.goto('/')",
  "  const hrefs = await page.locator('footer a').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href))",
  '  for (const href of hrefs) expect((await request.get(href)).status(), href).toBeLessThan(400) // 301 is fine',
  '})',
  '```',
  '',
  '> The 404 on the help page itself came from the same stale path, so it is fixed too.',
  '',
  '- [x] Footer links updated',
  '- [x] Redirects added',
  '- [ ] Deploy preview checked',
  '',
  'Raw markup stays text: <img src=x onerror="alert(1)"> and the tracking image below is not loaded.',
  '',
  '![build badge](https://tracker.example/badge.svg)',
].join('\n')

const USER_TEXT = 'The help page is a 404 and the footer still links to the old docs path. Screenshot attached. Fix both and add a test.'

function screenshot(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 400
  const context = canvas.getContext('2d')!
  context.fillStyle = '#f5f4ef'
  context.fillRect(0, 0, 640, 400)
  context.fillStyle = '#1d1f1e'
  context.fillRect(0, 0, 640, 48)
  context.fillStyle = '#47b8a9'
  context.fillRect(24, 16, 90, 16)
  context.fillStyle = '#2b2d2c'
  context.font = 'bold 64px sans-serif'
  context.fillText('404', 250, 210)
  context.font = '20px sans-serif'
  context.fillText('Page not found', 250, 250)
  context.fillStyle = '#d9d6cc'
  context.fillRect(0, 340, 640, 60)
  context.fillStyle = '#8a877f'
  for (let index = 0; index < 5; index += 1) context.fillRect(40 + index * 116, 364, 72, 10)
  return canvas.toDataURL('image/png')
}

function Fixture() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [answer, setAnswer] = useState({ text: ANSWER, streaming: false })
  useEffect(() => {
    const dataUrl = screenshot()
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4)
    setAttachments([
      { id: 'shot', name: 'help-page-404.png', mimeType: 'image/png', sizeBytes: bytes, preview: { dataUrl } },
      { id: 'older', name: 'footer-before-redesign-with-a-very-long-descriptive-name.png', mimeType: 'image/png', sizeBytes: 2_310_000 },
      { id: 'pdf', name: 'link-audit.pdf', mimeType: 'application/pdf', sizeBytes: 184_000 },
    ])
    window.richFixture = { stream: (text, streaming) => setAnswer({ text, streaming }) }
  }, [])
  return <div className="threads-view" style={{ height: '100vh' }}>
    <aside className="thread-nav" aria-label="Threads">
      <header className="thread-nav__head"><h1>Threads</h1></header>
      <div className="thread-nav__scroll">
        <p className="thread-nav__label">Unsettled</p>
        <button type="button" className="thread-nav__item" aria-current="page"><span className="thread-nav__project"><span>sotto-site</span><time>2 min</time></span><span className="thread-nav__title">Footer links</span><span className="thread-nav__status" data-state="working"><i />Working</span></button>
        <button type="button" className="thread-nav__item"><span className="thread-nav__project"><span>workshop</span><time>12:41 pm</time></span><span className="thread-nav__title">Visual gate flake</span><span className="thread-nav__status">Done</span></button>
      </div>
    </aside>
    <section className="thread-workspace" aria-label="Thread workspace">
      <header className="thread-workspace__head"><div><span>sotto-site</span><h2>Footer links</h2></div></header>
      <div className="thread-workspace__transcript" aria-label="Thread transcript">
        <article className="thread-message" data-role="user">
          <header>You<time>12:37 pm</time></header>
          <MessageContent text={USER_TEXT} />
          <AttachmentPreviews attachments={attachments} notice="Older screenshots are kept for seven days; the PDF was sent as a file reference." />
        </article>
        <article className="thread-message" data-role="assistant">
          <header>Codex<time>12:39 pm</time></header>
          <MessageContent text={answer.text} streaming={answer.streaming} />
        </article>
      </div>
    </section>
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
