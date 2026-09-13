import { z } from 'zod'
import { PERSONAL_CHAT_GET, PERSONAL_CHAT_COMMAND, PERSONAL_CHAT_SKILLS, personalChatCommandSchema, personalSkillsInputSchema } from '../../shared/personalChats'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { PersonalChatService } from './personalChats'
export function registerPersonalChatIpc(ipc: IpcMainAdapter, service: Pick<PersonalChatService, 'get' | 'command' | 'skills'>, senders: () => readonly TrustedIpcSender[]): () => void {
  const authorize = (event: Parameters<typeof isAuthorizedIpcSender>[0]): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('PERSONAL_CHAT_MAIN_WINDOW_REQUIRED')
  }
  ipc.handle(PERSONAL_CHAT_GET, (event, ...args) => { authorize(event); z.tuple([]).or(z.tuple([z.undefined()])).parse(args); return service.get() })
  ipc.handle(PERSONAL_CHAT_COMMAND, (event, ...args) => { authorize(event); const [command] = z.tuple([personalChatCommandSchema]).parse(args); return service.command(command) })
  ipc.handle(PERSONAL_CHAT_SKILLS, (event, ...args) => { authorize(event); const [request] = z.tuple([personalSkillsInputSchema]).parse(args); return service.skills(request.chatId, request.forceReload) })
  return () => { for (const channel of [PERSONAL_CHAT_GET, PERSONAL_CHAT_COMMAND, PERSONAL_CHAT_SKILLS]) ipc.removeHandler(channel) }
}
