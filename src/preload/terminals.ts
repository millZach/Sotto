import { z } from 'zod'
import {
  TERMINALS_CHANNEL, TERMINALS_EVENT, terminalOpenSchema, workspaceTerminalEventSchema, workspaceTerminalImageResultSchema, workspaceTerminalImageSchema, workspaceTerminalListingSchema,
  workspaceTerminalRequestSchema, workspaceTerminalResizeSchema, workspaceTerminalSnapshotSchema, workspaceTerminalWriteSchema, type TerminalWorkspaceBridge,
} from '../shared/terminalWorkspace'
import { toolsResultSchema } from '../shared/tools'
import type { IpcRendererAdapter } from './index'

export function createTerminalWorkspaceBridge(renderer: IpcRendererAdapter): TerminalWorkspaceBridge {
  const call = async <T>(method: string, input: z.ZodType, output: z.ZodType<T>, payload: unknown) => toolsResultSchema(output).parse(await renderer.invoke(TERMINALS_CHANNEL + method, input.parse(payload)))
  return Object.freeze<TerminalWorkspaceBridge>({
    list: () => call('list', z.undefined(), workspaceTerminalListingSchema, undefined),
    open: request => call('open', terminalOpenSchema, workspaceTerminalSnapshotSchema, request),
    read: request => call('read', workspaceTerminalRequestSchema, workspaceTerminalSnapshotSchema, request),
    write: request => call('write', workspaceTerminalWriteSchema, z.undefined(), request),
    resize: request => call('resize', workspaceTerminalResizeSchema, z.undefined(), request),
    interrupt: request => call('interrupt', workspaceTerminalRequestSchema, z.undefined(), request),
    stop: request => call('stop', workspaceTerminalRequestSchema, z.undefined(), request),
    restart: request => call('restart', workspaceTerminalRequestSchema, workspaceTerminalSnapshotSchema, request),
    close: request => call('close', workspaceTerminalRequestSchema, z.undefined(), request),
    pasteImage: request => call('pasteImage', workspaceTerminalImageSchema, workspaceTerminalImageResultSchema, request),
    onEvent: listener => {
      const wrapped = (_event: unknown, ...args: unknown[]): void => {
        if (args.length !== 1) return
        const result = workspaceTerminalEventSchema.safeParse(args[0])
        if (result.success) listener(result.data)
      }
      renderer.on(TERMINALS_EVENT, wrapped)
      return () => { renderer.removeListener(TERMINALS_EVENT, wrapped) }
    },
  })
}
