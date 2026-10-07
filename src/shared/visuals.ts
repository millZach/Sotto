import { z } from 'zod'
import { inspectDiagramSource, MAX_DIAGRAM_SOURCE_LENGTH } from './diagramSource'

/**
 * A visual an agent draws in its thread with the `visualize` tool (ADR-0055): what it may send, what Sotto keeps, and the
 * words a reader that cannot draw it is given instead. Main and the renderer both read this file, so the checks that
 * refuse a call are the same ones the card trusts.
 */

export const VISUAL_TITLE_MAX = 120
export const VISUAL_INTRO_MAX = 2_000
export const VISUAL_STEPS_MAX = 12
export const VISUAL_STEP_TEXT_MAX = 1_000
export const VISUAL_HIGHLIGHTS_MAX = 12
export const VISUAL_HIGHLIGHT_MAX = 120
/** How many visuals one turn may draw, and one thread may hold. */
export const VISUALS_PER_TURN_MAX = 6
export const VISUALS_PER_THREAD_MAX = 100
/** The longest page an interactive visual may be: an agent's own HTML, served sealed (ADR-0056). */
export const VISUAL_PAGE_SOURCE_MAX = 60_000
/** The kinds an agent may send: Mermaid source, or its own HTML page run sealed from the network (ADR-0056). */
export const VISUAL_KINDS = ['diagram', 'interactive'] as const
export type VisualKind = typeof VISUAL_KINDS[number]
/** Whether this version draws a visual of this kind; a visual of any other kind is shown as its words. */
export const isKnownVisualKind = (kind: string): kind is VisualKind => (VISUAL_KINDS as readonly string[]).includes(kind)
/** The prefix every visual message's ID starts with, so nothing mistakes one for a provider's message. */
export const VISUAL_MESSAGE_PREFIX = 'visual:'
/** The last line of every visual's text: where the drawing is for a reader that cannot show it. */
export const VISUAL_FALLBACK_NOTE = 'The visual is in Sotto on your computer.'

const notBlank = (value: string): boolean => value.trim().length > 0

const visualStepInputSchema = z.object({
  text: z.string().min(1).max(VISUAL_STEP_TEXT_MAX).refine(notBlank, 'A step needs words.')
    .describe('What this step says, in one or two sentences.'),
  highlight: z.array(z.string().min(1).max(VISUAL_HIGHLIGHT_MAX)).max(VISUAL_HIGHLIGHTS_MAX).optional()
    .describe('The parts of the visual this step is about, by name. A diagram ignores unknown names; an interactive page is sent them with the step.'),
}).strict()

/** What the `visualize` tool takes. Strict: a field it does not know is refused rather than dropped. */
export const visualInputSchema = z.object({
  title: z.string().min(1).max(VISUAL_TITLE_MAX).refine(notBlank, 'A visual needs a title.')
    .describe('A short name for the visual, shown above it.'),
  kind: z.enum(VISUAL_KINDS).describe('diagram: Mermaid source. interactive: an HTML page of your own that never reaches the network.'),
  source: z.string().min(1).max(VISUAL_PAGE_SOURCE_MAX)
    .describe(`For a diagram, Mermaid source of up to ${MAX_DIAGRAM_SOURCE_LENGTH.toLocaleString('en-US')} characters: a flowchart, sequence, state, class or entity relationship diagram, with no init directives or front-matter configuration. For an interactive visual, one HTML page of up to ${VISUAL_PAGE_SOURCE_MAX.toLocaleString('en-US')} characters with inline script and style.`),
  intro: z.string().max(VISUAL_INTRO_MAX).optional().describe('One or two sentences shown under the visual, before any steps.'),
  steps: z.array(visualStepInputSchema).max(VISUAL_STEPS_MAX).optional()
    .describe('An ordered walk through the visual, one part at a time.'),
}).strict()
export type VisualInput = z.infer<typeof visualInputSchema>

/**
 * One visual as a thread keeps it, and as a visual message carries it to a window, read leniently: `kind` is a string
 * rather than the kinds this version knows, so a newer kind reads as its text rather than breaking the message. Bounds
 * are the input's with room, so nothing a store holds is refused on the way to a window.
 */
export const agentVisualSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().max(VISUAL_TITLE_MAX * 2),
  kind: z.string().max(64),
  source: z.string().max(200_000),
  intro: z.string().max(VISUAL_INTRO_MAX * 2).optional(),
  steps: z.array(z.object({ text: z.string().max(VISUAL_STEP_TEXT_MAX * 2), highlight: z.array(z.string().max(VISUAL_HIGHLIGHT_MAX * 2)).max(VISUAL_HIGHLIGHTS_MAX * 2).optional() })).max(VISUAL_STEPS_MAX * 2).optional(),
})
export type AgentVisual = z.infer<typeof agentVisualSchema>

/** A checked call: the visual to keep, and its kind in words for the reply. Or what was wrong and what to do. */
export type VisualCheck =
  | { readonly ok: true; readonly input: VisualInput; readonly label: string }
  | { readonly ok: false; readonly reason: string; readonly next: string }
export type VisualRefusal = Extract<VisualCheck, { ok: false }>

/** The sentence every refused visualize call carries. */
export const VISUAL_NOTHING_DRAWN = 'Nothing was drawn.'
const FIX_IT = 'Fix it and call visualize again, or explain in text.'
const SPLIT_IT = 'Split it into smaller diagrams, or explain in text.'

const FIELD_NAMES: Record<string, string> = { title: 'The title', kind: 'The kind', source: 'The source', intro: 'The intro', steps: 'The steps' }

/** The first thing wrong with a call, in plain words, naming the field. */
function inputProblem(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'The visual could not be read.'
  if (issue.code === 'unrecognized_keys') return `The visual has fields it does not take: ${issue.keys.join(', ')}.`
  const field = FIELD_NAMES[String(issue.path[0])] ?? 'The visual'
  if (issue.path[0] === 'kind') return `The kind must be one of: ${VISUAL_KINDS.join(', ')}.`
  if (issue.path[0] === 'steps' && issue.path.length > 1) {
    const step = Number(issue.path[1]) + 1
    if (issue.path[2] === 'highlight') return `Step ${step}'s highlight takes up to ${VISUAL_HIGHLIGHTS_MAX} names of 1 to ${VISUAL_HIGHLIGHT_MAX} characters.`
    return `Step ${step} needs text of 1 to ${VISUAL_STEP_TEXT_MAX.toLocaleString('en-US')} characters.`
  }
  if (issue.code === 'too_big') return issue.path[0] === 'steps' ? `There are too many steps. Send up to ${VISUAL_STEPS_MAX}.`
    : `${field} is too long. It takes up to ${Number(issue.maximum).toLocaleString('en-US')} characters.`
  if (issue.code === 'too_small' || issue.code === 'custom') return `${field} is empty.`
  return `${field} is not in the shape the tool takes.`
}

/** What an interactive visual is called in the tool's reply: "an interactive page with 3 steps". */
export const INTERACTIVE_VISUAL_LABEL = 'Interactive page'

/**
 * The schema, then for a diagram the source checks, in that order: the same checks the card makes before drawing. An
 * interactive page is not inspected; it is contained instead (ADR-0056), so what it says cannot reach anything.
 */
export function checkVisualInput(args: unknown): VisualCheck {
  const parsed = visualInputSchema.safeParse(args)
  if (!parsed.success) return { ok: false, reason: inputProblem(parsed.error), next: FIX_IT }
  if (parsed.data.kind === 'interactive') {
    if (!notBlank(parsed.data.source)) return { ok: false, reason: 'The source is empty.', next: FIX_IT }
    return { ok: true, input: parsed.data, label: INTERACTIVE_VISUAL_LABEL }
  }
  const inspection = inspectDiagramSource(parsed.data.source)
  // The card's words for an oversized diagram say its source is shown instead; a refused call shows nothing, so it
  // says what is too big in its own words.
  if (inspection.exceeds === 'length') return { ok: false, next: SPLIT_IT,
    reason: `This diagram is too long for Sotto to draw: it takes up to ${MAX_DIAGRAM_SOURCE_LENGTH.toLocaleString('en-US')} characters.` }
  if (inspection.exceeds === 'work') return { ok: false, next: SPLIT_IT,
    reason: 'This diagram is too large for Sotto to draw: it has more parts than Sotto draws safely.' }
  if (inspection.problem) return { ok: false, reason: `The diagram cannot be drawn. ${inspection.problem}`, next: FIX_IT }
  return { ok: true, input: parsed.data, label: inspection.label }
}

/** What a refused call answers: what was wrong, that nothing was drawn, and what to do next. */
export function visualRefusalText(refusal: VisualRefusal): string {
  return `${refusal.reason} ${VISUAL_NOTHING_DRAWN} ${refusal.next}`
}

/** A message's ID for a visual. Whether a message is a visual is `isVisualMessage`'s to say, not the ID's alone. */
export const visualMessageId = (visualId: string): string => `${VISUAL_MESSAGE_PREFIX}${visualId}`

/**
 * A checked call as the visual Sotto keeps, under `id`: the title, intro and step texts trimmed, an intro or a step's
 * highlight left out when there is none, and the source exactly as sent. Everything that shows a visual, the card and
 * its words alike, reads this.
 */
export function visualFromInput(id: string, input: VisualInput): AgentVisual {
  const intro = input.intro?.trim()
  return { id, title: input.title.trim(), kind: input.kind, source: input.source,
    ...(intro ? { intro } : {}),
    ...(input.steps?.length ? { steps: input.steps.map(step => ({ text: step.text.trim(), ...(step.highlight?.length ? { highlight: [...step.highlight] } : {}) })) } : {}) }
}

/** Indents every line after the first, so a step with line breaks stays one numbered item. */
const listItem = (index: number, text: string): string => `${index + 1}. ${text.split(/\r?\n/u).join('\n   ')}`

/**
 * What a reader that cannot draw a visual is given: its title, intro and numbered steps, then where the drawing is. The
 * iPhone, an older desktop and anything reading a thread's words read this. It takes the visual as `visualFromInput`
 * keeps it, so it trims nothing itself.
 */
export function visualFallbackText(visual: Pick<AgentVisual, 'title' | 'intro' | 'steps'>): string {
  const parts = [`**${visual.title}**`]
  if (visual.intro) parts.push(visual.intro)
  if (visual.steps?.length) parts.push(visual.steps.map((step, index) => listItem(index, step.text)).join('\n'))
  parts.push(VISUAL_FALLBACK_NOTE)
  return parts.join('\n\n')
}
