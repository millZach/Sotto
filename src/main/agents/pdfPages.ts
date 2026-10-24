import { AGENT_MAX_ATTACHMENT_BYTES } from '../../shared/agents'

/**
 * Whether a PDF may also go to a provider as part of the prompt itself (ADR-0127), beside its copy in the working folder.
 * A PDF block Claude cannot read stays in its session and fails every later turn, so this is conservative: a PDF goes
 * natively only when its page count can be read from its uncompressed page tree and is at most 100, and only while the
 * message's native bytes, images included, stay within 20 MiB. Anything else goes by path alone.
 */

/** The most pages a PDF sent as part of the prompt may have: Anthropic's limit under a 200K context. */
export const NATIVE_PDF_MAX_PAGES = 100
/** The most bytes one message's images and native PDFs may hold between them, which keeps a Claude request under 32 MB. */
export const NATIVE_ATTACHMENT_BYTES = AGENT_MAX_ATTACHMENT_BYTES

const PDF_SIGNATURE = '%PDF-'

/** Whether these bytes start as a PDF does. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PDF_SIGNATURE.length && Buffer.from(bytes.buffer, bytes.byteOffset, PDF_SIGNATURE.length).toString('latin1') === PDF_SIGNATURE
}

/**
 * A PDF's page count, read from its uncompressed page tree: the `/Type /Page` objects and the largest `/Count` of a
 * `/Type /Pages` node, whichever is larger, since an incremental update can leave pages behind that no longer count.
 * Undefined when it cannot be read: not a PDF, encrypted, any object kept in a compressed object stream (where page
 * objects may hide), or no page object in sight.
 */
export function pdfPageCount(bytes: Uint8Array): number | undefined {
  if (!isPdfBytes(bytes)) return undefined
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  if (/\/Encrypt(?![A-Za-z0-9])/u.test(text) || /\/Type\s*\/ObjStm(?![A-Za-z0-9])/u.test(text)) return undefined
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z0-9])/gu)?.length ?? 0
  if (!pages) return undefined
  let count = 0
  for (const object of text.matchAll(/\bobj\b([\s\S]*?)\bendobj\b/gu)) {
    const body = object[1]!
    if (!/\/Type\s*\/Pages(?![A-Za-z0-9])/u.test(body)) continue
    const value = /\/Count\s+(\d{1,9})(?!\d)/u.exec(body)
    if (value) count = Math.max(count, Number(value[1]))
  }
  return Math.max(pages, count)
}

/** Whether a PDF of this many pages may go natively. */
export function pdfFitsNatively(pages: number | undefined): boolean {
  return pages !== undefined && pages >= 1 && pages <= NATIVE_PDF_MAX_PAGES
}

/**
 * Which of a message's PDFs go natively, in the order attached: each whose page count fits, while the images'
 * `imageBytes` and the PDFs taken before it leave room for it under `NATIVE_ATTACHMENT_BYTES`.
 */
export function nativePdfSelection(imageBytes: number, pdfs: readonly Uint8Array[]): boolean[] {
  let used = imageBytes
  return pdfs.map(bytes => {
    if (used + bytes.byteLength > NATIVE_ATTACHMENT_BYTES || !pdfFitsNatively(pdfPageCount(bytes))) return false
    used += bytes.byteLength
    return true
  })
}
