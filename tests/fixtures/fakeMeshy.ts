import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local fake of Meshy's API and its file server (docs/research/2026-10-22-meshy-api.md), on one loopback address,
 * for every test of the Meshy adapter. Nothing here reaches Meshy. Tasks are made up and finish after a set number of
 * reads; their files are made-up bytes served from `/files/`.
 */
export const FAKE_MESHY_KEY = 'msy_made_up_key_0123456789'

type Kind = 'preview' | 'refine' | 'photo'
export interface FakeMeshyTask { readonly id: string; readonly kind: Kind; readonly formats: readonly string[]; reads: number; readonly body: Record<string, unknown> }
export interface FakeMeshyRequest { readonly method: string; readonly path: string; readonly authorization: string | undefined; readonly body: unknown }

/** What the fake does, which a test may change at any point. */
export interface FakeMeshyBehaviour {
  /** Reads before a task ends; the first answers PENDING and the rest IN_PROGRESS. */
  readsToFinish: number
  /** Tasks of these kinds end FAILED. */
  failing: Set<Kind>
  /** Sent as `Retry-After` on every read of a task. */
  retryAfter?: string
  /** The next calls to these routes answer this status instead, once each, with `Retry-After` when given. */
  answers: { readonly route: 'create' | 'read' | 'file'; readonly status: number; readonly retryAfter?: string }[]
  /** The size of every file, and whether it is sent without a length so only the bytes count. */
  fileBytes: number
  chunked: boolean
  /** Formats a finished task leaves out, as Meshy does for one it did not make. */
  missing: Set<string>
  /** Tasks of these kinds stay in progress, however often they are read, until the test lets them go. */
  holding: Set<Kind>
  /** What a file is answered with, by its name ("model.glb", "preview.png"), in place of made-up bytes. */
  files: Map<string, Uint8Array>
  /** Meshy's percent at a read of a task that has not ended, by the read's number; 40 when not given. */
  progress?: (reads: number) => number
  /** Called before a task's file is answered, so a test can stop Sotto part way. */
  onFile?: (path: string) => void
}

export interface FakeMeshy {
  readonly base: string
  readonly requests: FakeMeshyRequest[]
  readonly tasks: Map<string, FakeMeshyTask>
  readonly behaviour: FakeMeshyBehaviour
  /** The creates asked for, by kind. */
  created(kind?: Kind): FakeMeshyTask[]
  close(): Promise<void>
}

export async function startFakeMeshy(): Promise<FakeMeshy> {
  const requests: FakeMeshyRequest[] = []
  const tasks = new Map<string, FakeMeshyTask>()
  const behaviour: FakeMeshyBehaviour = { readsToFinish: 2, failing: new Set(), holding: new Set(), files: new Map(), answers: [], fileBytes: 64, chunked: false, missing: new Set() }
  let base = ''

  const answer = (route: 'create' | 'read' | 'file', response: ServerResponse): boolean => {
    const index = behaviour.answers.findIndex(entry => entry.route === route)
    if (index < 0) return false
    const [entry] = behaviour.answers.splice(index, 1)
    response.writeHead(entry!.status, { 'Content-Type': 'application/json', ...(entry!.retryAfter ? { 'Retry-After': entry!.retryAfter } : {}) })
    response.end(JSON.stringify({ message: `made-up refusal ${FAKE_MESHY_KEY} at ${base}/somewhere` }))
    return true
  }
  const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    response.end(JSON.stringify(body))
  }

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', base)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown
    try { body = text ? JSON.parse(text) : undefined } catch { body = text }
    requests.push({ method: request.method ?? '', path: url.pathname, authorization: request.headers.authorization, body })

    const file = /^\/files\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
    if (file && request.method === 'GET') {
      behaviour.onFile?.(url.pathname)
      if (answer('file', response)) return
      const given = behaviour.files.get(file[2]!)
      const bytes = given ? Buffer.from(given) : Buffer.alloc(behaviour.fileBytes, file[2]!.charCodeAt(0))
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', ...(behaviour.chunked ? {} : { 'Content-Length': String(bytes.byteLength) }) })
      response.end(bytes)
      return
    }
    if (request.headers.authorization !== `Bearer ${FAKE_MESHY_KEY}`) return json(response, 401, { message: 'Invalid API key' })
    // The free read a key is checked with before it is kept.
    if (request.method === 'GET' && url.pathname === '/openapi/v1/balance') return json(response, 200, { balance: 1000, monthly_credits: 1000, permanent_credits: 0, monthly_resets_at: null })
    const route = /^\/openapi\/(v2\/text-to-3d|v1\/image-to-3d)(?:\/([^/]+))?$/u.exec(url.pathname)
    if (!route) return json(response, 404, { message: 'Not found' })
    const words = route[1] === 'v2/text-to-3d'
    if (request.method === 'POST' && route[2] === undefined) {
      if (answer('create', response)) return
      const fields = (body ?? {}) as Record<string, unknown>
      let kind: Kind
      if (!words) kind = 'photo'
      else if (fields.mode === 'preview') kind = 'preview'
      else if (fields.mode === 'refine') {
        const preview = tasks.get(String(fields.preview_task_id))
        if (!preview || preview.kind !== 'preview' || preview.reads < behaviour.readsToFinish || behaviour.failing.has('preview')) return json(response, 400, { message: 'Preview task is not finished' })
        kind = 'refine'
      } else return json(response, 400, { message: 'Unknown mode' })
      const id = randomUUID()
      tasks.set(id, { id, kind, formats: Array.isArray(fields.target_formats) ? fields.target_formats.map(String) : ['glb', 'fbx', 'obj', 'usdz', 'stl'], reads: 0, body: fields })
      return json(response, 202, { result: id })
    }
    if (request.method === 'GET' && route[2] !== undefined) {
      if (answer('read', response)) return
      const task = tasks.get(route[2])
      if (!task || (task.kind === 'photo') === words) return json(response, 404, { message: 'Task not found' })
      task.reads++
      const ended = task.reads >= behaviour.readsToFinish && !behaviour.holding.has(task.kind)
      const status = !ended ? (task.reads === 1 ? 'PENDING' : 'IN_PROGRESS') : behaviour.failing.has(task.kind) ? 'FAILED' : 'SUCCEEDED'
      const files: Record<string, string> = {}
      if (status === 'SUCCEEDED') {
        for (const format of task.formats) if (!behaviour.missing.has(format)) files[format] = `${base}/files/${task.id}/model.${format}?Expires=1&Signature=made-up`
        if (task.formats.includes('obj') && !behaviour.missing.has('mtl')) files.mtl = `${base}/files/${task.id}/model.mtl?Expires=1&Signature=made-up`
      }
      return json(response, 200, {
        id: task.id, type: task.kind === 'photo' ? 'image-to-3d' : `text-to-3d-${task.kind}`, status, progress: ended ? 100 : behaviour.progress?.(task.reads) ?? 40,
        model_urls: files, thumbnail_url: status === 'SUCCEEDED' ? `${base}/files/${task.id}/preview.png?Expires=1` : '', texture_urls: [],
        task_error: status === 'FAILED' ? { type: 'made-up', message: `made-up failure ${FAKE_MESHY_KEY}` } : null,
        consumed_credits: task.kind === 'preview' ? 20 : task.kind === 'refine' ? 10 : 30,
      }, behaviour.retryAfter ? { 'Retry-After': behaviour.retryAfter } : {})
    }
    return json(response, 404, { message: 'Not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base, requests, tasks, behaviour,
    created: kind => [...tasks.values()].filter(task => kind === undefined || task.kind === kind),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
