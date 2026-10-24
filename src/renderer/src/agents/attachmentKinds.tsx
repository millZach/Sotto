import React, { type ReactNode } from 'react'
import { File as FileIcon, FileArchive, FileCode, FileText, Image as ImageIcon } from 'lucide-react'
import { AGENT_GENERIC_FILE_MIME_TYPE, isImageAttachment } from '../../../shared/agents'

/** What an attachment is to look at: an image, or a file of text, an archive, code, or anything else (ADR-0127). */
export type AttachmentKind = 'image' | 'text' | 'archive' | 'code' | 'file'

const ARCHIVES = new Set(['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'xz', 'bz2', 'zst'])
const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rs', 'go', 'sh', 'ps1', 'swift', 'kt', 'java', 'c', 'h', 'cpp', 'cs', 'rb',
  'php', 'css', 'scss', 'html', 'xml', 'yml', 'yaml', 'toml', 'sql', 'lua'])
const TEXT = new Set(['pdf', 'txt', 'md', 'log', 'csv', 'tsv', 'doc', 'docx', 'rtf', 'odt'])
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip', 'application/x-zip-compressed', 'multipart/x-zip'])
const ARCHIVE_TYPES = new Set([...ZIP_TYPES, 'application/gzip', 'application/x-gzip', 'application/x-tar', 'application/x-7z-compressed',
  'application/vnd.rar', 'application/x-rar-compressed', 'application/x-xz', 'application/x-bzip2', 'application/zstd'])
const CODE_TYPES = new Set(['application/json', 'application/javascript', 'text/javascript', 'application/xml', 'text/xml', 'text/html', 'text/css',
  'application/x-sh', 'application/x-python-code', 'application/toml', 'application/yaml', 'application/sql'])

/** A name's extension, lowercased and without its dot, or '' when it has none. A leading dot alone is not one. */
export function attachmentExtension(name: string): string {
  const match = /\.([^./\\]+)$/u.exec(name)
  return match && match.index > 0 ? match[1]!.toLowerCase() : ''
}

/** What an attachment is, by its extension first and its MIME type after: the extension is what the person named. */
export function attachmentKind(name: string, mimeType: string | undefined): AttachmentKind {
  if (mimeType && isImageAttachment(mimeType)) return 'image'
  const extension = attachmentExtension(name)
  if (ARCHIVES.has(extension)) return 'archive'
  if (CODE.has(extension)) return 'code'
  if (TEXT.has(extension)) return 'text'
  const type = mimeType ?? ''
  if (ARCHIVE_TYPES.has(type)) return 'archive'
  if (CODE_TYPES.has(type) || type.startsWith('text/x-')) return 'code'
  if (type === 'application/pdf' || type.startsWith('text/')) return 'text'
  return 'file'
}

/** The type icon for an attachment's kind. */
export function AttachmentKindIcon({ kind, size }: { readonly kind: AttachmentKind; readonly size: number }): ReactNode {
  const Icon = kind === 'image' ? ImageIcon : kind === 'text' ? FileText : kind === 'archive' ? FileArchive : kind === 'code' ? FileCode : FileIcon
  return <Icon size={size} aria-hidden="true" />
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
  if (ZIP_TYPES.has(mimeType)) return 'ZIP'
  if (mimeType === AGENT_GENERIC_FILE_MIME_TYPE) return extension || 'File'
  if (mimeType === 'text/plain') return extension || 'TXT'
  const label = mimeLabel(mimeType)
  return (extension && label.length > 5 ? extension : label) || extension || 'File'
}

/**
 * A name as a head that may be cut and a tail that is always shown, so the extension stays visible: "quarterly-rep…ort.pdf"
 * rather than "quarterly-report-fin…". The tail is the extension and the four characters before it, or the last six.
 */
export function splitAttachmentName(name: string): readonly [head: string, tail: string] {
  const dot = name.lastIndexOf('.')
  const keep = dot > 0 ? Math.min(name.length, name.length - dot + 4) : Math.min(name.length, 6)
  return [name.slice(0, name.length - keep), name.slice(name.length - keep)]
}
