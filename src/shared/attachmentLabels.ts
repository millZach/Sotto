import { AGENT_GENERIC_FILE_MIME_TYPE, isImageAttachment } from './agents'

/**
 * How an attachment is named in words: its type and its size. The window's tiles and pills use these, and so does the
 * note the adapters give a provider beside an attached file (ADR-0131), so both say "PDF · 2.4 MB" alike.
 */

/** The MIME types a zip archive comes with. */
export const ZIP_MIME_TYPES: ReadonlySet<string> = new Set(['application/zip', 'application/x-zip', 'application/x-zip-compressed', 'multipart/x-zip'])

/** A name's extension, lowercased and without its dot, or '' when it has none. A leading dot alone is not one. */
export function attachmentExtension(name: string): string {
  const match = /\.([^./\\]+)$/u.exec(name)
  return match && match.index > 0 ? match[1]!.toLowerCase() : ''
}

/** "PNG" from "image/png", "SVG" from "image/svg+xml": the MIME type's subtype, shortened. */
function mimeLabel(mimeType: string): string {
  const subtype = mimeType.split(';')[0]!.split('/')[1] ?? ''
  return subtype.replace(/^(?:x-|vnd\.)/u, '').split(/[+.]/u)[0]!.replace(/[^a-z0-9-]/giu, '').slice(0, 12).toUpperCase()
}

/**
 * The type a tile names an attachment by. An image keeps its MIME type's ("PNG"). A file with a generic type takes its
 * extension: `application/octet-stream` the extension, `text/plain` the extension or TXT, any zip type ZIP. Any other
 * type is named from the MIME type, unless that is longer than an extension that says it better ("DOCX", not
 * "OPENXMLFORMA"). Null with no type at all.
 */
export function fileTypeLabel(mimeType: string | undefined, name = ''): string | null {
  if (!mimeType) return null
  if (isImageAttachment(mimeType)) return mimeLabel(mimeType) || 'File'
  const extension = attachmentExtension(name).slice(0, 5).toUpperCase()
  if (ZIP_MIME_TYPES.has(mimeType)) return 'ZIP'
  if (mimeType === AGENT_GENERIC_FILE_MIME_TYPE) return extension || 'File'
  if (mimeType === 'text/plain') return extension || 'TXT'
  const label = mimeLabel(mimeType)
  return (extension && label.length > 5 ? extension : label) || extension || 'File'
}

/** "512 B", "2 KB", "2.4 MB", "25 MB": a size the way the guide gives limits. Null for no size. */
export function formatAttachmentSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`
}
