// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isPdfBytes, NATIVE_ATTACHMENT_BYTES, nativePdfSelection, pdfFitsNatively, pdfPageCount } from '../../../src/main/agents/pdfPages'
import { objectStreamPdf, tinyPdf } from '../../fixtures/tinyPdfs'

describe('PDF page counting for the native rule (ADR-0131)', () => {
  it('counts the pages of an uncompressed page tree', () => {
    expect(pdfPageCount(tinyPdf(1))).toBe(1)
    expect(pdfPageCount(tinyPdf(3))).toBe(3)
    expect(pdfPageCount(tinyPdf(101))).toBe(101)
  })
  it('reads a page tree with CRLF line ends, comments, strings and stream bodies around it', () => {
    expect(pdfPageCount(Buffer.from(tinyPdf(2).toString('latin1').replaceAll('\n', '\r\n'), 'latin1'))).toBe(2)
    // A page named in a comment, a string or a stream body is no page.
    const decoys = '9 0 obj\n<< /Length 15 >>\nstream\n/Type /Page >>\nendstream\nendobj\n10 0 obj\n(a /Type /Page \\) string)\nendobj\n% 11 0 obj << /Type /Page >> endobj\n'
    expect(pdfPageCount(Buffer.from(tinyPdf(1).toString('latin1').replace('xref\n', `${decoys}xref\n`), 'latin1'))).toBe(1)
  })
  it('cannot be fooled by a page named in a comment', () => {
    expect(pdfPageCount(Buffer.from('%PDF-1.4\n% /Type /Page\n%%EOF\n', 'latin1'))).toBeUndefined()
    expect(pdfPageCount(Buffer.from('%PDF-1.4\n%/Type /Pages /Count 1 /Type /Page\n%%EOF\n', 'latin1'))).toBeUndefined()
  })
  it('counts nothing when the page objects and the root page tree’s count disagree', () => {
    expect(pdfPageCount(Buffer.from(tinyPdf(2).toString('latin1').replace('/Count 2', '/Count 140'), 'latin1'))).toBeUndefined()
    expect(pdfPageCount(Buffer.from(tinyPdf(2).toString('latin1').replace('/Count 2', '/Count 1'), 'latin1'))).toBeUndefined()
    // A page tree no catalog reaches has no root count.
    expect(pdfPageCount(Buffer.from(tinyPdf(1).toString('latin1').replace(' /Root 1 0 R', ''), 'latin1'))).toBeUndefined()
    expect(pdfPageCount(tinyPdf(0))).toBeUndefined()
  })
  it('cannot count a PDF whose page tree is in a compressed object stream, an encrypted one, or bytes that are not a PDF', () => {
    const packed = objectStreamPdf()
    expect(isPdfBytes(packed)).toBe(true)
    expect(pdfPageCount(packed)).toBeUndefined()
    expect(pdfPageCount(tinyPdf(1, { encrypted: true }))).toBeUndefined()
    expect(pdfPageCount(Buffer.from('not a PDF /Type /Page'))).toBeUndefined()
    expect(pdfPageCount(Buffer.from('%PDF-1.4\n%%EOF\n'))).toBeUndefined()
    // No header at the first byte, or an object the reader cannot follow.
    expect(pdfPageCount(Buffer.from(` ${tinyPdf(1).toString('latin1')}`, 'latin1'))).toBeUndefined()
    expect(pdfPageCount(Buffer.from(tinyPdf(1).toString('latin1').replace('/MediaBox', '/Broken ) /MediaBox'), 'latin1'))).toBeUndefined()
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
