import { z } from 'zod'
import { CHAT_PROMPT_GENERATE, CHAT_PROMPT_COPY, chatPromptInputSchema, chatPromptCopySchema } from '../../shared/chatPrompts'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { ChatPromptService } from './chatPrompts'

export function registerChatPromptIpc(ipc: IpcMainAdapter, service: Pick<ChatPromptService, 'generate'>, senders: () => readonly TrustedIpcSender[], copy: (text: string) => void): () => void {
  ipc.handle(CHAT_PROMPT_GENERATE, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('CHAT_PROMPT_MAIN_WINDOW_REQUIRED')
    const [input] = z.tuple([chatPromptInputSchema]).parse(args)
    return service.generate(input)
  })
  ipc.handle(CHAT_PROMPT_COPY, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('CHAT_PROMPT_MAIN_WINDOW_REQUIRED')
    const [text] = z.tuple([chatPromptCopySchema]).parse(args)
    copy(text)
  })
  return () => { ipc.removeHandler(CHAT_PROMPT_GENERATE); ipc.removeHandler(CHAT_PROMPT_COPY) }
}
