import { z } from 'zod'

/**
 * Playbooks (ADR-0218): ordered steps the user writes in a JSON file in their computer's playbooks folder, which a
 * **scheduled task** runs. An agent step sends a prompt to a thread, a code step runs one command, and a decision step
 * waits for the user. Steps pass structured outputs forward. The file is the user's own; anything a run is started with
 * from outside (a webhook's body, a GitHub issue) is data bound to the inputs the file declares, never a step.
 *
 * A playbook's id is its file's name. `format` is the version of this format Sotto reads; the file's **revision** is a
 * hash of its bytes, which every run keeps, so editing the file never changes a run already started.
 */

export const PLAYBOOK_FORMAT = 1
export const PLAYBOOKS_FOLDER = 'playbooks'
export const PLAYBOOK_EXTENSION = '.json'
export const PLAYBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u
export const PLAYBOOK_STEP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u
export const PLAYBOOK_INPUT_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u
/** At most this many playbook files are read. */
export const PLAYBOOKS_MAX = 50
/** At most this many bytes of one playbook file are read. */
export const PLAYBOOK_BYTES_MAX = 128 * 1024
export const PLAYBOOK_STEPS_MAX = 30
/** The most a step may be tried again after it fails. */
export const PLAYBOOK_RETRIES_MAX = 3
/** The most runs of one playbook at once, across every task that runs it. */
export const PLAYBOOK_CONCURRENCY_MAX = 5
/** The longest an acknowledged output, or a run's inputs, may be once written as JSON. */
export const PLAYBOOK_OUTPUT_BYTES_MAX = 16 * 1024
/** The fence an agent step's reply ends with to hand back its output. */
export const PLAYBOOK_OUTPUT_FENCE = 'sotto-output'
/** How long a code step may run when its file names no limit, and the most it may name. */
export const CODE_STEP_TIMEOUT_DEFAULT_MINUTES = 20
export const CODE_STEP_TIMEOUT_MAX_MINUTES = 120

const stepId = z.string().regex(PLAYBOOK_STEP_ID_PATTERN)
const inputName = z.string().regex(PLAYBOOK_INPUT_PATTERN)
const title = z.string().trim().min(1).max(80)
const retries = z.number().int().min(0).max(PLAYBOOK_RETRIES_MAX)

export const playbookValueSchema = z.union([z.string().max(PLAYBOOK_OUTPUT_BYTES_MAX), z.number().finite(), z.boolean()])
export type PlaybookValue = z.infer<typeof playbookValueSchema>

const inputSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().max(300).optional(),
  required: z.boolean().optional(),
  default: playbookValueSchema.optional(),
}).strict()
export type PlaybookInput = z.infer<typeof inputSchema>

export const PLAYBOOK_FIELD_TYPES = ['string', 'number', 'boolean', 'string[]'] as const
const outputSchema = z.object({
  properties: z.record(inputName, z.object({ type: z.enum(PLAYBOOK_FIELD_TYPES), description: z.string().max(300).optional() }).strict())
    .refine(properties => Object.keys(properties).length >= 1 && Object.keys(properties).length <= 20, 'An output names one to twenty fields.'),
  required: z.array(inputName).max(20).optional(),
}).strict()
export type PlaybookOutput = z.infer<typeof outputSchema>

const agentStep = z.object({
  id: stepId, kind: z.literal('agent'), title: title.optional(),
  prompt: z.string().trim().min(1).max(20_000),
  /** Goes on in an earlier agent step's thread instead of starting one. */
  thread: stepId.optional(),
  /** A new thread's working copy: the project's folder, or a new worktree. */
  workingCopy: z.enum(['shared', 'worktree']).optional(),
  output: outputSchema.optional(),
  retries: retries.optional(),
}).strict()
const codeStep = z.object({
  id: stepId, kind: z.literal('code'), title: title.optional(),
  /** The program and its arguments, run without a shell. Nothing from a run's inputs is ever put into them. */
  run: z.array(z.string().min(1).max(1000)).min(1).max(64),
  /** Runs in an earlier agent step's thread folder, such as its worktree; the project's folder otherwise. */
  in: stepId.optional(),
  timeoutMinutes: z.number().int().min(1).max(CODE_STEP_TIMEOUT_MAX_MINUTES).optional(),
  /** `json`: what it prints is a JSON object, kept as its output. `text` (the default): the end of what it prints. */
  output: z.enum(['text', 'json']).optional(),
  retries: retries.optional(),
}).strict()
const decisionStep = z.object({
  id: stepId, kind: z.literal('decision'), title: title.optional(),
  question: z.string().trim().min(1).max(2000),
  /** A note the user may write with their answer, which later steps read as `steps.<id>.note`. */
  note: z.object({ label: z.string().trim().min(1).max(200), required: z.boolean().optional() }).strict().optional(),
}).strict()

export const playbookStepSchema = z.discriminatedUnion('kind', [agentStep, codeStep, decisionStep])
export type PlaybookStep = z.infer<typeof playbookStepSchema>

/** A template's references: `{{inputs.name}}` and `{{steps.id.part}}` or `{{steps.id.output.field}}`. */
const REFERENCE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu
const HAS_REFERENCE = /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/u

function references(text: string): string[] {
  return [...text.matchAll(REFERENCE)].map(match => match[1]!)
}

/** Why a reference in step `index` names nothing it may read, or undefined when it reads something real. */
function referenceProblem(reference: string, index: number, steps: readonly PlaybookStep[], inputs: Readonly<Record<string, PlaybookInput>>): string | undefined {
  const parts = reference.split('.')
  if (parts[0] === 'inputs') return parts.length === 2 && Object.hasOwn(inputs, parts[1]!) ? undefined : `{{${reference}}} names no declared input.`
  if (parts[0] !== 'steps' || parts.length < 3) return `{{${reference}}} is not inputs.<name> or steps.<id>.<part>.`
  const at = steps.findIndex(step => step.id === parts[1])
  if (at < 0 || at >= index) return `{{${reference}}} names no earlier step.`
  const step = steps[at]!, part = parts[2]
  if (step.kind === 'agent') {
    if (part === 'reply' && parts.length === 3) return undefined
    if (part === 'output' && parts.length === 4 && step.output && Object.hasOwn(step.output.properties, parts[3]!)) return undefined
  } else if (step.kind === 'code') {
    if ((part === 'stdout' || part === 'exitCode') && parts.length === 3) return undefined
    if (part === 'output' && parts.length === 4 && step.output === 'json') return undefined
  } else if (part === 'note' && parts.length === 3) return undefined
  return `{{${reference}}} names nothing step ${step.id} hands on.`
}

export const playbookDefinitionSchema = z.object({
  format: z.literal(PLAYBOOK_FORMAT),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  /** The most runs of this playbook at once, across every task; one when left out. */
  concurrency: z.number().int().min(1).max(PLAYBOOK_CONCURRENCY_MAX).optional(),
  inputs: z.record(inputName, inputSchema).optional(),
  steps: z.array(playbookStepSchema).min(1).max(PLAYBOOK_STEPS_MAX),
}).strict()

/** A prompt task stores its one synthetic step without interpreting the prompt as a template. */
export const literalPromptDefinitionSchema = playbookDefinitionSchema.extend({
  steps: z.tuple([agentStep.extend({ id: z.literal('prompt') })]),
})

export const playbookSchema = playbookDefinitionSchema.superRefine((playbook, context) => {
  const inputs = playbook.inputs ?? {}
  if (Object.keys(inputs).length > 50) context.addIssue({ code: 'custom', path: ['inputs'], message: 'Use at most 50 inputs.' })
  const seen = new Set<string>()
  playbook.steps.forEach((step, index) => {
    const problem = (message: string): void => { context.addIssue({ code: 'custom', path: ['steps', index], message }) }
    if (seen.has(step.id)) problem(`Step id ${step.id} is used twice.`)
    seen.add(step.id)
    const earlierAgent = (id: string | undefined): boolean => id === undefined || playbook.steps.slice(0, index).some(item => item.id === id && item.kind === 'agent')
    if (step.kind === 'agent') {
      if (!earlierAgent(step.thread)) problem(`Step ${step.id} goes on in ${step.thread}, which is not an earlier agent step.`)
      if (step.thread && step.workingCopy) problem(`Step ${step.id} goes on in another step's thread, so it can't choose a working copy.`)
      for (const name of step.output?.required ?? []) if (!Object.hasOwn(step.output!.properties, name)) problem(`Step ${step.id} requires ${name}, which its output does not name.`)
      for (const reference of references(step.prompt)) { const why = referenceProblem(reference, index, playbook.steps, inputs); if (why) problem(why) }
    }
    if (step.kind === 'code' && !earlierAgent(step.in)) problem(`Step ${step.id} runs in ${step.in}, which is not an earlier agent step.`)
    if (step.kind === 'code' && step.run.some(argument => HAS_REFERENCE.test(argument))) problem(`Step ${step.id} puts a {{reference}} in its command. Read inputs from SOTTO_PLAYBOOK_INPUTS instead.`)
    if (step.kind === 'decision') for (const reference of references(step.question)) { const why = referenceProblem(reference, index, playbook.steps, inputs); if (why) problem(why) }
  })
})
export type Playbook = z.infer<typeof playbookSchema>

/** A step's name on screen: its title, or its id. */
export const stepTitle = (step: Pick<PlaybookStep, 'id' | 'title'>): string => step.title ?? step.id

/** What a run has to fill its templates with. `outside` names the inputs a webhook or GitHub filled. */
export interface PlaybookContext {
  readonly inputs: Readonly<Record<string, PlaybookValue>>
  readonly steps: Readonly<Record<string, { readonly output?: unknown; readonly reply?: string; readonly note?: string; readonly stdout?: string; readonly exitCode?: number }>>
  readonly outside: ReadonlySet<string>
}

const valueText = (value: unknown): string => value === undefined || value === null ? '' : typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(String).join(', ') : String(value)

/**
 * A template with its references filled. An input that came from outside Sotto goes in as a quoted JSON string, so
 * where it starts and ends is plain to the model; the run says beside it whose words those are.
 */
export function fillTemplate(template: string, context: PlaybookContext): string {
  return template.replace(REFERENCE, (_whole, reference: string) => {
    const parts = reference.split('.')
    if (parts[0] === 'inputs') {
      const value = context.inputs[parts[1]!]
      return context.outside.has(parts[1]!) ? JSON.stringify(valueText(value)) : valueText(value)
    }
    const step = context.steps[parts[1]!]
    if (!step) return ''
    if (parts[2] === 'output') return valueText((step.output as Record<string, unknown> | undefined)?.[parts[3]!])
    return valueText(step[parts[2] as 'reply' | 'note' | 'stdout' | 'exitCode'])
  })
}

/** The words an agent step with an output ends its prompt with: how to hand the output back. */
export function outputInstruction(output: PlaybookOutput): string {
  const fields = Object.entries(output.properties).map(([name, field]) =>
    `- ${name} (${field.type === 'string[]' ? 'array of strings' : field.type}${(output.required ?? []).includes(name) ? ', required' : ''})${field.description ? `: ${field.description}` : ''}`)
  return [`End your reply with one fenced block tagged ${PLAYBOOK_OUTPUT_FENCE} that holds a JSON object with these fields:`, ...fields,
    '', 'For example:', '```' + PLAYBOOK_OUTPUT_FENCE, '{ … }', '```'].join('\n')
}

const OUTPUT_BLOCK = new RegExp('```' + PLAYBOOK_OUTPUT_FENCE + '[^\\n]*\\n([\\s\\S]*?)```', 'gu')

/**
 * The output a reply's last `sotto-output` block hands back, checked against what the step declares: fields it does not
 * name are dropped, and a missing required field or a field of the wrong type is refused with why.
 */
export function readOutputBlock(text: string, output: PlaybookOutput): { readonly ok: true; readonly value: Record<string, PlaybookValue | string[]> } | { readonly ok: false; readonly reason: string } {
  const blocks = [...text.matchAll(OUTPUT_BLOCK)]
  const last = blocks.at(-1)?.[1]
  if (last === undefined) return { ok: false, reason: `the reply has no ${PLAYBOOK_OUTPUT_FENCE} block` }
  let parsed: unknown
  try { parsed = JSON.parse(last) } catch { return { ok: false, reason: `its ${PLAYBOOK_OUTPUT_FENCE} block is not JSON` } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: `its ${PLAYBOOK_OUTPUT_FENCE} block is not a JSON object` }
  const value: Record<string, PlaybookValue | string[]> = {}
  for (const [name, field] of Object.entries(output.properties)) {
    const given = (parsed as Record<string, unknown>)[name]
    if (given === undefined || given === null) {
      if ((output.required ?? []).includes(name)) return { ok: false, reason: `it leaves out ${name}` }
      continue
    }
    const fits = field.type === 'string[]' ? Array.isArray(given) && given.every(item => typeof item === 'string') : typeof given === field.type && (field.type !== 'number' || Number.isFinite(given))
    if (!fits) return { ok: false, reason: `${name} is not a ${field.type === 'string[]' ? 'list of strings' : field.type}` }
    value[name] = given as PlaybookValue | string[]
  }
  if (JSON.stringify(value).length > PLAYBOOK_OUTPUT_BYTES_MAX) return { ok: false, reason: 'it is longer than 16 KB' }
  return { ok: true, value }
}

/**
 * A run's inputs from the values given: each declared input takes its value, its default, or nothing, converted to its
 * type where that is plain (`"3"` for a number). Values nothing declares are dropped: what comes from outside fills only
 * what the playbook asks for. Problems say which required input is missing or can't be read.
 */
export function bindInputs(declared: Readonly<Record<string, PlaybookInput>>, given: Readonly<Record<string, unknown>>): { readonly inputs: Record<string, PlaybookValue>; readonly problems: readonly string[] } {
  const inputs: Record<string, PlaybookValue> = {}
  const problems: string[] = []
  for (const [name, input] of Object.entries(declared)) {
    const raw = Object.hasOwn(given, name) ? given[name] : undefined
    const empty = raw === undefined || raw === null || raw === ''
    const value = empty ? input.default : convert(raw, input.type)
    if (value === undefined && !empty) { problems.push(`${name} should be a ${input.type}.`); continue }
    if (value === undefined) { if (input.required) problems.push(`${name} is required.`); continue }
    if (typeof value !== input.type) { problems.push(`${name} should be a ${input.type}.`); continue }
    inputs[name] = typeof value === 'string' ? value.slice(0, 8000) : value
  }
  if (JSON.stringify(inputs).length > PLAYBOOK_OUTPUT_BYTES_MAX) problems.push('The inputs are longer than 16 KB.')
  return { inputs, problems }
}

function convert(raw: unknown, type: PlaybookInput['type']): PlaybookValue | undefined {
  if (type === 'string') return typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : Array.isArray(raw) ? raw.map(String).join(', ') : undefined
  if (type === 'number') { const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN; return Number.isFinite(number) ? number : undefined }
  return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : undefined
}

/**
 * The playbook Add the example writes, as `triage-and-fix.json`: triage a GitHub issue, ask the user whether to fix it,
 * fix it in a worktree, run the checks there, and ask once more before the pull request.
 */
export const EXAMPLE_PLAYBOOK_ID = 'triage-and-fix'
export const EXAMPLE_PLAYBOOK: Playbook = {
  format: PLAYBOOK_FORMAT,
  name: 'Triage and fix an issue',
  description: 'Reads an issue, asks you whether to fix it, fixes it in a worktree, runs the checks there and asks you before opening a pull request.',
  concurrency: 1,
  inputs: {
    title: { type: 'string', description: 'The issue title', required: true },
    body: { type: 'string', description: 'The issue text' },
    number: { type: 'number', description: 'The issue number' },
    url: { type: 'string', description: 'The issue address' },
  },
  steps: [
    { id: 'triage', kind: 'agent', title: 'Triage', workingCopy: 'shared', prompt: 'Triage issue {{inputs.number}} ({{inputs.url}}).\n\nTitle: {{inputs.title}}\n\n{{inputs.body}}\n\nRead the code it concerns. Say whether it is a real problem, how big a fix is, and what you would change. Change nothing yet.',
      output: { properties: { summary: { type: 'string', description: 'Two sentences on what is wrong' }, worthFixing: { type: 'boolean' }, plan: { type: 'string', description: 'What you would change' } }, required: ['summary', 'worthFixing'] } },
    { id: 'decide', kind: 'decision', title: 'Fix it?', question: 'Triage says: {{steps.triage.output.summary}}\n\nFix this issue in a new worktree?', note: { label: 'Anything the fix should know' } },
    { id: 'fix', kind: 'agent', title: 'Fix', workingCopy: 'worktree', retries: 1, prompt: 'Fix issue {{inputs.number}}: {{inputs.title}}.\n\nThe plan from triage: {{steps.triage.output.plan}}\n\nThe user added: {{steps.decide.note}}\n\nCommit your change on this branch. Don\'t push and don\'t open a pull request.',
      output: { properties: { summary: { type: 'string', description: 'What you changed' } }, required: ['summary'] } },
    { id: 'checks', kind: 'code', title: 'Checks', in: 'fix', run: ['npm', 'test'], timeoutMinutes: 30 },
    { id: 'review', kind: 'decision', title: 'Open a pull request?', question: 'The fix: {{steps.fix.output.summary}}\n\nThe checks passed. Open a pull request?' },
    { id: 'pull-request', kind: 'agent', title: 'Pull request', thread: 'fix', prompt: 'Push this branch and open a pull request for issue {{inputs.number}}, describing the change.' },
  ],
}
