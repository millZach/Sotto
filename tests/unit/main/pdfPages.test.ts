// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isPdfBytes, NATIVE_ATTACHMENT_BYTES, nativePdfSelection, pdfFitsNatively, pdfPageCount } from '../../../src/main/agents/pdfPages'
import { objectStreamPdf, tinyPdf } from '../../fixtures/tinyPdfs'

describe('PDF page counting for the native rule (ADR-0127)', () => {
  it('counts the pages of an uncompressed page tree', () => {
    expect(pdfPageCount(tinyPdf(1))).toBe(1)
    expect(pdfPageCount(tinyPdf(3))).toBe(3)
    expect(pdfPageCount(tinyPdf(101))).toBe(101)
  })
  it('takes the larger of the page objects and the page tree’s count, since an update can leave pages behind', () => {
    const bytes = Buffer.from(tinyPdf(2).toString('latin1').replace('/Count 2', '/Count 140'), 'latin1')
    expect(pdfPageCount(bytes)).toBe(140)
  })
  it('cannot count a PDF whose page tree is in a compressed object stream, an encrypted one, or bytes that are not a PDF', () => {
    const packed = objectStreamPdf()
    expect(isPdfBytes(packed)).toBe(true)
    expect(pdfPageCount(packed)).toBeUndefined()
    expect(pdfPageCount(tinyPdf(1, { encrypted: true }))).toBeUndefined()
    expect(pdfPageCount(Buffer.from('not a PDF /Type /Page'))).toBeUndefined()
    expect(pdfPageCount(Buffer.from('%PDF-1.4\n%%EOF\n'))).toBeUndefined()
  })
  it('sends natively only a counted PDF of at most 100 pages', () => {
    expect(pdfFitsNatively(1)).toBe(true)
    expect(pdfFitsNatively(100)).toBe(true)
    expect(pdfFitsNatively(101)).toBe(false)
    expect(pdfFitsNatively(undefined)).toBe(false)
    expect(nativePdfSelection(0, [tinyPdf(100), tinyPdf(101), objectStreamPdf()])).toEqual([true, false, false])
  })
  it('keeps a message’s native bytes, images included, within 20 MiB, in the order the PDFs were attached', () => {
    const small = tinyPdf(1)
    expect(NATIVE_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024)
    expect(nativePdfSelection(NATIVE_ATTACHMENT_BYTES - small.length, [small, small])).toEqual([true, false])
    expect(nativePdfSelection(NATIVE_ATTACHMENT_BYTES - small.length + 1, [small])).toEqual([false])
    // One that does not fit leaves its room to a smaller one after it.
    const padded = Buffer.concat([small, Buffer.alloc(2 * 1024 * 1024)])
    expect(nativePdfSelection(NATIVE_ATTACHMENT_BYTES - 1024 * 1024, [padded, small])).toEqual([false, true])
  })
})
