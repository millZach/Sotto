import type { Nodes, PhrasingContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * The questions a reply asked on the way (#1019). A finished turn folds every reply but its last, and a question a
 * model wrote into an earlier reply before it kept working would fold away with it, so the fold quotes these under
 * its line instead. They are picked by punctuation: a sentence ending in a question mark, in the reply's paragraphs
 * and list items as the transcript draws them, never in its code, headings, tables or quotes. A lifted question is
 * something for the user to read; it is not a request and answers nothing.
 */

/** The most questions quoted from one reply; Show where it asked reaches the rest. */
export const MOST_LIFTED = 4
const LONGEST = 400
/** Fewer words than this is an aside ("Why?") more often than a question for the user. */
const FEWEST_WORDS = 3

/** The transcript's own reading of Markdown, so a paragraph here is the paragraph the user sees. */
const markdown = unified().use(remarkParse).use(remarkGfm)
/** Blocks whose words are not the reply talking to the user: code, headings, tables, quotes and raw HTML. */
const NOT_PROSE = new Set<Nodes['type']>(['code', 'heading', 'table', 'blockquote', 'html'])
/** Where a span of inline code was set aside, marked with private-use characters no reply writes. */
const CODE_MARK = /(\d+)/gu
const SENTENCE_END = /(?<=[.!?…]["'”’)\]]*)\s+/u
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx)\.$/iu
const ASKS = /\?["'”’)\]]*$/u

function paragraphs(node: Nodes, found: PhrasingContent[][]): PhrasingContent[][] {
  if (node.type === 'paragraph') found.push(node.children)
  else if (!NOT_PROSE.has(node.type) && 'children' in node) for (const child of node.children) paragraphs(child, found)
  return found
}

/** A paragraph as it reads: links as their words, emphasis gone, line breaks as spaces, and code set aside. */
function prose(nodes: readonly PhrasingContent[], code: string[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case 'text': return node.value
      case 'inlineCode': return `${code.push(node.value.trim()) - 1}`
      case 'break': return ' '
      case 'image': return node.alt ?? ''
      default: return 'children' in node ? prose(node.children as PhrasingContent[], code) : ''
    }
  }).join('')
}

/** The sentences in `text` that ask something, in the order they were written, each once. */
export function questionsIn(text: string): string[] {
  const found: string[] = []
  for (const paragraph of paragraphs(markdown.parse(text), [])) {
    const code: string[] = []
    const sentences: string[] = []
    for (const piece of prose(paragraph, code).replace(/\s+/gu, ' ').trim().split(SENTENCE_END)) {
      // "e.g." and its kind end a word, not a sentence.
      if (sentences.length && ABBREVIATION.test(sentences.at(-1)!)) sentences[sentences.length - 1] += ` ${piece}`
      else sentences.push(piece)
    }
    for (const sentence of sentences) {
      // A question mark inside code is the code's, so the sentence is judged before its code is put back.
      if (!ASKS.test(sentence)) continue
      const words = sentence.replace(CODE_MARK, (_, index: string) => code[Number(index)] ?? '').trim()
      if (words.split(' ').length < FEWEST_WORDS) continue
      const quoted = words.length > LONGEST ? `${words.slice(0, LONGEST - 1).trimEnd()}…` : words
      if (!found.includes(quoted)) found.push(quoted)
    }
  }
  return found
}
