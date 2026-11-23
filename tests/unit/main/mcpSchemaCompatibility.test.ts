// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { COUNCIL_TOOL_DEFINITIONS } from '../../../src/main/agents/councilTools'
import { COORDINATION_TOOL_DEFINITIONS } from '../../../src/main/agents/threadCoordinationTools'
import {
  delegationToolDefinitions,
  type DelegationPlace,
} from '../../../src/main/agents/delegationTools'
import { showInThreadDefinition } from '../../../src/main/agents/mediaTools'
import { pullRequestToolDefinitions } from '../../../src/main/agents/pullRequestTools'
import {
  readyToMergeDefinition,
  tellWatcherDefinition,
} from '../../../src/main/agents/tellWatcherTools'
import type { ThreadToolDefinition } from '../../../src/main/agents/threadToolServer'
import { visualizeDefinition } from '../../../src/main/agents/visualTools'
import {
  ASK_USER_DEFINITION,
  PARK_THREAD_DEFINITION,
  PROPOSE_MOVES_DEFINITION,
  TEAM_TOOL_DEFINITIONS,
  watcherToolDefinitions,
} from '../../../src/main/agents/watcherTools'
import {
  hostSetupToolDefinitions,
  providerJobToolDefinitions,
} from '../../../src/main/hosts/hostSetupTools'
import { makeSoundDefinition } from '../../../src/main/plugins/elevenlabs/tool'
import { makeModelDefinition } from '../../../src/main/plugins/meshy/tool'
import {
  gitHubCloseIssueDefinition,
  gitHubCommentDefinition,
  gitHubOpenIssueDefinition,
  gitHubReopenIssueDefinition,
  mailSendDefinition,
  pluginAccountsDefinition,
  pluginReadDefinition,
  vercelCancelDefinition,
  vercelPromoteDefinition,
  vercelRollbackDefinition,
} from '../../../src/main/plugins/pluginTools'
import {
  browserToolDefinitions,
  hostBrowserToolDefinitions,
} from '../../../src/main/tools/browserAgentTools'

type ToolEntry = {
  server: string
  variant: string
  definition: ThreadToolDefinition
}

type PatternIssue = {
  server: string
  variant: string
  tool: string
  pointer: string
  pattern: string
  reason: string
}

function findUnsupportedRe2Construct(pattern: string): string | null {
  let inCharClass = false
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1]
      if (!inCharClass && next !== undefined) {
        if (next >= '1' && next <= '9') {
          return `numeric backreference \\${next}`
        }
        if (next === 'k' && pattern[i + 2] === '<') {
          return 'named backreference \\k<...>'
        }
      }
      i += 2
      continue
    }
    if (inCharClass) {
      if (ch === ']') {
        inCharClass = false
      }
      i += 1
      continue
    }
    if (ch === '[') {
      inCharClass = true
      i += 1
      continue
    }
    if (ch === '(' && pattern[i + 1] === '?') {
      const head3 = pattern.slice(i, i + 3)
      const head4 = pattern.slice(i, i + 4)
      if (head3 === '(?=' || head3 === '(?!') {
        return `lookahead ${head3}...`
      }
      if (head4 === '(?<=' || head4 === '(?<!') {
        return `lookbehind ${head4}...`
      }
    }
    i += 1
  }
  return null
}

function collectPatternIssues(
  node: unknown,
  context: { server: string; variant: string; tool: string; pointer: string },
  issues: PatternIssue[],
): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      collectPatternIssues(
        node[i],
        { ...context, pointer: `${context.pointer}/${i}` },
        issues,
      )
    }
    return
  }
  if (!node || typeof node !== 'object') {
    return
  }
  const record = node as Record<string, unknown>
  if (typeof record.pattern === 'string') {
    const unsupported = findUnsupportedRe2Construct(record.pattern)
    if (unsupported) {
      issues.push({
        ...context,
        pointer: `${context.pointer}/pattern`,
        pattern: record.pattern,
        reason: unsupported,
      })
    }
    try {
      new RegExp(record.pattern)
    } catch (error) {
      issues.push({
        ...context,
        pointer: `${context.pointer}/pattern`,
        pattern: record.pattern,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (
    record.patternProperties &&
    typeof record.patternProperties === 'object' &&
    !Array.isArray(record.patternProperties)
  ) {
    for (const key of Object.keys(
      record.patternProperties as Record<string, unknown>,
    )) {
      const unsupported = findUnsupportedRe2Construct(key)
      if (unsupported) {
        issues.push({
          ...context,
          pointer: `${context.pointer}/patternProperties/${key}`,
          pattern: key,
          reason: unsupported,
        })
      }
      try {
        new RegExp(key)
      } catch (error) {
        issues.push({
          ...context,
          pointer: `${context.pointer}/patternProperties/${key}`,
          pattern: key,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  for (const [key, value] of Object.entries(record)) {
    collectPatternIssues(
      value,
      { ...context, pointer: `${context.pointer}/${key}` },
      issues,
    )
  }
}

function collectAllMcpTools(): ToolEntry[] {
  const entries: ToolEntry[] = []
  const push = (
    server: string,
    variant: string,
    definitions: readonly ThreadToolDefinition[],
  ): void => {
    for (const definition of definitions) {
      entries.push({ server, variant, definition })
    }
  }

  push('sotto_browser', 'desktop', browserToolDefinitions)
  push('sotto_browser', 'host', hostBrowserToolDefinitions)

  for (const roles of [false, true]) {
    for (const machines of [false, true]) {
      for (const swarms of [false, true]) {
        push(
          'sotto_threads',
          `roles=${roles},machines=${machines},swarms=${swarms}`,
          watcherToolDefinitions(roles, machines, swarms),
        )
      }
    }
  }
  push('sotto_threads', 'static', [
    ASK_USER_DEFINITION,
    PARK_THREAD_DEFINITION,
    PROPOSE_MOVES_DEFINITION,
    ...TEAM_TOOL_DEFINITIONS,
  ])

  const places: readonly DelegationPlace[] = ['this-computer', 'this-machine']
  for (const roles of [false, true]) {
    for (const machines of [false, true]) {
      for (const place of places) {
        for (const relay of [false, true]) {
          for (const swarms of [false, true]) {
            for (const dynamic of [false, true]) {
              push(
                'sotto_delegate',
                `roles=${roles},machines=${machines},place=${place},relay=${relay},swarms=${swarms},dynamic=${dynamic}`,
                delegationToolDefinitions(
                  roles,
                  machines,
                  place,
                  relay,
                  swarms,
                  dynamic,
                ),
              )
            }
          }
        }
      }
    }
  }

  push('sotto_council', 'default', COUNCIL_TOOL_DEFINITIONS)
  push('sotto_coordinate', 'default', COORDINATION_TOOL_DEFINITIONS)
  push('sotto_media', 'default', [showInThreadDefinition])
  push('sotto_pull_requests', 'default', pullRequestToolDefinitions)
  push('sotto_watcher', 'default', [
    readyToMergeDefinition,
    tellWatcherDefinition,
  ])
  push('sotto_visual', 'default', [visualizeDefinition])
  push('sotto_host_setup', 'host', hostSetupToolDefinitions)
  push('sotto_host_setup', 'provider-jobs', providerJobToolDefinitions)
  push('sotto_plugins', 'default', [
    pluginAccountsDefinition,
    pluginReadDefinition,
    gitHubCommentDefinition,
    gitHubOpenIssueDefinition,
    gitHubCloseIssueDefinition,
    gitHubReopenIssueDefinition,
    vercelCancelDefinition,
    vercelPromoteDefinition,
    vercelRollbackDefinition,
    mailSendDefinition,
    makeModelDefinition,
    makeSoundDefinition,
  ])

  return entries
}

describe('MCP tool schema compatibility across every Sotto server', () => {
  const tools = collectAllMcpTools()

  it('rejects RE2-incompatible regexes and non-object root schemas on all MCP tools', () => {
    const patternIssues: PatternIssue[] = []
    const rootSchemaIssues: Array<{
      server: string
      variant: string
      tool: string
      field: 'inputSchema' | 'outputSchema'
      actualType: unknown
    }> = []

    for (const { server, variant, definition } of tools) {
      if (definition.inputSchema.type !== 'object') {
        rootSchemaIssues.push({
          server,
          variant,
          tool: definition.name,
          field: 'inputSchema',
          actualType: definition.inputSchema.type,
        })
      }
      collectPatternIssues(
        definition.inputSchema,
        {
          server,
          variant,
          tool: definition.name,
          pointer: '#inputSchema',
        },
        patternIssues,
      )

      if (definition.outputSchema !== undefined) {
        if (definition.outputSchema.type !== 'object') {
          rootSchemaIssues.push({
            server,
            variant,
            tool: definition.name,
            field: 'outputSchema',
            actualType: definition.outputSchema.type,
          })
        }
        collectPatternIssues(
          definition.outputSchema,
          {
            server,
            variant,
            tool: definition.name,
            pointer: '#outputSchema',
          },
          patternIssues,
        )
      }
    }

    expect(patternIssues).toEqual([])
    expect(rootSchemaIssues).toEqual([])
  })

  it('emits valid object-typed outputSchema on every Watcher and Team tool that advertises one', () => {
    const outputTools = [
      ...watcherToolDefinitions(true, true, true),
      ASK_USER_DEFINITION,
      PROPOSE_MOVES_DEFINITION,
      ...TEAM_TOOL_DEFINITIONS,
    ].filter((tool) => tool.outputSchema !== undefined)

    expect(outputTools.length).toBeGreaterThanOrEqual(5)
    for (const tool of outputTools) {
      expect(tool.outputSchema?.type).toBe('object')
    }
  })

  it('keeps the RE2 scanner accurate on character classes and backreferences', () => {
    expect(findUnsupportedRe2Construct('^(?!\\.\\.?$)[A-Za-z]+$')).toContain(
      'lookahead',
    )
    expect(findUnsupportedRe2Construct('(?<=a)b')).toContain('lookbehind')
    expect(findUnsupportedRe2Construct('(a)\\1')).toContain(
      'numeric backreference',
    )
    expect(findUnsupportedRe2Construct('[(?!]a+')).toBeNull()
    expect(findUnsupportedRe2Construct('^(?:[A-Za-z0-9_-][A-Za-z0-9._-]?)$')).toBeNull()
  })
})
