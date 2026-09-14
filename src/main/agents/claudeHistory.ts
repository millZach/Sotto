import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { z } from 'zod'

const messagesSchema = z.array(z.object({ type: z.enum(['user', 'assistant', 'system']), uuid: z.string().uuid(), session_id: z.string().uuid(), message: z.unknown(), parent_tool_use_id: z.string().nullable() }))
export type ClaudeHistoryMessage = z.infer<typeof messagesSchema>[number]
const helper = `const sdk = await import(process.argv[1]); const [operation,sessionId,dir,boundary] = process.argv.slice(2);
const result = operation === 'read' ? await sdk.getSessionMessages(sessionId,{dir}) : await sdk.forkSession(sessionId,{dir,upToMessageId:boundary});
process.stdout.write(JSON.stringify(result));`

/** Official native history helpers run in their own config-home environment.
 * No query/model call, credential mutation or hand-edited native transcript. */
export class ClaudeHistory {
  constructor(private readonly environment: NodeJS.ProcessEnv, private readonly home: string, private readonly cwd: string) {}
  private async run(operation: 'read' | 'fork', sessionId: string, boundary?: string): Promise<unknown> {
    // The official SDK's self-contained history module is shipped separately;
    // importing it outside ASAR avoids Node ESM archive resolution differences.
    const packaged = process.versions.electron && (await import('electron')).app.isPackaged
    const sdk = pathToFileURL(packaged ? join(process.resourcesPath, 'claude-sdk', 'sdk.mjs') : require.resolve('@anthropic-ai/claude-agent-sdk')).href
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', helper, sdk, operation, sessionId, this.cwd, ...(boundary ? [boundary] : [])], {
      cwd: this.cwd, env: { ...this.environment, CLAUDE_CONFIG_DIR: this.home, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 32 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  }
  async read(sessionId: string): Promise<ClaudeHistoryMessage[]> { return messagesSchema.parse(await this.run('read', sessionId)) }
  async fork(sessionId: string, boundary: string): Promise<string> { return z.object({ sessionId: z.string().uuid() }).parse(await this.run('fork', sessionId, boundary)).sessionId }
}
