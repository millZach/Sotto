import { AGENT_TEXT_MAX, type AgentRequest } from '../../shared/agents'

type Input = Readonly<Record<string, unknown>>
type CardContext = Pick<NonNullable<AgentRequest['context']>, 'command' | 'summary' | 'action' | 'target' | 'cwd' | 'details'>
/**
 * A tool's input as a permission card shows it (ADR-0185). `text` is the request's own words for what reads only those.
 * These words stay English, as every adapter's do: an adapter also runs in the headless host, which sets no language, so a
 * translation function here would throw and lose the request.
 */
export interface ToolInputCard { readonly text: string; readonly context: CardContext }

const CUT = '\n… The rest does not fit here.'
/** Room for the sentence or two a model writes, not for a long text put where its summary goes. */
const SUMMARY_MAX = 600
/** Says nothing about what a command would do, so a card leaves it out. Anything else a tool sends is shown. */
const COMMAND_TIMING = new Set(['timeout', 'timeout_ms', 'timeoutMs'])
const COMMAND_PLACE = ['cwd', 'workdir']
const COMMAND_FIELDS = new Set(['command', 'description', ...COMMAND_TIMING, ...COMMAND_PLACE])
/** The settings that change what a command is allowed, in words, so the card can say them plainly. */
const COMMAND_SETTINGS: Readonly<Record<string, string>> = {
  dangerouslyDisableSandbox: 'It also asks to run outside the sandbox.',
  run_in_background: 'It runs in the background.',
}
const ACTIONS = {
  Edit: 'Edit a file', MultiEdit: 'Edit a file', Write: 'Write a file', NotebookEdit: 'Edit a notebook', Read: 'Read a file',
  WebFetch: 'Fetch a web page', WebSearch: 'Search the web', Glob: 'Search files', Grep: 'Search files', Agent: 'Start a subagent', Task: 'Start a subagent',
} as const
const TARGETS = ['file_path', 'filePath', 'notebook_path', 'path', 'url', 'query', 'pattern']
const FILE_TARGETS = TARGETS.slice(0, 4)

const words = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
const collapse = (value: string): string => value.split(/\s+/u).filter(Boolean).join(' ')
export const asObject = (value: unknown): Input | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Input : undefined

/** The model's own words for what it asks, on one line and of a bounded length; none when they only repeat the command. */
export function modelSummary(said: unknown, command?: string): string | undefined {
  const text = words(said) && collapse(said as string)
  if (!text || text === (command && collapse(command))) return undefined
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text
}

function fieldLines(name: string, value: unknown): string[] {
  if (value === null || typeof value !== 'object') {
    const text = String(value)
    return text.includes('\n') ? [`${name}:`, ...text.split('\n').map(line => `  ${line}`)] : [`${name}: ${text}`]
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return [`${name}: none`]
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return fieldLines(name, value.join(', '))
  return entries.flatMap(([key, item]) => fieldLines(`${name}.${key}`, item))
}

/** Text for a card, cut only with a line saying so, so a long input never reads as the whole of it. */
export function boundedDetails(text: string): string {
  if (text.length <= AGENT_TEXT_MAX) return text
  return text.slice(0, AGENT_TEXT_MAX - CUT.length) + CUT
}

/**
 * Whatever a provider sends as a tool's input, as fields to show: an object as it is, a JSON text as what it holds, and
 * anything else, such as a list or plain text, under one name so that it shows too.
 */
export function inputFields(value: unknown): Input {
  if (value === undefined) return {}
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object') return inputFields(parsed)
    } catch { /* Plain text, shown below as it is. */ }
  }
  return asObject(value) ?? { input: value }
}

/** Every field of a tool's input by name, in plain lines: no JSON, and nothing left out. Undefined when there are none. */
export function readableFields(input: Input): string | undefined {
  const lines = Object.entries(input).filter(([, value]) => value !== undefined).flatMap(([name, value]) => fieldLines(name, value))
  return lines.length ? boundedDetails(lines.join('\n')) : undefined
}

/** A command as its card shows it: the command, the model's summary if it gave one, and any setting beyond them. */
export function commandCard(command: string, input: Input = {}): ToolInputCard {
  const summary = modelSummary(input.description, command)
  const cwd = COMMAND_PLACE.map(name => words(input[name])).find(Boolean)
  const settings = Object.entries(input).filter(([name]) => !COMMAND_FIELDS.has(name)).flatMap(([name, value]) => {
    const said = COMMAND_SETTINGS[name]
    if (said && value === true) return [said]
    return said && value === false ? [] : fieldLines(name, value)
  })
  return { text: `Run a command${summary ? `: ${summary}` : ''}\n${command}`.slice(0, AGENT_TEXT_MAX),
    context: { command, ...(summary ? { summary } : {}), ...(cwd ? { cwd } : {}), ...(settings.length ? { details: boundedDetails(settings.join('\n')) } : {}) } }
}

function changeLines(input: Input): string[] {
  const lines = (mark: string, value: unknown): string[] => (value as string).split('\n').map(line => `${mark} ${line}`)
  return typeof input.old_string === 'string' && typeof input.new_string === 'string'
    ? [...lines('-', input.old_string), ...lines('+', input.new_string)] : []
}

type ActionKey = keyof typeof ACTIONS
const isActionKey = (tool: string): tool is ActionKey => Object.hasOwn(ACTIONS, tool)

/** The action Sotto has words for: the tool's own, or what an unnamed tool's fields show it to be. */
function actionKey(tool: string | undefined, input: Input): ActionKey | undefined {
  if (tool && isActionKey(tool)) return tool
  if (tool?.startsWith('mcp__')) return undefined
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') return 'Edit'
  return typeof input.content === 'string' && FILE_TARGETS.some(name => words(input[name])) ? 'Write' : undefined
}

function mcpAction(tool: string | undefined): string | undefined {
  const named = tool?.match(/^mcp__(.+?)__(.+)$/u)
  return named ? `Use ${named[2]} from ${named[1]}` : undefined
}

/**
 * A request that is not a command, as its card shows it: what it does, then its path or address, then every other field.
 * A tool Sotto has no words for still shows every field, under the name `fallback` gives it or `Use <tool>`.
 */
export function otherRequestCard(input: Input, tool?: string, fallback?: string): ToolInputCard {
  const key = actionKey(tool, input)
  const action = key ? ACTIONS[key] : mcpAction(tool) ?? words(fallback) ?? (tool ? `Use ${tool}` : 'Use a tool')
  const targetName = key ? TARGETS.find(name => words(input[name])) : undefined
  const target = targetName ? words(input[targetName]) : undefined
  const summary = modelSummary(input.description)
  const change = changeLines(input)
  const written = key === 'Write' && typeof input.content === 'string' ? input.content : undefined
  const rest = Object.fromEntries(Object.entries(input).filter(([name]) => name !== targetName && !(summary && name === 'description')
    && !(change.length && (name === 'old_string' || name === 'new_string')) && !(written !== undefined && name === 'content')))
  const fields = readableFields(rest)
  const body = [...change, ...written === undefined ? [] : [written], ...fields ? [fields] : []].join('\n')
  return { text: target ? `${action}: ${target}` : action,
    context: { action, ...(target ? { target } : {}), ...(summary ? { summary } : {}), ...(body ? { details: boundedDetails(body) } : {}) } }
}

/** A tool's input as its card shows it: a command if it runs one, and otherwise `otherRequestCard`. An MCP tool's `command` field is only a field. */
export function toolInputCard(input: Input, tool?: string, fallback?: string): ToolInputCard {
  const command = words(input.command)
  return command && !tool?.startsWith('mcp__') ? commandCard(command, input) : otherRequestCard(input, tool, fallback)
}

/** A card whose provider's request already says what it does: those words head it, and its target only where they don't name it. */
export function cardUnderHeadline({ context: { target, ...context } }: ToolInputCard, headline: string): CardContext {
  return { ...context, action: headline, ...(target && !headline.includes(target) ? { target } : {}) }
}

/** The heading of a card for the files a request would change. */
export const changeFilesAction = (count: number): string => count === 1 ? 'Change a file' : `Change ${count} files`
