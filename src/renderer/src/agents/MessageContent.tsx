import React, { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Element, ElementContent, Root } from 'hast'
import { Check, Copy, FileText, Image as ImageIcon } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import { i18n } from '@lingui/core'
import { msg, ph, plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import remarkGfm from 'remark-gfm'
import { isImageAttachment, type AgentAttachmentReference } from '../../../shared/agents'
import { externalLinkSchema } from '../../../shared/externalLinks'
import { MermaidDiagram } from './diagrams/MermaidDiagram'
import { isFenceClosed } from '../../../shared/diagramSource'
import { useCopyImage, useTransientFlag, writeClipboard } from './richActions'
import { useAttachmentSource, type AttachmentOrigin } from './attachmentSources'
import { AttachmentViewer } from './AttachmentViewer'
import { LinkMenu, useWebLinkRouter, type LinkMenuItem, type WebLinkDestination, type WebLinkResult } from '../tools/webLinks'
import { highlighterNow, loadHighlighter, type Highlighter } from './codeHighlighter'
import { leftToRight, shownWords, type LaterWords } from './interfaceWords'
import { useOwlFeature } from '../state/owlFeature'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import { attachmentKind, AttachmentKindIcon, fileTypeLabel } from './attachmentKinds'
import { formatAttachmentSize } from '../../../shared/attachmentLabels'
import './rich-messages.css'

export type { AttachmentOrigin } from './attachmentSources'

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
  /** The submitted message these belong to; without it only a draft's own bytes can be drawn. */
  readonly origin?: AttachmentOrigin | undefined
}

export type LinkOpenResult = Readonly<{ ok: boolean }>

/** Code longer than this is shown without highlighting so a huge paste cannot stall the transcript. */
export const MAX_HIGHLIGHTED_CODE_LENGTH = 20_000
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

/**
 * The path a link names when it is a file rather than a web page: a `file:` URL, an absolute path, a `~/` path or one
 * relative to the thread's folder. Never a network share. Null otherwise. Main drops a trailing `:12` or `#L12` if the
 * path as written is not found.
 */
export function localFilePath(raw: string | undefined): string | null {
  let value = raw?.trim() ?? ''
  if (!value || value.length > 4096 || value.startsWith('#')) return null
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value)
      if (url.host && url.host !== 'localhost') return null
      value = url.pathname
      // file:///C:/Users becomes /C:/Users; Windows wants the drive first.
      if (/^\/[a-z]:\//iu.test(value)) value = value.slice(1)
    } catch { return null }
  }
  try { value = decodeURIComponent(value) } catch { /* Kept as written: a literal % in a file name. */ }
  // A network share or device path (\\host, //host, \\?\) would reach the network.
  if (/^[\\/]{2}/u.test(value)) return null
  // Any other scheme (http:, javascript:, vscode:) is not a file here; a Windows drive letter is, and so is a file named
  // `notes.md:12`, which main looks up as written first.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)) return null
  // eslint-disable-next-line no-control-regex -- File paths must reject NUL and control bytes.
  return value && !/[\x00-\x1f\x7f]/u.test(value) && !/\p{Bidi_Control}/u.test(value) ? value : null
}

/** The file manager by its own name on each platform: File Explorer first, Finder on a Mac, the file manager on Linux. */
const fileManager = (): string => {
  const platform = (window.sotto as { platform?: string } | undefined)?.platform
  return platform === 'darwin' ? 'Finder' : platform === 'linux'
    ? i18n._(msg({ message: 'the file manager', comment: 'Linux: what shows a file in its folder. Read inside "Show in {manager}: {file}".' }))
    : i18n._(msg({ message: 'File Explorer', comment: 'Windows\' own name for its file manager, as Windows shows it in this language.' }))
}

function linkLabel(url: string): string {
  return url.startsWith('mailto:') ? url.slice('mailto:'.length).split('?')[0]! : new URL(url).host
}

async function openWithBridge(url: string): Promise<LinkOpenResult> {
  const open = window.sotto?.openExternalLink
  return open ? open(url) : { ok: false }
}

export { formatAttachmentSize }

export function attachmentTypeLabel(mimeType: string | undefined): string | null {
  if (!mimeType) return null
  const subtype = mimeType.split(';')[0]!.split('/')[1] ?? ''
  const label = subtype.replace(/^(?:x-|vnd\.)/u, '').split(/[+.]/u)[0]!.replace(/[^a-z0-9-]/giu, '').slice(0, 12).toUpperCase()
  return label || i18n._(msg({ message: 'File', comment: 'An attachment\'s type when its file type has no short name.' }))
}

interface LinkActions {
  readonly open: (url: string, destination?: WebLinkDestination) => void
  readonly menu: (url: string, anchor: HTMLElement, at: { x: number; y: number }) => void
  /** Shows a linked file in its folder, when this message is in a thread that can. */
  readonly reveal?: ((path: string) => void) | undefined
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

function highlight(code: string, language: string | undefined, highlighter: Highlighter | null): ReactNode {
  if (!highlighter || !language || code.length > MAX_HIGHLIGHTED_CODE_LENGTH || !highlighter.registered(language)) return code
  try {
    const tree: Root = highlighter.highlight(language, code)
    return hastToReact(tree.children as ElementContent[])
  } catch { return code }
}

/**
 * A code block that shows only part of its body, the rest still on the thread's host (ADR-0025, October 18 amendment):
 * which end it keeps, the line that marks where the rest goes, and what its bar says meanwhile. Copy waits for the rest.
 */
export interface CodeBlockCut { readonly keep: 'start' | 'end'; readonly line: string; readonly status: ReactNode }

export const CodeBlock = memo(function CodeBlock({ code, language, cut, anchorEnd = false }: {
  code: string; language: string | undefined
  readonly cut?: CodeBlockCut | undefined
  /** Opens scrolled to its end, and keeps the same lines in view as the code above them grows, as command output does. */
  readonly anchorEnd?: boolean | undefined
}) {
  const { t } = useLingui()
  // The flag holds what happened, and its words are read when shown, in the interface language.
  const [outcome, showOutcome] = useTransientFlag()
  const [highlighter, setHighlighter] = useState(highlighterNow)
  const scroll = useRef<HTMLPreElement>(null)
  /** How far the reader is from the end, kept so the whole body lands with the same lines in view. */
  const fromEnd = useRef(0)
  useEffect(() => {
    if (highlighter !== null || !language || code.length > MAX_HIGHLIGHTED_CODE_LENGTH) return
    let live = true
    void loadHighlighter().then(loaded => { if (live) setHighlighter(loaded) }, () => undefined)
    return () => { live = false }
  }, [highlighter, language, code])
  useLayoutEffect(() => {
    const pre = scroll.current
    if (anchorEnd && pre) pre.scrollTop = Math.max(0, pre.scrollHeight - pre.clientHeight - fromEnd.current)
  }, [anchorEnd, code, cut?.keep])
  const highlighted = useMemo(() => highlight(code, language, highlighter), [code, language, highlighter])
  const label = language ? language.slice(0, 24) : t({ message: 'Code', comment: 'A code block\'s label when it names no language.' })
  const copied = outcome === 'copied'
  const feedback = outcome === null ? null : copied ? t`Copied` : t`Copy failed`
  const copy = (): void => { if (!cut) void writeClipboard(code).then(() => showOutcome('copied'), () => showOutcome('failed')) }
  const marker = cut ? <span className="activity-body__cut">{cut.line}</span> : null
  return <div className="rich-code" data-language={language} data-cut={cut?.keep}>
    <div className="rich-code__bar">
      <span className="rich-code__language">{label}</span>
      <span className="rich-code__status" role="status" aria-live="polite">{feedback || cut?.status}</span>
      <button type="button" className="rich-code__copy tt-focusable" data-copied={copied || undefined} aria-disabled={cut ? true : undefined}
        aria-label={cut
          ? language ? t({ message: `Copy ${label} code, once the rest arrives`, comment: '{label} is the code\'s language, such as TypeScript.' }) : t`Copy code, once the rest arrives`
          : language ? t({ message: `Copy ${label} code`, comment: '{label} is the code\'s language, such as TypeScript.' }) : t`Copy code`}
        title={cut ? t`Copy works once the rest arrives` : t`Copy code`} onClick={copy}>
        {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </button>
    </div>
    <pre ref={scroll} className="rich-code__scroll" tabIndex={0} aria-label={t({ message: `${label} code block`, comment: '{label} is the code\'s language, such as TypeScript, or the word "Code".' })}
      onScroll={anchorEnd ? event => { const pre = event.currentTarget; fromEnd.current = pre.scrollHeight - pre.clientHeight - pre.scrollTop } : undefined}>
      <code className={language ? `hljs language-${language}` : 'hljs'}>{cut?.keep === 'end' ? <>{marker}{'\n'}</> : null}{highlighted}{cut?.keep === 'start' ? <>{'\n'}{marker}</> : null}</code>
    </pre>
  </div>
})

function DiagramBlock({ source, start, end }: { source: string; start: number | undefined; end: number | undefined }): ReactNode {
  const { text, streaming } = useContext(MarkdownSourceContext)
  // A finished message draws whatever it holds; a streaming one waits for the closing fence.
  const complete = !streaming || (start !== undefined && end !== undefined && isFenceClosed(text.slice(start, end)))
  return <MermaidDiagram source={source} complete={complete} />
}

function MarkdownLink({ href, title, children }: { href?: string | undefined; title?: string | undefined; children?: ReactNode }): ReactNode {
  const { t } = useLingui()
  const { open, menu, reveal } = useContext(LinkContext)
  const url = safeLinkUrl(href)
  const file = !url && reveal ? localFilePath(href) : null
  const manager = fileManager()
  // No href: a file path never becomes something the window could navigate to.
  if (file && reveal) return <a className="rich-link tt-focusable" role="link" tabIndex={0} title={t({ message: `Show in ${manager}: ${ph({ file: leftToRight(file) })}`, comment: '{manager} is File Explorer, Finder or the file manager; {file} is a path.' })}
    aria-label={t({ message: `Show ${ph({ file: leftToRight(file) })} in ${manager}`, comment: '{manager} is File Explorer, Finder or the file manager; {file} is a path.' })}
    onClick={() => reveal(file)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); reveal(file) } }}>{children}</a>
  // The reason is read with the text, not only on hover, so keyboard and screen reader users get it too.
  if (!url) return <span className="rich-link rich-link--inert" title={href ? t`Not a web link: ${href}` : undefined}>{children}{href ? <span className="tt-visually-hidden">{' '}{t`(link not opened: not a web address)`}</span> : null}</span>
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
  const { t } = useLingui()
  const url = safeLinkUrl(src)
  const host = url && !url.startsWith('mailto:') ? new URL(url).host : null
  return <span className="rich-image-blocked" role="img" aria-label={alt ? t`Image not loaded: ${alt}` : t`Image not loaded`}>
    <ImageIcon size={14} aria-hidden="true" /><span>{alt || t`Image`}</span><small>{host ? t`not loaded from ${host}` : t({ message: 'not loaded', comment: 'Under an image an agent linked, which Sotto does not load.' })}</small>
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
  table: ({ children }) => <div className="rich-table tt-focusable" role="region" aria-label={i18n._(msg`Table`)} tabIndex={0}><table>{children}</table></div>,
  input: ({ type, checked }) => type === 'checkbox'
    ? <input className="rich-task" type="checkbox" checked={checked === true} disabled readOnly aria-label={checked
      ? i18n._(msg({ message: 'Done', context: 'ticked task', comment: 'A ticked task in a Markdown task list.' }))
      : i18n._(msg({ message: 'Not done', comment: 'An unticked task in a Markdown task list.' }))} />
    : null,
  h1: heading(3, 1), h2: heading(4, 2), h3: heading(5, 3), h4: heading(6, 4), h5: heading(6, 5), h6: heading(6, 6),
}
const remarkPlugins = [remarkGfm]

const BLOCK_FENCE = /^ {0,3}(`{3,}|~{3,})/u
const BLOCK_FENCE_END = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
// A block that opens with one of these can still be claimed by whatever precedes the blank line
// above it — list continuation, a loose list item, a lazy blockquote, indented code, a setext rule
// or an HTML block — so the two sides would not parse the same apart as together.
const CLAIMABLE_BLOCK_START = /^(?:[ \t]|[-*+>=]|\d{1,9}[.)]|\[|<)/u
// Link and footnote definitions are resolved from anywhere in the message, and these HTML blocks run
// on past blank lines, so a message holding one is never split.
const WHOLE_MESSAGE_ONLY = /^ {0,3}(?:\[[^\]]*\]:|<(?:script|pre|style|textarea)\b|<!|<\?)/iu

/**
 * Splits a message still being written into blocks that are already final, followed by the block
 * being written. Concatenating the result restores the input, and every split lands where no
 * construct can reach across it, so rendering the parts is the same as rendering the whole. When
 * that cannot be guaranteed the message is returned whole: an extra parse costs less than wrong text.
 */
export function splitStreamingMarkdown(text: string): string[] {
  const segments: string[] = []
  let start = 0
  let blank = -1
  let offset = 0
  let fence: string | null = null
  // The open fence began a top-level block, so its closing line ends a leaf block that no later
  // text can reach into: the blank line after it is a boundary whatever comes next, even a list.
  let fenceSeals = false
  let sealed = false
  let blockStart = true
  for (const line of text.split('\n')) {
    const next = offset + line.length + 1
    if (fence !== null) {
      const closing = BLOCK_FENCE_END.exec(line)?.[1]
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) {
        fence = null
        sealed = fenceSeals
      }
    } else if (!line.trim()) {
      // The trailing element of the split is past the end of the text, so it never becomes a block.
      if (sealed && next <= text.length) {
        segments.push(text.slice(start, next))
        start = next
        sealed = false
        blank = -1
      } else blank = next
      blockStart = true
    } else {
      if (WHOLE_MESSAGE_ONLY.test(line)) return [text]
      if (blank > start && !CLAIMABLE_BLOCK_START.test(line)) {
        segments.push(text.slice(start, blank))
        start = blank
      }
      blank = -1
      sealed = false
      fence = BLOCK_FENCE.exec(line)?.[1] ?? null
      // Indented fences belong to a list item or a quote, which the text after them can still extend.
      fenceSeals = fence !== null && blockStart && !/^[ \t]/u.test(line)
      blockStart = false
    }
    offset = next
  }
  segments.push(text.slice(start))
  return segments
}

/** One parse unit. Memoized so an appended chunk only re-parses the block it lands in. */
const MarkdownSegment = memo(function MarkdownSegment({ source, streaming }: { source: string; streaming: boolean }): ReactNode {
  // Its tables and task boxes are named in the interface language, so it draws again when that changes.
  useInterfaceLanguageState()
  // Node offsets are relative to this segment, so a fenced diagram is told its own source.
  const markdownSource = useMemo(() => ({ text: source, streaming }), [source, streaming])
  return <MarkdownSourceContext.Provider value={markdownSource}>
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>{source}</ReactMarkdown>
  </MarkdownSourceContext.Provider>
})

/** Renders one message's text as safe Markdown. Raw HTML stays literal text; only vetted web links are links. */
export const MessageContent = memo(function MessageContent({ text, streaming = false, onOpenLink }: MessageContentProps): ReactNode {
  const { t } = useLingui()
  const [failedLink, setFailedLink] = useState<string | null>(null)
  // Sotto's words kept as messages and read when shown; main's as written.
  const [linkNotice, setLinkNotice] = useState<LaterWords | null>(null)
  const [linkMenu, setLinkMenu] = useState<{ url: string; anchor: HTMLElement; at: { x: number; y: number } } | null>(null)
  const [copyOutcome, showCopyOutcome] = useTransientFlag<'copied' | 'failed'>()
  const copyFeedback = copyOutcome === 'copied' ? t`Link copied` : copyOutcome === 'failed' ? t`Could not copy the link` : null
  const router = useWebLinkRouter()
  const revealLinks = useOwlFeature('reveal-linked-files')
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
    // Showing linked files is an Owl feature (ADR-0120): while it is off a file link stays inert text, as before.
    reveal: revealLinks && router.revealFile ? path => {
      setFailedLink(null)
      setLinkNotice(null)
      void router.revealFile?.(path).then(result => setLinkNotice(result.message ?? null), () => setLinkNotice(msg`Sotto could not show this file. Nothing was opened.`))
    } : undefined,
  }), [router, revealLinks])
  const menuItems = (url: string): LinkMenuItem[] => {
    const web = !url.startsWith('mailto:')
    return [
      ...(web && router.canEmbed && !onOpenLink ? [{ id: 'embedded', label: t`Open in Sotto browser`, run: () => context.open(url, 'embedded') }] : []),
      { id: 'external', label: web ? t`Open in system browser` : t`Open in mail app`, run: () => context.open(url, 'external') },
      { id: 'copy', label: web ? t`Copy link` : t`Copy address`, run: () => { void writeClipboard(web ? url : linkLabel(url)).then(() => showCopyOutcome('copied'), () => showCopyOutcome('failed')) } },
    ]
  }
  const closeLinkMenu = useMemo(() => () => setLinkMenu(null), [])
  const copyFailedLink = (): void => {
    if (!failedLink) return
    void writeClipboard(failedLink).then(() => { setFailedLink(null); showCopyOutcome('copied') }, () => showCopyOutcome('failed'))
  }
  // A deferred copy can be repeatedly interrupted by incoming snapshots, leaving
  // a running answer stale even after its latest text has reached the renderer.
  // A finished message is one document; a running one re-parses only its last block.
  const segments = useMemo(() => streaming ? splitStreamingMarkdown(text) : [text], [text, streaming])
  const failedHost = failedLink ? linkLabel(failedLink) : ''
  const menuHost = linkMenu ? linkLabel(linkMenu.url) : ''
  return <LinkContext.Provider value={context}>
    <div className="rich-message" data-streaming={streaming || undefined} aria-busy={streaming || undefined}>
      {segments.map((source, index) => <MarkdownSegment key={index} source={source} streaming={streaming && index === segments.length - 1} />)}
      <div className="rich-message__feedback" role="status" aria-live="polite">
        {failedLink ? <><span>{shownWords(linkNotice) ?? t({ message: `Could not open ${failedHost}.`, comment: '{failedHost} is a web site\'s host name or an email address.' })}</span><button type="button" className="rich-message__feedback-action tt-focusable" onClick={copyFailedLink}>{t`Copy link`}</button></> : shownWords(linkNotice) ?? copyFeedback}
      </div>
    </div>
    {linkMenu ? <LinkMenu at={linkMenu.at} label={t`Link: ${menuHost}`} items={menuItems(linkMenu.url)} returnFocus={linkMenu.anchor} onClose={closeLinkMenu} /> : null}
  </LinkContext.Provider>
})

/** The name a tile shows: bidirectional controls dropped, so "gpj.exe" cannot read as "exe.jpg". */
const attachmentName = (attachment: MessageAttachment): string => attachment.name.replace(BIDI_CONTROLS, '') || i18n._(msg({ message: 'Attachment', comment: 'An attachment with no name.' }))
const attachmentDetails = (attachment: MessageAttachment, anyFile = false): string =>
  [anyFile ? fileTypeLabel(attachment.mimeType, attachmentName(attachment)) : attachmentTypeLabel(attachment.mimeType), formatAttachmentSize(attachment.sizeBytes)].filter(Boolean).join(' · ')

/**
 * One attachment. An image that can be shown is a button: a press opens it large, and right-click, Shift+F10 or the
 * ContextMenu key offers Open image and Copy image.
 */
function AttachmentTile({ attachment, origin, onOpen, onShown, anyFile }: {
  attachment: MessageAttachment; origin?: AttachmentOrigin | undefined; onOpen: (from: HTMLElement) => void
  /** Whether the tile is showing its image, which is what puts it in the viewer. */
  onShown: (id: string, shown: boolean) => void
  /** Once any file can be attached (ADR-0131), a file's tile names its type and claims no preview it could never have. */
  anyFile: boolean
}): ReactNode {
  const { t } = useLingui()
  const { source, awaiting } = useAttachmentSource(attachment, origin)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  const showing = Boolean(source) && !failed
  useEffect(() => onShown(attachment.id, showing), [onShown, attachment.id, showing])
  const [menuAt, setMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const [feedback, copyImage] = useCopyImage()
  const frame = useRef<HTMLButtonElement>(null)
  const name = attachmentName(attachment)
  // Once any file can be attached, only the four raster types are images: an SVG, a BMP or a HEIC is a file (ADR-0131).
  const isImage = attachment.mimeType ? anyFile ? isImageAttachment(attachment.mimeType) : attachment.mimeType.startsWith('image/') : false
  const details = attachmentDetails(attachment, anyFile)
  if (source && !failed) {
    const openMenu = (point: { readonly x: number; readonly y: number } | null): void => {
      const rect = frame.current?.getBoundingClientRect()
      setMenuAt(point ?? { x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 })
    }
    const menuItems: LinkMenuItem[] = [
      { id: 'open', label: t`Open image`, run: () => { if (frame.current) onOpen(frame.current) } },
      { id: 'copy', label: t`Copy image`, run: () => copyImage(source) },
    ]
    return <figure className="rich-attachment rich-attachment--image" role="listitem">
      <button type="button" ref={frame} className="rich-attachment__frame tt-focusable" aria-label={t({ message: `Open ${name}`, comment: '{name} is an attached image\'s file name.' })} title={t`Open image · Right-click to copy`}
        aria-haspopup="menu" aria-expanded={menuAt ? true : undefined}
        onClick={event => onOpen(event.currentTarget)}
        onContextMenu={event => {
          event.preventDefault()
          // A keyboard-invoked context menu reports no pointer position, so it opens beside the image.
          openMenu(event.clientX === 0 && event.clientY === 0 ? null : { x: event.clientX, y: event.clientY })
        }}
        onKeyDown={event => {
          if (!(event.key === 'F10' && event.shiftKey) && event.key !== 'ContextMenu') return
          event.preventDefault()
          openMenu(null)
        }}>
        <img src={source} alt={name} decoding="async" draggable={false} onError={() => setFailed(true)} />
      </button>
      <figcaption><span className="rich-attachment__name" title={name}>{name}</span>
        {(feedback ?? details) && <span className="rich-attachment__meta" role="status" aria-live="polite">{feedback ?? details}</span>}</figcaption>
      {menuAt ? <LinkMenu at={menuAt} label={t`Image: ${name}`} items={menuItems} returnFocus={frame.current} onClose={() => setMenuAt(null)} /> : null}
    </figure>
  }
  const reason = !attachment.mimeType || awaiting ? null : !isImage ? (anyFile ? null : t`No preview for this file type`) : failed ? t`Preview could not be shown` : t`Preview unavailable`
  return <div className="rich-attachment rich-attachment--file" role="listitem">
    {anyFile && attachment.mimeType && !isImage ? <AttachmentKindIcon kind={attachmentKind(name, attachment.mimeType)} size={16} />
      : isImage || !attachment.mimeType ? <ImageIcon size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
    <span className="rich-attachment__text">
      <span className="rich-attachment__name" title={name}>{name}</span>
      {(details || reason) && <span className="rich-attachment__meta">{[details, reason].filter(Boolean).join(' · ')}</span>}
    </span>
  </div>
}

/** Submitted images with their name, type and size; metadata alone when no trusted preview exists. */
export function AttachmentPreviews({ attachments: given, notice, origin }: AttachmentPreviewsProps): ReactNode {
  useInterfaceLanguageState()
  const anyFile = useOwlFeature('attach-any-file')
  // Images come first, then every other file (ADR-0131).
  const attachments = useMemo(() => anyFile ? [...given.filter(item => attachmentKind(item.name, item.mimeType) === 'image' || !item.mimeType),
    ...given.filter(item => item.mimeType && attachmentKind(item.name, item.mimeType) !== 'image')] : given, [anyFile, given])
  const [open, setOpen] = useState<{ readonly id: string; readonly from: HTMLElement } | null>(null)
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())
  const onShown = useCallback((id: string, showing: boolean) => setShown(current => {
    if (current.has(id) === showing) return current
    const next = new Set(current)
    if (showing) next.add(id); else next.delete(id)
    return next
  }), [])
  if (!attachments.length && !notice) return null
  // The viewer steps through the message's images that its tiles are showing; one whose bytes are gone stays out.
  const count = attachments.length
  const images = attachments.filter(attachment => shown.has(attachment.id))
    .map(attachment => ({ id: attachment.id, preview: attachment.preview, name: attachmentName(attachment), details: attachmentDetails(attachment, anyFile) }))
  return <div className="rich-attachments">
    {!!attachments.length && <div className="rich-attachments__list" role="list" aria-label={plural(count, { one: 'Attachment', other: '# attachments' })}>
      {attachments.map(attachment => <AttachmentTile key={attachment.id} attachment={attachment} origin={origin} onShown={onShown} anyFile={anyFile} onOpen={from => setOpen({ id: attachment.id, from })} />)}
    </div>}
    {notice && <p className="rich-attachments__notice" role="note">{notice}</p>}
    {open && images.some(image => image.id === open.id)
      ? <AttachmentViewer images={images} origin={origin} startId={open.id} anchor={open.from} onClose={() => setOpen(null)} />
      : null}
  </div>
}
