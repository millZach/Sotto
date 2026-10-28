import { z } from 'zod'
import { toolListRequestSchema, toolsResultSchema } from '../shared/tools'
import {
  CLOUD_IPHONE_CHANNEL, CLOUD_IPHONE_EVENT, cloudAnswerSchema, cloudEventSchema, cloudIphoneStatusSchema,
  cloudKeyResultSchema, cloudKeySchema, cloudMountSchema, cloudSessionRequestSchema, cloudSessionSchema,
  type CloudIphoneBridge,
} from '../shared/cloudIphone'
import type { IpcRendererAdapter } from './index'

/** Each channel's answer, built once: building a schema costs far more than parsing with one. */
const voidSchema = z.undefined()
const voidResult = toolsResultSchema(voidSchema)
const statusResult = toolsResultSchema(cloudIphoneStatusSchema)
const keyResult = toolsResultSchema(cloudKeyResultSchema)
const sessionsResult = toolsResultSchema(z.array(cloudSessionSchema))
const sessionResult = toolsResultSchema(cloudSessionSchema)

/** `window.sotto.cloudIphone`: the renderer's one view of cloud sessions (ADR-0047); the key and viewer URL never cross this bridge. */
export function createCloudIphoneBridge(renderer: IpcRendererAdapter): CloudIphoneBridge {
  const call = async <Result extends z.ZodType>(channel: string, input: z.ZodType, result: Result, payload: unknown): Promise<z.output<Result>> => result.parse(await renderer.invoke(channel, input.parse(payload)))
  return Object.freeze<CloudIphoneBridge>({
    status: () => call(CLOUD_IPHONE_CHANNEL + 'status', voidSchema, statusResult, undefined),
    setKey: request => call(CLOUD_IPHONE_CHANNEL + 'setKey', cloudKeySchema, keyResult, request),
    sessions: request => call(CLOUD_IPHONE_CHANNEL + 'sessions', toolListRequestSchema, sessionsResult, request),
    answer: request => call(CLOUD_IPHONE_CHANNEL + 'answer', cloudAnswerSchema, sessionResult, request),
    end: request => call(CLOUD_IPHONE_CHANNEL + 'end', cloudSessionRequestSchema, sessionResult, request),
    mount: request => call(CLOUD_IPHONE_CHANNEL + 'mount', cloudMountSchema, voidResult, request),
    onEvent: listener => {
      const wrapped = (_event: unknown, ...args: unknown[]): void => {
        if (args.length !== 1) return
        const result = cloudEventSchema.safeParse(args[0])
        if (result.success) listener(result.data)
      }
      renderer.on(CLOUD_IPHONE_EVENT, wrapped)
      return () => { renderer.removeListener(CLOUD_IPHONE_EVENT, wrapped) }
    },
  })
}
