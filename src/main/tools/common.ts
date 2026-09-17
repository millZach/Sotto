import { z } from 'zod'
import type { FileWorkspace } from '../../shared/files'
import type { ToolsError, ToolsResult } from '../../shared/tools'
import type { FilesService } from '../files/service'

class ToolFailure extends Error {
  constructor(readonly code: ToolsError['code'], message: string) { super(message) }
}
export const fail = (code: ToolsError['code'], message: string): never => { throw new ToolFailure(code, message) }
export function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  return parsed.success ? parsed.data : fail('invalid-request', 'This tool request is invalid. Refresh the tools panel.')
}
export async function workspace(files: FilesService, threadId: string, expected?: string): Promise<FileWorkspace> {
  const result = await files.resolveWorkspace(threadId, expected)
  if (result.ok) return result.value
  const code = result.error.code
  return fail(code === 'workspace-changed' || code === 'thread-unavailable' || code === 'busy' ? code : 'workspace-unavailable', result.error.message)
}
export class ToolOperations {
  private active = 0
  protected disposed = false
  protected async run<T>(operation: () => Promise<T>): Promise<ToolsResult<T>> {
    if (this.disposed) return { ok: false, error: { code: 'unavailable', message: 'This tool has shut down.' } }
    if (this.active >= 8) return { ok: false, error: { code: 'busy', message: 'This tool is busy. Try again shortly.' } }
    this.active++
    try { return { ok: true, value: await operation() } }
    catch (error) { return { ok: false, error: error instanceof ToolFailure ? { code: error.code, message: error.message } : { code: 'unavailable', message: 'This tool is unavailable. Refresh and try again.' } } }
    finally { this.active-- }
  }
}
