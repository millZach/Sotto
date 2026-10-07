import { z } from 'zod'
import { toolListRequestSchema, toolsResultSchema } from '../shared/tools'
import {
  CLOUD_IPHONE_CHANNEL, CLOUD_IPHONE_EVENT, cloudAnswerSchema, cloudEventSchema, cloudIphoneStatusSchema,
  cloudKeyResultSchema, cloudKeySchema, cloudMountSchema, cloudSessionRequestSchema, cloudSessionSchema,
  type CloudIphoneBridge,
} from '../shared/cloudIphone'
import type { IpcRendererAdapter } from './index'

/** `window.sotto.cloudIphone`: the renderer's one view of cloud sessions (ADR-0047); the key and viewer URL never cross this bridge. */
export function createCloudIphoneBridge(renderer: IpcRendererAdapter): CloudIphoneBridge {
  const call = async <T>(channel: string, input: z.ZodType, output: z.ZodType<T>, payload: unknown) => toolsResultSchema(output).parse(await renderer.invoke(channel, input.parse(payload)))
  return Object.freeze<CloudIphoneBridge>({
    status: () => call(CLOUD_IPHONE_CHANNEL + 'status', z.undefined(), cloudIphoneStatusSchema, undefined),
    setKey: request => call(CLOUD_IPHONE_CHANNEL + 'setKey', cloudKeySchema, cloudKeyResultSchema, request),
    sessions: request => call(CLOUD_IPHONE_CHANNEL + 'sessions', toolListRequestSchema, z.array(cloudSessionSchema), request),
    answer: request => call(CLOUD_IPHONE_CHANNEL + 'answer', cloudAnswerSchema, cloudSessionSchema, request),
    end: request => call(CLOUD_IPHONE_CHANNEL + 'end', cloudSessionRequestSchema, cloudSessionSchema, request),
    mount: request => call(CLOUD_IPHONE_CHANNEL + 'mount', cloudMountSchema, z.undefined(), request),
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
