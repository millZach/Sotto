import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Element, ElementContent, Root } from 'hast'
import { Check, Copy, FileText, Image as ImageIcon } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { common, createLowlight } from 'lowlight'
import { agentAttachmentPreviewSchema, type AgentAttachmentReference } from '../../../shared/agents'
import { externalLinkSchema } from '../../../shared/externalLinks'
import { MermaidDiagram } from './diagrams/MermaidDiagram'
import { isFenceClosed } from './diagrams/diagramSource'
import { useTransientFlag, writeClipboard } from './richActions'
import { LinkMenu, useWebLinkRouter, type LinkMenuItem, type WebLinkDestination, type WebLinkResult } from '../tools/webLinks'
import './rich-messages.css'

/** Anything the Threads page can show for one attachment: a full reference, or the `{ id, name }` of a pending send. */
export type MessageAttachment = Pick<AgentAttachmentReference, 'id' | 'name'>
  & Partial<Pick<AgentAttachmentReference, 'mimeType' | 'sizeBytes' | 'preview'>>

export interface MessageContentProps {
  readonly text: string
  /** The provider is still writing this message. */
  readonly streaming?: boolean
  /** Opens a vetted absolute http:, https: or mailto: URL. Defaults to the surrounding link router: a thread's browser setting, else the system browser. */
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

interface LinkActions {
  readonly open: (url: string, destination?: WebLinkDestination) => void
  readonly menu: (url: string, anchor: HTMLElement, at: { x: number; y: number }) => void
}
const LinkContext = createContext<LinkActions>({ open: () => undefined, menu: () => undefined })
/** The Markdown being rendered, so a fenced diagram can tell whether its closing fence has arrived. */
const MarkdownSourceContext = createContext<{ text: string; streaming: boolean }>({ text: '', streaming: false })

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

function DiagramBlock({ source, start, end }: { source: string; start: number | undefined; end: number | undefined }): ReactNode {
  const { text, streaming } = useContext(MarkdownSourceContext)
  // A finished message draws whatever it holds; a streaming one waits for the closing fence.
  const complete = !streaming || (start !== undefined && end !== undefined && isFenceClosed(text.slice(start, end)))
  return <MermaidDiagram source={source} complete={complete} />
}

function MarkdownLink({ href, title, children }: { href?: string | undefined; title?: string | undefined; children?: ReactNode }): ReactNode {
  const { open, menu } = useContext(LinkContext)
  const url = safeLinkUrl(href)
  // The reason is read with the text, not only on hover, so keyboard and screen reader users get it too.
  if (!url) return <span className="rich-link rich-link--inert" title={href ? `Not a web link: ${href}` : undefined}>{children}{href ? <span className="tt-visually-hidden"> (link not opened: not a web address)</span> : null}</span>
  return <a className="rich-link tt-focusable" href={url} rel="noopener noreferrer" target="_blank" title={title || url}
    onClick={event => { event.preventDefault(); open(url) }}
    onAuxClick={event => event.preventDefault()}
    onContextMenu={event => {
      event.preventDefault()
      // A keyboard-invoked context menu reports no pointer position, so it opens beside the link.
      const rect = event.currentTarget.getBoundingClientRect()
      menu(url, event.currentTarget, event.clientX === 0 && event.clientY === 0 ? { x: rect.left, y: rect.bottom + 4 } : { x: event.clientX, y: event.clientY })
    }}
    onKeyDown={event => {
      if (!(event.key === 'F10' && event.shiftKey) && event.key !== 'ContextMenu') return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      menu(url, event.currentTarget, { x: rect.left, y: rect.bottom + 4 })
    }}>{children}</a>
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
    const source = hastText(code).replace(/\n$/u, '')
    if (language?.toLowerCase() === 'mermaid') return <DiagramBlock source={source} start={node?.position?.start.offset} end={node?.position?.end.offset} />
    return <CodeBlock code={source} language={language} />
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
  const [failedLink, setFailedLink] = useState<string | null>(null)
  const [linkNotice, setLinkNotice] = useState<string | null>(null)
  const [linkMenu, setLinkMenu] = useState<{ url: string; anchor: HTMLElement; at: { x: number; y: number } } | null>(null)
  const [copyFeedback, showCopyFeedback] = useTransientFlag()
  const router = useWebLinkRouter()
  const opener = useRef<(url: string, destination?: WebLinkDestination) => Promise<WebLinkResult> | WebLinkResult>(openWithBridge)
  opener.current = onOpenLink ?? ((url, destination) => router.open(url, destination))
  const context = useMemo<LinkActions>(() => ({
    open: (url, destination) => {
      setFailedLink(null)
      setLinkNotice(null)
      void Promise.resolve().then(() => destination === undefined ? opener.current(url) : opener.current(url, destination)).then(
        result => { if (!result.ok) { setFailedLink(url); setLinkNotice(result.message ?? null) } else setLinkNotice(result.message ?? null) },
        () => setFailedLink(url),
      )
    },
    menu: (url, anchor, at) => setLinkMenu({ url, anchor, at }),
  }), [])
  const menuItems = (url: string): LinkMenuItem[] => {
    const web = !url.startsWith('mailto:')
    return [
      ...(web && router.canEmbed && !onOpenLink ? [{ id: 'embedded', label: 'Open in Sotto browser', run: () => context.open(url, 'embedded') }] : []),
      { id: 'external', label: web ? 'Open in system browser' : 'Open in mail app', run: () => context.open(url, 'external') },
      { id: 'copy', label: web ? 'Copy link' : 'Copy address', run: () => { void writeClipboard(web ? url : linkLabel(url)).then(() => showCopyFeedback('Link copied'), () => showCopyFeedback('Could not copy the link')) } },
    ]
  }
  const closeLinkMenu = useMemo(() => () => setLinkMenu(null), [])
  const copyFailedLink = (): void => {
    if (!failedLink) return
    void writeClipboard(failedLink).then(() => { setFailedLink(null); showCopyFeedback('Link copied') }, () => showCopyFeedback('Could not copy the link'))
  }
  // A deferred copy can be repeatedly interrupted by incoming snapshots, leaving
  // a running answer stale even after its latest text has reached the renderer.
  // Memoization still keeps unchanged messages out of Markdown parsing.
  const rendered = useMemo(() => <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>, [text])
  const markdownSource = useMemo(() => ({ text, streaming }), [text, streaming])
  return <LinkContext.Provider value={context}><MarkdownSourceContext.Provider value={markdownSource}>
    <div className="rich-message" data-streaming={streaming || undefined} aria-busy={streaming || undefined}>
      {rendered}
      <div className="rich-message__feedback" role="status" aria-live="polite">
        {failedLink ? <><span>{linkNotice ?? `Could not open ${linkLabel(failedLink)}.`}</span><button type="button" className="rich-message__feedback-action tt-focusable" onClick={copyFailedLink}>Copy link</button></> : linkNotice ?? copyFeedback}
      </div>
    </div>
    {linkMenu ? <LinkMenu at={linkMenu.at} label={`Link: ${linkLabel(linkMenu.url)}`} items={menuItems(linkMenu.url)} returnFocus={linkMenu.anchor} onClose={closeLinkMenu} /> : null}
  </MarkdownSourceContext.Provider></LinkContext.Provider>
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
