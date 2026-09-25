import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAttachment } from '../../src/shared/agents'
import { ScreenshotInput } from '../../src/renderer/src/agents/ScreenshotInput'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const MB = 1024 * 1024
const RUNS = 5

interface Counts { readers: number; encodedChars: number }

/** Counts every FileReader the input makes and the base64 characters those readers hand back. */
function countReaders(): Counts {
  const counts: Counts = { readers: 0, encodedChars: 0 }
  const Original = globalThis.FileReader
  class CountingReader extends Original {
    constructor() {
      super()
      counts.readers += 1
      this.addEventListener('load', () => { counts.encodedChars += String(this.result).length })
    }
  }
  vi.stubGlobal('FileReader', CountingReader)
  return counts
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/** A PNG-typed file of `bytes` zero bytes; the input checks type and size, not the signature. */
function screenshot(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

/** An attachment already on the composer whose decoded size is `bytes`. */
function attached(id: string, bytes: number): AgentAttachment {
  return { id, name: `${id}.png`, mimeType: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(bytes / 3 * 4)}` }
}

/** Drops `files` on the input and times the wait until the refusal (`refusal`) appears. */
async function refusedDrop(files: File[], attachments: AgentAttachment[], refusal: RegExp): Promise<{ ms: number, counts: Counts }> {
  const counts = countReaders()
  render(<ScreenshotInput attachments={attachments} onChange={() => undefined} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
  const started = performance.now()
  fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files, types: ['Files'] } })
  await screen.findByText(refusal)
  const ms = performance.now() - started
  cleanup()
  vi.unstubAllGlobals()
  return { ms, counts }
}

const TOTAL = /must total 20 MB or less/u

async function measure(label: string, files: File[], attachments: AgentAttachment[], refusal = TOTAL) {
  await refusedDrop(files, attachments, refusal) // warm run
  const runs = []
  for (let index = 0; index < RUNS; index += 1) runs.push(await refusedDrop(files, attachments, refusal))
  const report = {
    label,
    droppedMB: Number((files.reduce((sum, file) => sum + file.size, 0) / MB).toFixed(1)),
    medianMs: Number(median(runs.map(run => run.ms)).toFixed(2)),
    readers: runs[0]!.counts.readers,
    encodedMB: Number((runs[0]!.counts.encodedChars / MB).toFixed(1)),
  }
  console.log(`screenshot total refusal: ${JSON.stringify(report)}`)
  return report
}

// Reads real multi-megabyte files through jsdom, so it stays out of the default run.
describe.skipIf(process.env.SOTTO_PERF_SCREENSHOTS !== '1')('refusing screenshots that total more than 20 MB', () => {
  it('floor: nine small screenshots, refused by count before any read on every version', async () => {
    const files = Array.from({ length: 9 }, (_, index) => screenshot(`${index}.png`, 8))
    const report = await measure('floor: 9 x 8 B refused by count', files, [], /Attach up to 8 screenshots/u)
    expect(report.readers).toBe(0)
  })
  it('three 8 MB screenshots dropped at once', async () => {
    const files = [screenshot('a.png', 8 * MB), screenshot('b.png', 8 * MB), screenshot('c.png', 8 * MB)]
    const report = await measure('3 x 8 MB dropped', files, [])
    expect(report.medianMs).toBeGreaterThan(0)
  })
  it('one 6 MB screenshot dropped beside two 8 MB ones already attached', async () => {
    const report = await measure('6 MB beside 2 x 8 MB attached', [screenshot('d.png', 6 * MB)], [attached('kept-a', 8 * MB), attached('kept-b', 8 * MB)])
    expect(report.medianMs).toBeGreaterThan(0)
  })
})
