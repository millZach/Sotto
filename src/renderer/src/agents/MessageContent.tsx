import React, { createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Element, ElementContent, Root } from 'hast'
import { Check, Copy, FileText, Image as ImageIcon } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { common, createLowlight } from 'lowlight'
import { agentAttachmentPreviewSchema, type AgentAttachmentReference } from '../../../shared/agents'
import { externalLinkSchema } from '../../../shared/externalLinks'
import './rich-messages.css'

/** Anything the Threads page can show for one attachment: a full reference, or the `{ id, name }` of a pending send. */
export type MessageAttachment = Pick<AgentAttachmentReference, 'id' | 'name'>
  & Partial<Pick<AgentAttachmentReference, 'mimeType' | 'sizeBytes' | 'preview'>>

export interface MessageContentProps {
  readonly text: string
  /** The provider is still writing this message. */
  readonly streaming?: boolean
  /** Opens a vetted absolute http:, https: or mailto: URL. Defaults to the main-process `openExternalLink` bridge. */
  readonly onOpenLink?: (url: string) => Promise<LinkOpenResult> | LinkOpenResult
}

export interface AttachmentPreviewsProps {
  readonly attachments: readonly MessageAttachment[]
  /** One provider limit or unsupported note, shown under the attachments. */
  readonly notice?: string
}

export type LinkOpenResult = Readonly<{ ok: boolean }>

/** Code longer than this is shown without highlighting so a huge paste cannot stall the transcript. */
export const MAX_HIGHLIGHTED_CODE_LENGTH = 20_000
const FEEDBACK_MS = 1_600
const lowlight = createLowlight(common)
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
// Bidirectional overrides can make "gpj.exe" read as "exe.jpg".
const BIDI_CONTROLS = /\p{Bidi_Control}/gu

/** An absolute http, https or mailto URL the main process will open, or null. */
export function safeLinkUrl(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  if (!/^(?:https?|mailto):/iu.test(value)) return null
  try {
    const url = new URL(value)
    if (!LINK_PROTOCOLS.has(url.protocol)) return null
    return externalLinkSchema.safeParse(value).success && externalLinkSchema.safeParse(url.href).success ? url.href : null
  } catch { return null }
}

function linkLabel(url: string): string {
  return url.startsWith('mailto:') ? url.slice('mailto:'.length).split('?')[0]! : new URL(url).host
}

async function openWithBridge(url: string): Promise<LinkOpenResult> {
  const open = window.sotto?.openExternalLink
  return open ? open(url) : { ok: false }
}

export function formatAttachmentSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`
}

export function attachmentTypeLabel(mimeType: string | undefined): string | null {
  if (!mimeType) return null
  const subtype = mimeType.split(';')[0]!.split('/')[1] ?? ''
  const label = subtype.replace(/^(?:x-|vnd\.)/u, '').split(/[+.]/u)[0]!.replace(/[^a-z0-9-]/giu, '').slice(0, 12).toUpperCase()
  return label || 'File'
}

const validatedPreviews = new Map<string, boolean>()
const VALIDATED_PREVIEW_CACHE = 48

/** The preview as an image source only when it is a validated raster data URL. */
export function trustedPreviewSource(attachment: MessageAttachment): string | null {
  const dataUrl = attachment.preview?.dataUrl
  if (typeof dataUrl !== 'string') return null
  let valid = validatedPreviews.get(dataUrl)
  if (valid === undefined) {
    valid = agentAttachmentPreviewSchema.safeParse({ dataUrl }).success
    if (validatedPreviews.size >= VALIDATED_PREVIEW_CACHE) validatedPreviews.delete(validatedPreviews.keys().next().value!)
    validatedPreviews.set(dataUrl, valid)
  }
  return valid ? dataUrl : null
}

const LinkContext = createContext<{ open: (url: string) => void }>({ open: () => undefined })

function hastText(node: ElementContent | Element | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(child => hastText(child as ElementContent)).join('') : ''
}

function hastToReact(nodes: readonly ElementContent[], prefix = 'h'): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value
    if (node.type !== 'element') return null
    const className = Array.isArray(node.properties.className) ? node.properties.className.join(' ') : undefined
    return <span key={`${prefix}${index}`} className={className}>{hastToReact(node.children, `${prefix}${index}-`)}</span>
  })
}

function highlight(code: string, language: string | undefined): ReactNode {
  if (!language || code.length > MAX_HIGHLIGHTED_CODE_LENGTH || !lowlight.registered(language)) return code
  try {
    const tree: Root = lowlight.highlight(language, code)
    return hastToReact(tree.children as ElementContent[])
  } catch { return code }
}

function useTransientFlag(): [string | null, (value: string) => void] {
  const [value, setValue] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current)
    setValue(next)
    timer.current = setTimeout(() => { setValue(null); timer.current = null }, FEEDBACK_MS)
  }, [])
  return [value, show]
}

async function writeClipboard(text: string): Promise<void> {
  // The production renderer deliberately denies browser clipboard permission.
  // Use the same main-owned, copy-only output path as the History page.
  if (window.sotto?.deliverOutput) {
    const result = await window.sotto.deliverOutput({ text, autoPaste: false, pasteDelayMs: 50 })
    if (result !== 'copied') throw new Error('Clipboard unavailable')
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(text)
}

const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: string | undefined }) {
  const [feedback, showFeedback] = useTransientFlag()
  const highlighted = useMemo(() => highlight(code, language), [code, language])
  const label = language ? language.slice(0, 24) : 'Code'
  const copy = (): void => { void writeClipboard(code).then(() => showFeedback('Copied'), () => showFeedback('Copy failed')) }
  return <div className="rich-code" data-language={language}>
    <div className="rich-code__bar">
      <span className="rich-code__language">{label}</span>
      <span className="rich-code__status" role="status" aria-live="polite">{feedback}</span>
      <button type="button" className="rich-code__copy tt-focusable" data-copied={feedback === 'Copied' || undefined}
        aria-label={`Copy ${language ? `${label} ` : ''}code`} title="Copy code" onClick={copy}>
        {feedback === 'Copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </button>
    </div>
    <pre className="rich-code__scroll" tabIndex={0} aria-label={`${label} code block`}><code className={language ? `hljs language-${language}` : 'hljs'}>{highlighted}</code></pre>
  </div>
})

function MarkdownLink({ href, title, children }: { href?: string | undefined; title?: string | undefined; children?: ReactNode }): ReactNode {
  const { open } = useContext(LinkContext)
  const url = safeLinkUrl(href)
  if (!url) return <span className="rich-link rich-link--inert" title={href ? `Not a web link: ${href}` : undefined}>{children}</span>
  return <a className="rich-link tt-focusable" href={url} rel="noopener noreferrer" target="_blank" title={title || url}
    onClick={event => { event.preventDefault(); open(url) }}
    onAuxClick={event => event.preventDefault()}>{children}</a>
}

function BlockedImage({ src, alt }: { src?: string | undefined; alt?: string | undefined }): ReactNode {
  const url = safeLinkUrl(src)
  const host = url && !url.startsWith('mailto:') ? new URL(url).host : null
  return <span className="rich-image-blocked" role="img" aria-label={`Image not loaded${alt ? `: ${alt}` : ''}`}>
    <ImageIcon size={14} aria-hidden="true" /><span>{alt || 'Image'}</span><small>{host ? `not loaded from ${host}` : 'not loaded'}</small>
  </span>
}

const heading = (level: 3 | 4 | 5 | 6, rank: number) => function Heading({ children }: { children?: ReactNode }) {
  const Tag = `h${level}` as const
  return <Tag className={`rich-heading rich-heading--${rank}`}>{children}</Tag>
}

// Every URL-bearing element is rendered by a component below, which vets it before it reaches the DOM.
const urlTransform: UrlTransform = (url, key, node) =>
  (node.tagName === 'a' && key === 'href') || (node.tagName === 'img' && key === 'src') ? url : defaultUrlTransform(url)

const components: Components = {
  a: ({ href, title, children }) => <MarkdownLink href={href} title={title}>{children}</MarkdownLink>,
  img: ({ src, alt }) => <BlockedImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  pre: ({ node }) => {
    const code = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code')
    const classes = Array.isArray(code?.properties.className) ? code.properties.className.map(String) : []
    const language = classes.find(name => name.startsWith('language-'))?.slice('language-'.length)
    return <CodeBlock code={hastText(code).replace(/\n$/u, '')} language={language} />
  },
  table: ({ children }) => <div className="rich-table tt-focusable" role="region" aria-label="Table" tabIndex={0}><table>{children}</table></div>,
  input: ({ type, checked }) => type === 'checkbox'
    ? <input className="rich-task" type="checkbox" checked={checked === true} disabled readOnly aria-label={checked ? 'Done' : 'Not done'} />
    : null,
  h1: heading(3, 1), h2: heading(4, 2), h3: heading(5, 3), h4: heading(6, 4), h5: heading(6, 5), h6: heading(6, 6),
}
const remarkPlugins = [remarkGfm]

/** Renders one message's text as safe Markdown. Raw HTML stays literal text; only vetted web links are links. */
export const MessageContent = memo(function MessageContent({ text, streaming = false, onOpenLink }: MessageContentProps): ReactNode {
  const deferredText = useDeferredValue(text)
  const [failedLink, setFailedLink] = useState<string | null>(null)
  const [copyFeedback, showCopyFeedback] = useTransientFlag()
  const opener = useRef(onOpenLink ?? openWithBridge)
  opener.current = onOpenLink ?? openWithBridge
  const context = useMemo(() => ({
    open: (url: string) => {
      setFailedLink(null)
      void Promise.resolve().then(() => opener.current(url)).then(
        result => { if (!result.ok) setFailedLink(url) },
        () => setFailedLink(url),
      )
    },
  }), [])
  const copyFailedLink = (): void => {
    if (!failedLink) return
    void writeClipboard(failedLink).then(() => { setFailedLink(null); showCopyFeedback('Link copied') }, () => showCopyFeedback('Could not copy the link'))
  }
  const rendered = useMemo(() => <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>{deferredText}</ReactMarkdown>, [deferredText])
  return <LinkContext.Provider value={context}>
    <div className="rich-message" data-streaming={streaming || undefined} aria-busy={streaming || undefined}>
      {rendered}
      <div className="rich-message__feedback" role="status" aria-live="polite">
        {failedLink ? <><span>Could not open {linkLabel(failedLink)}.</span><button type="button" className="rich-message__feedback-action tt-focusable" onClick={copyFailedLink}>Copy link</button></> : copyFeedback}
      </div>
    </div>
  </LinkContext.Provider>
})

function AttachmentTile({ attachment }: { attachment: MessageAttachment }): ReactNode {
  const dataUrl = attachment.preview?.dataUrl
  const source = useMemo(() => trustedPreviewSource({ id: '', name: '', ...(dataUrl === undefined ? {} : { preview: { dataUrl } }) }), [dataUrl])
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  const name = attachment.name.replace(BIDI_CONTROLS, '') || 'Attachment'
  const isImage = attachment.mimeType?.startsWith('image/') ?? false
  const details = [attachmentTypeLabel(attachment.mimeType), formatAttachmentSize(attachment.sizeBytes)].filter(Boolean).join(' · ')
  if (source && !failed) return <figure className="rich-attachment rich-attachment--image" role="listitem">
    <div className="rich-attachment__frame"><img src={source} alt={name} decoding="async" draggable={false} onError={() => setFailed(true)} /></div>
    <figcaption><span className="rich-attachment__name" title={name}>{name}</span>{details && <span className="rich-attachment__meta">{details}</span>}</figcaption>
  </figure>
  const reason = !attachment.mimeType ? null : !isImage ? 'No preview for this file type' : failed ? 'Preview could not be shown' : 'Preview unavailable'
  return <div className="rich-attachment rich-attachment--file" role="listitem">
    {isImage || !attachment.mimeType ? <ImageIcon size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
    <span className="rich-attachment__text">
      <span className="rich-attachment__name" title={name}>{name}</span>
      {(details || reason) && <span className="rich-attachment__meta">{[details, reason].filter(Boolean).join(' · ')}</span>}
    </span>
  </div>
}

/** Submitted images with their name, type and size; metadata alone when no trusted preview exists. */
export function AttachmentPreviews({ attachments, notice }: AttachmentPreviewsProps): ReactNode {
  if (!attachments.length && !notice) return null
  return <div className="rich-attachments">
    {!!attachments.length && <div className="rich-attachments__list" role="list" aria-label={attachments.length === 1 ? 'Attachment' : `${attachments.length} attachments`}>
      {attachments.map(attachment => <AttachmentTile key={attachment.id} attachment={attachment} />)}
    </div>}
    {notice && <p className="rich-attachments__notice" role="note">{notice}</p>}
  </div>
}
