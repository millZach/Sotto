import { BROWSER_MCP_SERVER } from './browserAgentServer'

type Frame = Record<string, unknown>
const frame = (value: unknown): Frame => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Frame : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

/**
 * Sotto's own browser tools, said in the words the user would use. A native tool carries no
 * description in the frame it asks with, so without this a card is the tool's name and its arguments
 * and nothing else. Sotto owns these six names and can say honestly what each would do; a tool from
 * anyone else's server keeps the name it came with, because Sotto cannot describe it.
 *
 * Each client spells the name its own way, so the caller passes whatever it holds: Claude Code's
 * `mcp__sotto_browser__browser_open`, Grok's `sotto_browser__browser_open`, or the bare tool name
 * beside a server Codex names separately. Anything else returns undefined and keeps its own card.
 */
export function sottoBrowserTool(name: string, server?: string): string | undefined {
  for (const prefix of [`mcp__${BROWSER_MCP_SERVER}__`, `${BROWSER_MCP_SERVER}__`]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return server === BROWSER_MCP_SERVER && name.startsWith('browser_') ? name : undefined
}

function browserAction(action: Frame): string {
  const url = text(action.url)
  if (action.type === 'inspect') return 'look at the page'
  if (action.type === 'screenshot') return 'take a picture of the page'
  if (action.type === 'navigate') return url ? 'go to ' + url : 'go to another page'
  if (action.type === 'click') return 'click in the page'
  if (action.type === 'type') return 'type into the page'
  if (action.type === 'scroll') return 'scroll the page'
  if (action.type === 'viewport') return 'change the page size'
  return 'work in the page'
}

/** The card for one of Sotto's browser tools, or undefined for a tool Sotto does not own. */
export function browserRequestText(name: string, input: unknown, server?: string): string | undefined {
  const tool = sottoBrowserTool(name, server)
  if (tool === undefined) return undefined
  const args = frame(input)
  const url = text(args.url)
  const said = tool === 'browser_pages' ? 'list the pages this thread has open'
    : tool === 'browser_status' ? 'check how its browser task is going'
      : tool === 'browser_start' ? 'start a browser task on a page you shared'
        : tool === 'browser_open' ? url ? 'open ' + url : 'open a page'
          : tool === 'browser_action' ? browserAction(frame(args.action))
            : tool === 'browser_finish' ? 'finish its browser task as ' + (args.status === 'failed' ? 'failed' : 'done')
              : ''
  if (!said) return undefined
  const why = text(args.description).trim() ? '\n“' + text(args.description).trim() + '”' : ''
  // Answering here only lets it reach the browser. Every page action asks again in Tools (ADR-0020).
  return 'Use Sotto’s browser to ' + said + '.' + why + '\nOpening a page, going to another, clicking and typing still ask you in Tools.'
}
