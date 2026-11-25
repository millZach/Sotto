import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityAcpHost } from '../../src/main/agents/antigravity'
import type { ChildProcessRow } from '../../src/main/agents/detachedRunScan'
import { questionInstructions } from '../../src/main/agents/questionInstructions'
import { watcherNewsText, watcherReplyStart } from '../../src/main/agents/watcherNews'
import { watcherNewestTurnReply } from '../../src/main/agents/watcherOutcomes'
import { WatcherWakeUp } from '../../src/main/agents/watcherWakeUp'
import { agentBackgroundWorkSchema } from '../../src/shared/agentMonitoring'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { WatcherNews } from '../../src/shared/watcherNews'
import { emptyWatcherRecord, type WatcherRecord } from '../../src/shared/watcher'

const FAKE_AGENT_SOURCE = `
import { readFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [,, statePath, configPath] = process.argv
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (process.argv.includes('--version')) {
  process.stdout.write('1.5.14\\n')
  process.exit(0)
}
const write = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
const log = entry => appendFileSync(statePath, JSON.stringify(entry) + '\\n')

let nextSession = 1
const openPrompts = []
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method) log({ method: msg.method, params: msg.params })
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy', version: '1.5.14' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {} },
          _meta: { antigravity: { systemPrompt: { append: !config.noAppend } } },
        },
      },
    })
    return
  }
  if (msg.method === 'authenticate' || msg.method === 'session/set_config_option' || msg.method === 'session/set_mode' || msg.method === 'session/close') {
    write({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'session/new' || msg.method === 'session/resume') {
    const sessionId = msg.params?.sessionId ?? ('sess-' + (nextSession++))
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId,
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'gemini-3.1-pro', options: [{ value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }] },
        ],
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Ask' }] },
      },
    })
    return
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId
    const promptText = msg.params.prompt?.[0]?.text ?? ''
    if (promptText.includes('premature-bg-command')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-1',
        title: 'Running npm test',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm test', IsBackground: true },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Waiting for background tests to finish.' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cmd-1',
          status: 'completed',
          rawOutput: { exitCode: 0, combinedOutput: 'all green' },
        } } })
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Tests passed; pushing branch.' },
          } } })
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'push-1',
            title: 'git push',
            kind: 'execute',
            status: 'completed',
            rawInput: { CommandLine: 'git push origin fix/demo' },
            rawOutput: { exitCode: 0 },
          } } })
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Tests passed and pushed PR.' },
          } } })
        }, 40)
      }, 60)
      return
    }
    if (promptText.includes('reactive-question')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working on options first.' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({
          jsonrpc: '2.0',
          id: 'elicitation-reactive-1',
          method: 'elicitation/create',
          params: {
            sessionId,
            mode: 'form',
            message: 'Pick one to continue.',
            requestedSchema: {
              type: 'object',
              properties: {
                q0: {
                  type: 'string',
                  title: 'Which option should I apply?',
                  oneOf: [
                    { const: 'a', title: 'Option A' },
                    { const: 'b', title: 'Option B' },
                  ],
                },
              },
              required: ['q0'],
            },
          },
        })
      }, 30)
      return
    }
    if (promptText.includes('post-turn-outlived-progress')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-outlived',
        title: 'Running npm run dev',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm run dev' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cmd-outlived',
          status: 'in_progress',
          rawOutput: { combinedOutput: 'ready on port 3000' },
        } } })
      }, 30)
      return
    }
    if (promptText.includes('delayed-thought-then-old-tool-done')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-row-1',
        title: 'Running vitest',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'vitest run' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Checking command result.' },
        } } })
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'cmd-row-1',
            status: 'completed',
            rawOutput: { exitCode: 0, combinedOutput: 'passed' },
          } } })
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'All green.' },
          } } })
        }, 30)
      }, 30)
      return
    }
    if (promptText.includes('streaming-during-look')) {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'cmd-wake-1',
          title: 'echo check',
          kind: 'execute',
          status: 'completed',
          rawInput: { CommandLine: 'echo check' },
          rawOutput: { exitCode: 0 },
        } } })
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Part 1 ' },
        } } })
        // With settleMs=80ms and childRows=120ms, settle enters lookBeforeEnd at ~80ms..200ms; Part 2 at 110ms lands mid-scan.
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Part 2' },
          } } })
        }, 110)
      }, 40)
      return
    }
    if (promptText.includes('slow-pause-after-tool')) {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'r-tool-1',
          title: 'Checking files',
          kind: 'read',
          status: 'in_progress',
        } } })
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'r-tool-1',
            status: 'completed',
          } } })
          // Pause 110ms (> 50ms settleMs, < 300ms waitMs) before text reply arrives
          setTimeout(() => {
            write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Delayed answer after tool.' },
            } } })
          }, 110)
        }, 20)
      }, 20)
      return
    }
    if (promptText.includes('lingering-reactive-tool')) {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'stuck-tool-1',
          title: 'Stuck check',
          kind: 'read',
          status: 'in_progress',
        } } })
      }, 20)
      return
    }
    if (promptText.includes('repeated-schedules-in-one-turn')) {
      // A release watch held in one turn: set a short wakeup, let it fire into the running turn with the timer's own prompt
      // (no "Task id … finished"), check, and set the next; the last wakeup is still pending when the turn ends.
      const schedule = (i, seconds) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'watch-sched-' + i,
        title: 'Run schedule',
        status: 'completed',
        rawInput: { DurationSeconds: seconds, Prompt: 'Check the Owl release ' + i },
        rawOutput: { status: 'scheduled', taskId: 'conv-w/sched-' + i },
      } } })
      const wake = i => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '<SYSTEM_MESSAGE>\\n[Message] timestamp=2026-11-24T00:00:00Z priority=HIGH content=Check the Owl release ' + i + '\\n</SYSTEM_MESSAGE>' },
      } } })
      const step = i => {
        if (i === 3) {
          schedule(i, 600)
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still building; checking again later.' } } } })
          write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
          return
        }
        schedule(i, 0.05)
        setTimeout(() => { wake(i); step(i + 1) }, 120)
      }
      step(0)
      return
    }
    if (promptText.includes('overflow-schedules-with-os-child')) {
      for (let i = 0; i < 64; i++) {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'sched-' + i,
          title: 'Run schedule',
          status: 'completed',
          rawInput: { DurationSeconds: 120, Prompt: 'Wait ' + i },
          rawOutput: { status: 'scheduled', taskId: 't-' + i },
        } } })
      }
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (promptText.includes('command-with-mcp-and-conhost')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-mcp-chk',
        title: 'echo ok',
        kind: 'execute',
        status: 'completed',
        rawInput: { CommandLine: 'echo ok' },
        rawOutput: { exitCode: 0 },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (promptText.includes('pending-perm-with-conhost')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'perm-win-1',
        title: '\`git status\`',
        kind: 'execute',
        status: 'pending',
        rawInput: { CommandLine: 'git status' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (promptText.includes('agy-midturn-start')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-mid-1',
        title: 'Running python long_job.py',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'python long_job.py', WaitMsBeforeAsync: 5000 },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-mid-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text',
          text: 'Tool is running as a background task with task id: conv-2/task-99\\nTask logs are available at: /tmp/mid.log\\nLog output:\\nStarted' } }],
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Running in background.' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (promptText.includes('agy-midturn-settle')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-mid-2',
        title: 'Running python second_job.py',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'python second_job.py', WaitMsBeforeAsync: 5000 },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-mid-2',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text',
          text: 'Tool is running as a background task with task id: conv-2/task-100\\nTask logs are available at: /tmp/mid2.log\\nLog output:\\nStarted' } }],
      } } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '<SYSTEM_MESSAGE>\\nBackground task conv-2/task-99 completed with exit code 0.\\n</SYSTEM_MESSAGE>' },
        } } })
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\\n\\n<SYSTEM_MESSAGE>\\n[Message] timestamp=2026-11-23T00:00:00Z sender=conv-2/task-100 priority=HIGH content=Task id "conv-2/task-100" finished with result:\\nCommand exited with code 0.\\n</SYSTEM_MESSAGE>' },
        } } })
      }, 40)
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'All tasks settled.' },
        } } })
        write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }, 140)
      return
    }
    if (promptText.includes('agy-pasted-user-system-msg')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '<SYSTEM_MESSAGE> user pasted fragment without closing tag' },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '[Message] timestamp=2026-11-23T00:00:00Z user pasted log header' },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Handled pasted messages.' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (promptText.includes('agy-held-bg-wakeup-no-steer')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-held-nosteer',
        title: 'Running python render.py',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'python render.py', WaitMsBeforeAsync: 5000 },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-held-nosteer',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text',
          text: 'Tool is running as a background task with task id: conv-nosteer/task-1\\nTask logs are available at: /tmp/nosteer.log\\nLog output:\\nStarted' } }],
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Started the render in the background.' },
      } } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '<SYSTEM_MESSAGE>\\nBackground task conv-nosteer/task-1 completed with exit code 0.\\n</SYSTEM_MESSAGE>' },
        } } })
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Render complete.' },
        } } })
        write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }, 60)
      return
    }
    if (promptText.includes('agy-midstream-count')) {
      openPrompts.push(msg.id)
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Counting 1,' },
      } } })
      return
    }
    if (promptText.includes('Make it shorter')) {
      openPrompts.push(msg.id)
      // Still-in-flight tail of the pre-steer reply arrives before agy starts on the steer.
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' 2, 3.' },
      } } })
      // Then agy echoes the steer, answers it, and later an external duplicate of the steer text arrives.
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: promptText },
        } } })
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Short.' },
        } } })
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: promptText },
          } } })
          for (const id of openPrompts.splice(0)) {
            write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
          }
        }, 30)
      }, 30)
      return
    }
    if (promptText.includes('agy-held-bg-start')) {
      openPrompts.push(msg.id)
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-held-1',
        title: 'Running python render.py',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'python render.py', WaitMsBeforeAsync: 5000 },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-held-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text',
          text: 'Tool is running as a background task with task id: conv-held/task-1\\nTask logs are available at: /tmp/held.log\\nLog output:\\nStarted' } }],
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Started the render in the background.' },
      } } })
      return
    }
    if (promptText.includes('How is the render going?')) {
      openPrompts.push(msg.id)
      // Echo the steered prompt as agy may, then reply directly without a thought or tool call while keeping session/prompt open.
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: promptText },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'The render is at 62%.' },
      } } })
      return
    }
    if (promptText.includes('agy-held-bg-finish')) {
      openPrompts.push(msg.id)
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '<SYSTEM_MESSAGE>\\nBackground task conv-held/task-1 completed with exit code 0.\\n</SYSTEM_MESSAGE>' },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Render complete.' },
      } } })
      for (const id of openPrompts.splice(0)) {
        write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
      }
      return
    }
    if (promptText.includes('agy-colab-render')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-colab-1',
        title: 'Running python render.py',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'python render.py', WaitMsBeforeAsync: 5000 },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-colab-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text',
          text: 'Tool is running as a background task with task id: conv-1/task-7\\nTask logs are available at: /tmp/colab.log\\nLog output:\\nSetup done\\n0 failed\\nWaiting on remote GPU...' } }],
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Started Colab render in background.' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '<SYSTEM_MESSAGE>\\nBackground task conv-1/task-7 completed with exit code 0.\\n</SYSTEM_MESSAGE>' },
        } } })
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'GPU DONE' },
        } } })
      }, 60)
      return
    }
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done.' },
    } } })
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
  }
})
`

describe('Antigravity ACP background work, reactive continuations, worker question prompts, and card resume', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function setup(options: {
    noAppend?: boolean
    childRows?: () => Promise<readonly ChildProcessRow[]> | readonly ChildProcessRow[]
    userMcpConfig?: string
    reactiveTurnSettleMs?: number
    reactiveTurnWaitMs?: number
    reactiveTurnMaxMs?: number
    lookBeforeEndMs?: number
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-agy-bg-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const projectDir = join(dir, 'repo')
    await mkdir(projectDir, { recursive: true })
    const scriptPath = join(dir, 'fake-agy.mjs')
    const statePath = join(dir, 'requests.jsonl')
    const configPath = join(dir, 'config.json')
    await writeFile(scriptPath, FAKE_AGENT_SOURCE, 'utf8')
    await writeFile(configPath, JSON.stringify({ noAppend: options.noAppend === true }), 'utf8')
    await writeFile(statePath, '', 'utf8')
    const host = new AntigravityAcpHost(dir, {
      executable: process.execPath,
      executableArgs: [scriptPath, statePath, configPath],
      requestTimeoutMs: 5_000,
      startTimeoutMs: 5_000,
      lookBeforeEndMs: options.lookBeforeEndMs ?? 150,
      reactiveTurnSettleMs: options.reactiveTurnSettleMs ?? 50,
      ...(options.reactiveTurnWaitMs !== undefined ? { reactiveTurnWaitMs: options.reactiveTurnWaitMs } : {}),
      ...(options.reactiveTurnMaxMs !== undefined ? { reactiveTurnMaxMs: options.reactiveTurnMaxMs } : {}),
      ...(options.userMcpConfig ? { userMcpConfig: options.userMcpConfig } : {}),
      ...(options.childRows ? { childProcesses: async () => await options.childRows!() } : { childProcesses: async () => [] }),
    })
    cleanups.push(async () => { host.disconnect(); await host.closed() })
    await host.connect()
    await host.execute({ type: 'create-project', commandId: 'cmd-proj-1', projectId: 'proj-1', title: 'Repo', path: projectDir })
    return { host, dir, projectDir, statePath }
  }

  it('passes strengthened questionInstructions to non-Watcher worker sessions when append capability is advertised', async () => {
    const withAppend = await setup({ noAppend: false })
    await withAppend.host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-w1',
      projectId: 'proj-1',
      threadId: 'thread-worker-1',
      title: 'Worker',
      modelId: 'gemini-3.1-pro',
    })
    const { readFileSync } = await import('node:fs')
    const entries = readFileSync(withAppend.statePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
    const sessionNew = entries.findLast(entry => entry.method === 'session/new')
    const append = (sessionNew?.params?._meta as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append
    expect(append).toBe(questionInstructions('ask_question', false))
    expect(append).toContain('Never write a plain-text "question card"')

    const withoutAppend = await setup({ noAppend: true })
    await withoutAppend.host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-w2',
      projectId: 'proj-1',
      threadId: 'thread-worker-2',
      title: 'Worker No Append',
      modelId: 'gemini-3.1-pro',
    })
    const entries2 = readFileSync(withoutAppend.statePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
    const sessionNew2 = entries2.findLast(entry => entry.method === 'session/new')
    expect(sessionNew2?.params?._meta).toBeUndefined()
  })

  it('surfaces active background work on premature end_turn and emits a fresh completion turn when reactive wakeup finishes', async () => {
    let liveChildRunning = true
    const { host } = await setup({
      childRows: () => liveChildRunning ? [{ pid: 9999, startedAt: Date.now() - 100, argv: ['bash', '-c', 'npm test'], marks: [] }] : [],
    })
    await host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-bg1',
      projectId: 'proj-1',
      threadId: 'thread-bg-1',
      title: 'BG Turn',
      modelId: 'gemini-3.1-pro',
    })

    let intermediateSnapshot: {
      status: string
      lastTurn?: { id: string; status: string } | undefined
      backgroundWork?: { id: string; label: string; type: string }[] | undefined
      activities?: { id: string; kind: string; status: string; turnId: string }[] | undefined
    } | undefined
    let sawReactiveRunning = false
    let latestThread: {
      status: string
      lastTurn?: { id: string; status: string } | undefined
      backgroundWork?: { id: string; label: string; type: string }[] | undefined
      messages: { role: string; text: string; turnMessageId?: string | undefined }[]
      activities?: { id: string; kind: string; status: string; turnId: string }[] | undefined
    } | undefined
    const trace: { status: string; lastTurn: string | undefined; bg: number; msgs: number }[] = []

    host.subscribe(snap => {
      const thread = snap.threads.find(t => t.id === 'thread-bg-1')
      if (!thread) return
      latestThread = thread
      trace.push({ status: thread.status, lastTurn: thread.lastTurn?.id, bg: thread.backgroundWork?.length ?? 0, msgs: thread.messages.length })
      if (thread.status === 'idle' && thread.lastTurn?.id === 'msg-1' && (thread.backgroundWork?.length ?? 0) > 0 && !intermediateSnapshot) {
        intermediateSnapshot = thread
      }
      if (thread.status === 'running' && thread.lastTurn?.id?.startsWith('msg-1:wakeup:')) {
        sawReactiveRunning = true
        liveChildRunning = false
      }
    })

    const result = await host.execute({
      type: 'send',
      threadId: 'thread-bg-1',
      commandId: 'cmd-send-1',
      messageId: 'msg-1',
      text: 'premature-bg-command',
    })
    expect(result).toEqual({ accepted: true })

    await expect.poll(() => intermediateSnapshot, { timeout: 3_000 }).toBeTruthy()
    expect(agentBackgroundWorkSchema.safeParse(intermediateSnapshot!.backgroundWork).success).toBe(true)
    expect(intermediateSnapshot!.backgroundWork).toHaveLength(1)
    const runningCmd = intermediateSnapshot!.activities?.find(act => act.kind === 'command' && act.turnId === 'msg-1')
    expect(runningCmd?.status).toBe('running')

    await expect.poll(() => ({ sawReactiveRunning, trace })).toMatchObject({ sawReactiveRunning: true })
    await expect.poll(() => latestThread?.status === 'idle' && latestThread?.lastTurn?.id !== 'msg-1' && !latestThread?.backgroundWork?.length).toBe(true)

    expect(latestThread?.lastTurn?.status).toBe('completed')
    expect(latestThread?.lastTurn?.id).toMatch(/^msg-1:wakeup:\d+$/)
    expect(latestThread?.messages.some(m => m.role === 'assistant' && m.text.includes('Tests passed and pushed PR.'))).toBe(true)
  })

  it('transitions an idle thread back to running immediately when an answer is delivered, unless RPC reply fails', async () => {
    const { host } = await setup()
    await host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-ans1',
      projectId: 'proj-1',
      threadId: 'thread-ans-1',
      title: 'Answer Resume',
      modelId: 'gemini-3.1-pro',
    })
    let pendingRequestId: string | undefined
    let currentStatus: string | undefined
    const statusesAfterAnswer: string[] = []
    let answered = false
    host.subscribe(s => {
      const t = s.threads.find(item => item.id === 'thread-ans-1')
      if (!t) return
      currentStatus = t.status
      if (t.requests[0]) pendingRequestId = t.requests[0].id
      if (answered) statusesAfterAnswer.push(t.status)
    })

    await host.execute({
      type: 'send',
      threadId: 'thread-ans-1',
      commandId: 'cmd-q-1',
      messageId: 'msg-q-1',
      text: 'reactive-question',
    })

    await expect.poll(() => pendingRequestId).toBeTruthy()
    expect(currentStatus).toBe('idle')

    answered = true
    const answerResult = await host.execute({
      type: 'answer',
      commandId: 'cmd-ans-1',
      threadId: 'thread-ans-1',
      requestId: pendingRequestId!,
      answer: 'Option A',
      questionAnswers: { q0: { optionIds: ['a'] } },
    })
    expect(answerResult).toEqual({ accepted: true })
    expect(statusesAfterAnswer[0]).toBe('running')

    // Reactive turn settles cleanly afterwards.
    await expect.poll(() => currentStatus).toBe('idle')
  })

  it('keeps outlived backgrounded updates quiet (idle with backgroundWork) and bounds stuck reactive tools with reactiveTurnMaxMs', async () => {
    const { host } = await setup({ reactiveTurnSettleMs: 40, reactiveTurnWaitMs: 120, reactiveTurnMaxMs: 180 })
    await host.execute({ type: 'create-thread', commandId: 'c-outlived', projectId: 'proj-1', threadId: 't-outlived', title: 'Outlived', modelId: 'gemini-3.1-pro' })

    const snapshots: { status: string; lastTurnId: string | undefined; bg: number }[] = []
    host.subscribe(snap => {
      const t = snap.threads.find(item => item.id === 't-outlived')
      if (t) snapshots.push({ status: t.status, lastTurnId: t.lastTurn?.id, bg: t.backgroundWork?.length ?? 0 })
    })

    await host.execute({ type: 'send', threadId: 't-outlived', commandId: 's-1', messageId: 'm-outlived', text: 'post-turn-outlived-progress' })
    await expect.poll(() => (host as unknown as { threads: Map<string, { status: string; backgroundWork?: unknown[] }> }).threads.get('t-outlived')?.status).toBe('idle')

    // Wait past the 30ms post-turn `in_progress` progress update and ensure it never flipped back to running or opened wakeup:1.
    await new Promise(resolve => setTimeout(resolve, 90))
    const current = (await host.snapshot()).threads.find(t => t.id === 't-outlived')!
    expect(current.status).toBe('idle')
    expect(current.lastTurn?.id).toBe('m-outlived')
    expect(current.backgroundWork).toHaveLength(1)
    expect(snapshots.some(s => s.lastTurnId?.startsWith('m-outlived:wakeup:'))).toBe(false)

    // A stuck in_progress reactive tool settles when reactiveTurnMaxMs elapses instead of remaining running forever.
    await host.execute({ type: 'send', threadId: 't-outlived', commandId: 's-2', messageId: 'm-stuck', text: 'lingering-reactive-tool' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-outlived')?.lastTurn).toEqual({ id: 'm-stuck:wakeup:1', status: 'completed' })
    const afterStuck = (await host.snapshot()).threads.find(t => t.id === 't-outlived')!
    expect(afterStuck.status).toBe('idle')
  })

  it('preserves original tool row ownership when a delayed thought opens a reactive turn before completion', async () => {
    const { host } = await setup()
    await host.execute({ type: 'create-thread', commandId: 'c-row', projectId: 'proj-1', threadId: 't-row', title: 'Row', modelId: 'gemini-3.1-pro' })
    await host.execute({ type: 'send', threadId: 't-row', commandId: 's-row', messageId: 'm-row', text: 'delayed-thought-then-old-tool-done' })

    await expect.poll(async () => {
      const t = (await host.snapshot()).threads.find(item => item.id === 't-row')
      return t?.status === 'idle' && t?.lastTurn?.id === 'm-row:wakeup:1'
    }).toBe(true)

    const thread = (await host.snapshot()).threads.find(item => item.id === 't-row')!
    const cmdRows = (thread.activities ?? []).filter(act => act.kind === 'command')
    expect(cmdRows).toHaveLength(1)
    expect(cmdRows[0]!.turnId).toBe('m-row')
    expect(cmdRows[0]!.status).toBe('completed')
  })

  it('re-checks activity revision after lookBeforeEnd and waits through slow post-tool pauses within one reactive turn', async () => {
    const { host: scanHost } = await setup({
      reactiveTurnSettleMs: 80,
      reactiveTurnWaitMs: 320,
      lookBeforeEndMs: 250,
      childRows: async () => {
        await new Promise(resolve => setTimeout(resolve, 120))
        return []
      },
    })
    await scanHost.execute({ type: 'create-thread', commandId: 'c-scan', projectId: 'proj-1', threadId: 't-scan', title: 'ScanRace', modelId: 'gemini-3.1-pro' })
    const wakeupEnds: string[] = []
    scanHost.subscribe(snap => {
      const t = snap.threads.find(item => item.id === 't-scan')
      if (t?.status === 'idle' && t.lastTurn?.id.startsWith('m-scan:wakeup:') && wakeupEnds.at(-1) !== t.lastTurn.id) {
        wakeupEnds.push(t.lastTurn.id)
      }
    })
    await scanHost.execute({ type: 'send', threadId: 't-scan', commandId: 's-scan', messageId: 'm-scan', text: 'streaming-during-look' })
    await expect.poll(async () => {
      const t = (await scanHost.snapshot()).threads.find(item => item.id === 't-scan')
      return t?.messages.some(m => m.role === 'assistant' && m.text.includes('Part 2')) && t?.status === 'idle'
    }, { timeout: 3_000 }).toBe(true)
    expect(wakeupEnds).toEqual(['m-scan:wakeup:1'])

    const { host: pauseHost } = await setup({ reactiveTurnSettleMs: 50, reactiveTurnWaitMs: 350 })
    await pauseHost.execute({ type: 'create-thread', commandId: 'c-pause', projectId: 'proj-1', threadId: 't-pause', title: 'Pause', modelId: 'gemini-3.1-pro' })
    const pauseEnds: string[] = []
    pauseHost.subscribe(snap => {
      const t = snap.threads.find(item => item.id === 't-pause')
      if (t?.status === 'idle' && t.lastTurn?.id.startsWith('m-pause:wakeup:') && pauseEnds.at(-1) !== t.lastTurn.id) {
        pauseEnds.push(t.lastTurn.id)
      }
    })
    await pauseHost.execute({ type: 'send', threadId: 't-pause', commandId: 's-pause', messageId: 'm-pause', text: 'slow-pause-after-tool' })
    await expect.poll(async () => {
      const t = (await pauseHost.snapshot()).threads.find(item => item.id === 't-pause')
      return t?.status === 'idle' && t?.messages.some(m => m.role === 'assistant' && m.text.includes('Delayed answer after tool.'))
    }, { timeout: 3_000 }).toBe(true)
    expect(pauseEnds).toEqual(['m-pause:wakeup:1'])
  })

  it('filters stdio npx MCP servers and Windows conhost, ignores pending permissions, and preserves OS child processes under the 64-item cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-agy-mcp-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const mcpPath = join(dir, 'mcp_config.json')
    await writeFile(mcpPath, JSON.stringify({
      mcpServers: {
        sqlite: { command: 'npx', args: ['-y', '@mcp/sqlite'] },
      },
    }), 'utf8')

    let mode: 'mcp' | 'pending' | 'overflow' = 'mcp'
    const { host } = await setup({
      userMcpConfig: mcpPath,
      childRows: () => mode === 'overflow'
        ? [{ pid: 888, startedAt: Date.now() - 50, argv: ['bash', '-c', 'sleep 30'], marks: [] }]
        : [
            { pid: 501, startedAt: Date.now() - 100, argv: ['node', '/usr/local/bin/npx', '-y', '@mcp/sqlite'], marks: [] },
            { pid: 502, startedAt: Date.now() - 100, argv: ['C:\\Windows\\system32\\conhost.exe', '0x4'], marks: [] },
          ],
    })
    await host.execute({ type: 'create-thread', commandId: 'c-mcp', projectId: 'proj-1', threadId: 't-mcp', title: 'MCP', modelId: 'gemini-3.1-pro' })

    // Running command turn ends cleanly with 0 background work because npx MCP + conhost are filtered out during lookBeforeEnd.
    await host.execute({ type: 'send', threadId: 't-mcp', commandId: 's-mcp-1', messageId: 'm-mcp-1', text: 'command-with-mcp-and-conhost' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.lastTurn).toEqual({ id: 'm-mcp-1', status: 'completed' })
    expect((await host.snapshot()).threads.find(t => t.id === 't-mcp')?.backgroundWork).toBeUndefined()

    // Pending permission prompt + conhost never leaves phantom background work either.
    mode = 'pending'
    await host.execute({ type: 'send', threadId: 't-mcp', commandId: 's-mcp-2', messageId: 'm-mcp-2', text: 'pending-perm-with-conhost' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.lastTurn).toEqual({ id: 'm-mcp-2', status: 'completed' })
    expect((await host.snapshot()).threads.find(t => t.id === 't-mcp')?.backgroundWork).toBeUndefined()

    // Under 64 tracked schedules + 1 live OS child process, live OS child process is not evicted by the cap.
    mode = 'overflow'
    await host.execute({ type: 'send', threadId: 't-mcp', commandId: 's-mcp-3', messageId: 'm-mcp-3', text: 'overflow-schedules-with-os-child' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.lastTurn).toEqual({ id: 'm-mcp-3', status: 'completed' })
    const overflowWork = (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.backgroundWork ?? []
    expect(overflowWork).toHaveLength(64)
    expect(overflowWork.some(item => item.label === 'sleep 30')).toBe(true)
  })

  it('keeps text-backgrounded agy commands in backgroundWork and delivers Watcher turn-finished news when wakeup posts GPU DONE', async () => {
    const { host } = await setup({ reactiveTurnSettleMs: 30, reactiveTurnWaitMs: 60, lookBeforeEndMs: 50 })
    await host.execute({ type: 'create-thread', commandId: 'c-colab', projectId: 'proj-1', threadId: 't-colab', title: 'Colab', modelId: 'gemini-3.1-pro' })

    let latestSnapshot = await host.snapshot()
    const hostId = 'local-host', watcherId = 'watcher-1', requestId = 'req-1'
    const record: WatcherRecord = {
      ...emptyWatcherRecord(),
      current: { target: { hostId, threadId: watcherId }, projectId: 'proj-1', provider: 'antigravity', creationOperationId: 'op-w', createdAt: new Date().toISOString() },
      watches: [{ id: 'watch-1', target: { hostId, threadId: 't-colab' }, createdAt: new Date().toISOString(), generation: 0, lastUserMessageId: 'm-colab' }],
      requests: [{
        id: requestId,
        watcher: { hostId, threadId: watcherId },
        rootUserMessageId: 'root-1',
        state: 'active',
        createdAt: new Date().toISOString(),
        closedAt: null,
        participants: [{ requestId, target: { hostId, threadId: 't-colab' }, startedBy: 'watcher', generation: 0, promptCount: 1, state: 'participating', lastUserMessageId: 'm-colab' }],
      }],
    }
    const delivered: { news: WatcherNews; text: string }[] = []
    const currentSnapshot = (): AgentHostSnapshot => ({
      ...latestSnapshot,
      hostId,
      threads: [
        ...latestSnapshot.threads.map(t => ({ ...t, hostId })),
        { id: watcherId, hostId, providerId: 'antigravity', projectId: 'proj-1', modelId: 'gemini-3.1-pro', title: 'Watcher', kind: 'watcher', status: 'idle', messages: [], requests: [] },
      ],
    })
    const wakes = new WatcherWakeUp({
      snapshot: currentSnapshot,
      record: () => record,
      canDeliver: () => true,
      deliver: async news => {
        const snap = currentSnapshot()
        const text = watcherNewsText(news, event => {
          const t = snap.threads.find(item => item.id === event.target.threadId)
          return t && event.kind === 'turn-finished' ? watcherReplyStart(t, event.turnId, watcherNewestTurnReply(t)) : undefined
        })
        delivered.push({ news, text })
        wakes.settled(news.events, 'told')
      },
      remember: async () => undefined,
      prune: async () => undefined,
      ordinaryBatch: { quietMs: 20, maxMs: 40 },
    })
    wakes.start()
    cleanups.push(async () => { wakes.close(); await wakes.drained() })

    let sawForegroundBg = false
    host.subscribe(snap => {
      latestSnapshot = snap
      wakes.observe()
      const t = snap.threads.find(item => item.id === 't-colab')
      if (t?.status === 'idle' && t.lastTurn?.id === 'm-colab' && (t.backgroundWork?.length ?? 0) > 0) sawForegroundBg = true
    })

    await host.execute({ type: 'send', threadId: 't-colab', commandId: 's-colab', messageId: 'm-colab', text: 'agy-colab-render' })

    await expect.poll(() => sawForegroundBg, { timeout: 3_000 }).toBe(true)
    await expect.poll(() => delivered.find(item => item.news.events.some(event => event.kind === 'turn-finished' && event.turnId === 'm-colab:wakeup:1')), { timeout: 3_000 }).toBeTruthy()

    const wakeupDelivery = delivered.find(item => item.news.events.some(event => event.kind === 'turn-finished' && event.turnId === 'm-colab:wakeup:1'))!
    const wakeupEvent = wakeupDelivery.news.events.find(event => event.kind === 'turn-finished' && event.turnId === 'm-colab:wakeup:1')!
    expect(wakeupEvent.backgroundWorkCount).toBe(0)
    expect(wakeupDelivery.text).toContain('GPU DONE')
    expect((await host.snapshot()).threads.find(item => item.id === 't-colab')?.messages.some(m => m.role === 'user' && m.text.includes('<SYSTEM_MESSAGE>'))).toBe(false)
  })

  it('drops schedule timers that fire inside one long turn and holds the thread on the pending one as waited-on work, never as agents', async () => {
    const { host } = await setup({ reactiveTurnSettleMs: 30, reactiveTurnWaitMs: 60, lookBeforeEndMs: 50 })
    await host.execute({ type: 'create-thread', commandId: 'c-watch', projectId: 'proj-1', threadId: 't-watch', title: 'Release watch', modelId: 'gemini-3.1-pro' })

    let mostWork = 0
    const kinds = new Set<string>()
    host.subscribe(snap => {
      const work = snap.threads.find(item => item.id === 't-watch')?.backgroundWork ?? []
      mostWork = Math.max(mostWork, work.length)
      for (const item of work) kinds.add(item.type)
    })

    await host.execute({ type: 'send', threadId: 't-watch', commandId: 's-watch-1', messageId: 'm-watch-1', text: 'repeated-schedules-in-one-turn' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-watch')?.lastTurn, { timeout: 5_000 }).toEqual({ id: 'm-watch-1', status: 'completed' })
    const thread = (await host.snapshot()).threads.find(t => t.id === 't-watch')!
    // Three timers fired into the turn and went; only the one still pending holds the thread, as a wait.
    expect(thread.backgroundWork?.map(item => [item.type, item.label])).toEqual([['command', 'Run schedule']])
    expect(agentBackgroundWorkSchema.safeParse(thread.backgroundWork).success).toBe(true)
    expect(mostWork).toBe(1)
    expect([...kinds]).toEqual(['command'])
    // The timer wakeups are the runtime's, not the user's.
    expect(thread.messages.some(m => m.role === 'user' && m.text.includes('<SYSTEM_MESSAGE>'))).toBe(false)
  })

  it('settles tracked background work on mid-turn SYSTEM_MESSAGE wakeups without swallowing pasted user messages', async () => {
    const { host } = await setup({ reactiveTurnSettleMs: 30, reactiveTurnWaitMs: 60, lookBeforeEndMs: 50 })
    await host.execute({ type: 'create-thread', commandId: 'c-mid', projectId: 'proj-1', threadId: 't-mid', title: 'Midturn', modelId: 'gemini-3.1-pro' })

    await host.execute({ type: 'send', threadId: 't-mid', commandId: 's-mid-1', messageId: 'm-mid-1', text: 'agy-midturn-start' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mid')?.backgroundWork?.map(item => item.label)).toEqual(['python long_job.py'])

    let sawClearedMidTurn = false
    host.subscribe(snap => {
      const t = snap.threads.find(item => item.id === 't-mid')
      if (t?.status === 'running' && (t.backgroundWork?.length ?? 0) === 0) sawClearedMidTurn = true
    })

    await host.execute({ type: 'send', threadId: 't-mid', commandId: 's-mid-2', messageId: 'm-mid-2', text: 'agy-midturn-settle' })
    await expect.poll(() => sawClearedMidTurn, { timeout: 3_000 }).toBe(true)
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mid')?.lastTurn).toEqual({ id: 'm-mid-2', status: 'completed' })
    const afterSettle = (await host.snapshot()).threads.find(t => t.id === 't-mid')!
    expect(afterSettle.backgroundWork ?? []).toEqual([])

    await host.execute({ type: 'send', threadId: 't-mid', commandId: 's-mid-3', messageId: 'm-mid-3', text: 'agy-pasted-user-system-msg' })
    await expect.poll(async () => {
      const current = (await host.snapshot()).threads.find(t => t.id === 't-mid')
      return current?.status === 'idle' && current.messages.some(m => m.role === 'assistant' && m.text === 'Handled pasted messages.')
    }).toBe(true)
    const userTexts = (await host.snapshot()).threads.find(t => t.id === 't-mid')!.messages.filter(m => m.role === 'user').map(m => m.text)
    expect(userTexts).toContain('<SYSTEM_MESSAGE> user pasted fragment without closing tag')
    expect(userTexts).toContain('[Message] timestamp=2026-11-23T00:00:00Z user pasted log header')
  })

  it('opens a fresh assistant reply after steering a turn held open by a background command and ignores the steered echo (#2840)', async () => {
    const { host } = await setup()
    await host.execute({ type: 'create-thread', commandId: 'c-held', projectId: 'proj-1', threadId: 't-held', title: 'Held BG', modelId: 'gemini-3.1-pro' })

    await host.execute({ type: 'send', threadId: 't-held', commandId: 's-held-1', messageId: 'm-held-1', text: 'agy-held-bg-start' })
    await expect.poll(async () => {
      const t = (await host.snapshot()).threads.find(item => item.id === 't-held')
      return t?.status === 'running'
        && t.backgroundWork?.some(item => item.label === 'python render.py')
        && t.messages.some(m => m.role === 'assistant' && m.text === 'Started the render in the background.')
    }, { timeout: 3_000 }).toBe(true)

    const steered = await host.execute({ type: 'steer', threadId: 't-held', commandId: 's-held-2', messageId: 'm-held-2', text: 'How is the render going?' })
    expect(steered).toEqual({ accepted: true })

    await expect.poll(async () => {
      const t = (await host.snapshot()).threads.find(item => item.id === 't-held')
      return t?.messages.map(m => [m.role, m.text])
    }, { timeout: 3_000 }).toEqual([
      ['user', 'agy-held-bg-start'],
      ['assistant', 'Started the render in the background.'],
      ['user', 'How is the render going?'],
      ['assistant', 'The render is at 62%.'],
    ])
    const mid = (await host.snapshot()).threads.find(item => item.id === 't-held')!
    expect(mid.status).toBe('running')
    expect(mid.backgroundWork?.map(item => item.label)).toEqual(['python render.py'])

    await host.execute({ type: 'steer', threadId: 't-held', commandId: 's-held-3', messageId: 'm-held-3', text: 'agy-held-bg-finish' })
    await expect.poll(async () => {
      const t = (await host.snapshot()).threads.find(item => item.id === 't-held')
      return t?.status === 'idle' && (t.backgroundWork?.length ?? 0) === 0
    }, { timeout: 3_000 }).toBe(true)
    const done = (await host.snapshot()).threads.find(item => item.id === 't-held')!
    expect(done.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Render complete.' })
  })

  it('opens a separate assistant reply after a held-turn SYSTEM_MESSAGE wakeup without any steer (L1)', async () => {
    const { host } = await setup()
    await host.execute({ type: 'create-thread', commandId: 'c-nosteer', projectId: 'proj-1', threadId: 't-nosteer', title: 'No Steer Wakeup', modelId: 'gemini-3.1-pro' })

    await host.execute({ type: 'send', threadId: 't-nosteer', commandId: 's-nosteer-1', messageId: 'm-nosteer-1', text: 'agy-held-bg-wakeup-no-steer' })
    await expect.poll(async () => (await host.snapshot()).threads.find(item => item.id === 't-nosteer')?.status, { timeout: 3_000 }).toBe('idle')

    const done = (await host.snapshot()).threads.find(item => item.id === 't-nosteer')!
    expect(done.messages.map(m => [m.role, m.text])).toEqual([
      ['user', 'agy-held-bg-wakeup-no-steer'],
      ['assistant', 'Started the render in the background.'],
      ['assistant', 'Render complete.'],
    ])
    expect(done.backgroundWork ?? []).toEqual([])
  })

  it('keeps in-flight pre-steer chunks on the old reply until agy starts on the steer, and consumes steer echoes once (L4, N2)', async () => {
    const { host } = await setup()
    await host.execute({ type: 'create-thread', commandId: 'c-midstream', projectId: 'proj-1', threadId: 't-midstream', title: 'Midstream Steer', modelId: 'gemini-3.1-pro' })

    await host.execute({ type: 'send', threadId: 't-midstream', commandId: 's-midstream-1', messageId: 'm-midstream-1', text: 'agy-midstream-count' })
    await expect.poll(async () => {
      const t = (await host.snapshot()).threads.find(item => item.id === 't-midstream')
      return t?.status === 'running' && t.messages.some(m => m.role === 'assistant' && m.text === 'Counting 1,')
    }, { timeout: 3_000 }).toBe(true)

    const steered = await host.execute({ type: 'steer', threadId: 't-midstream', commandId: 's-midstream-2', messageId: 'm-midstream-2', text: 'Make it shorter' })
    expect(steered).toEqual({ accepted: true })

    await expect.poll(async () => {
      const t = (await host.snapshot()).threads.find(item => item.id === 't-midstream')
      return t?.messages.length === 5
    }, { timeout: 3_000 }).toBe(true)

    const done = (await host.snapshot()).threads.find(item => item.id === 't-midstream')!
    expect(done.messages.map(m => [m.role, m.text])).toEqual([
      ['user', 'agy-midstream-count'],
      ['assistant', 'Counting 1, 2, 3.'],
      ['user', 'Make it shorter'],
      ['assistant', 'Short.'],
      ['user', 'Make it shorter'],
    ])
  })
})
