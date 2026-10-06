// A standalone fake of run.cloud's HTTP API (docs/research/2026-10-03-run-cloud-api.md), for the adapter's own
// unit test and, later, an end-to-end spec through SOTTO_RUN_CLOUD_API_URL. It keeps everything in memory: assets,
// iOS simulator sessions and their last interaction, and serves a `/viewer/<id>` page a browser view can load.
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { URL } from 'node:url'

// A one-pixel, valid PNG, for the screenshot route.
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

/**
 * @param {number} port
 * @param {{ key?: string }} [options] the bearer key the fake accepts; any other key is rejected with 401.
 */
export function start(port, options = {}) {
  const acceptedKey = options.key ?? 'rc_live_test'
  const assets = new Map()
  const sessions = new Map()
  const uploads = new Map()
  // Set once listening starts; request handlers only ever run after that.
  let boundPort = port
  /** Test-set behaviour: the next matching call answers oddly, then the fake reverts to normal. */
  const control = { capacityOnce: false, noPresignOnce: false, interactionFailOnce: false, uploadRejectOnce: false, idOnlyOnce: false, finalizeFailOnce: false, echoErrorOnce: false }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })
  }
  function send(response, status, body, headers = {}) {
    if (body === undefined) { response.writeHead(status, headers); response.end(); return }
    const payload = Buffer.isBuffer(body) ? body : JSON.stringify(body)
    response.writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers })
    response.end(payload)
  }
  function authorized(request) {
    return request.headers.authorization === `Bearer ${acceptedKey}`
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${boundPort}`)
    const path = url.pathname
    try {
      // A test's own back door: set or clear the fake's next-call behaviour.
      if (path === '/__control' && request.method === 'POST') {
        Object.assign(control, JSON.parse((await readBody(request)).toString('utf8') || '{}'))
        return send(response, 200, { ok: true })
      }
      if (path === '/run-cloud/account') {
        if (control.echoErrorOnce) {
          control.echoErrorOnce = false
          const auth = request.headers.authorization ?? ''
          return send(response, 400, { error: { message: `Call failed for https://internal.example/debug using ${auth} ${'reason '.repeat(60)}` } })
        }
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        return send(response, 200, { org: { id: 'org_fake' } })
      }
      if (path === '/run-cloud/assets/uploads' && request.method === 'POST') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        if (control.noPresignOnce) { control.noPresignOnce = false; return send(response, 404, { error: { message: 'not found' } }) }
        const body = JSON.parse((await readBody(request)).toString('utf8'))
        const assetId = randomUUID()
        const uploadId = randomUUID()
        uploads.set(uploadId, { assetId, filename: body.filename })
        const base = `http://127.0.0.1:${boundPort}`
        return send(response, 200, { upload: { url: `${base}/__upload/${uploadId}`, headers: { 'x-fake-upload': '1' }, finalizeUrl: `${base}/run-cloud/assets/uploads/${uploadId}/finalize` } })
      }
      if (path.startsWith('/__upload/') && request.method === 'PUT') {
        if (request.headers.authorization) return send(response, 400, { error: { message: 'The presigned PUT must not carry an Authorization header.' } })
        const uploadId = path.slice('/__upload/'.length)
        const pending = uploads.get(uploadId)
        if (!pending) return send(response, 404, { error: { message: 'Unknown upload.' } })
        const bytes = await readBody(request)
        pending.bytes = bytes
        return send(response, 200, undefined)
      }
      const finalizeMatch = /^\/run-cloud\/assets\/uploads\/([^/]+)\/finalize$/u.exec(path)
      if (finalizeMatch && request.method === 'POST') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        if (control.finalizeFailOnce) { control.finalizeFailOnce = false; return send(response, 500, { error: { message: 'run.cloud could not finalize that upload.' } }) }
        const pending = uploads.get(finalizeMatch[1])
        if (!pending || !pending.bytes) return send(response, 400, { error: { message: 'That upload was never completed.' } })
        assets.set(pending.assetId, { id: pending.assetId, name: pending.filename, byteSize: pending.bytes.length })
        return send(response, 200, { asset: { id: pending.assetId } })
      }
      if (path === '/run-cloud/assets' && request.method === 'POST') {
        // The buffered multipart fallback; the fake does not parse the body, only confirms it uploaded.
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        if (control.uploadRejectOnce) { control.uploadRejectOnce = false; return send(response, 500, { error: { message: 'run.cloud could not accept that upload.' } }) }
        await readBody(request)
        const assetId = randomUUID()
        assets.set(assetId, { id: assetId, name: 'multipart' })
        return send(response, 200, { asset: { id: assetId } })
      }
      const assetMatch = /^\/run-cloud\/assets\/([^/]+)$/u.exec(path)
      if (assetMatch && request.method === 'DELETE') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        assets.delete(assetMatch[1])
        return send(response, 200, { deleted: true })
      }
      if (path === '/run-cloud/ios' && request.method === 'POST') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        if (control.capacityOnce) { control.capacityOnce = false; return send(response, 503, { error: { code: 'simulator_capacity_unavailable', message: 'No simulator is free right now.' } }) }
        const body = JSON.parse((await readBody(request)).toString('utf8'))
        const id = randomUUID()
        sessions.set(id, { id, status: 'active', device: 'iPhone 16', osVersion: '18.2', installAssets: body.installAssets ?? [], lastInteraction: null, screen: { width: 393, height: 852, unit: 'points' } })
        if (control.idOnlyOnce) { control.idOnlyOnce = false; return send(response, 200, { id, status: 'active' }) }
        return send(response, 200, { id, status: 'active', url: `http://127.0.0.1:${boundPort}/viewer/${id}`, device: 'iPhone 16', model: body.model ?? 'iphone', osVersion: '18.2' })
      }
      const sessionMatch = /^\/run-cloud\/ios\/([^/]+)$/u.exec(path)
      if (sessionMatch && request.method === 'GET') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        const found = sessions.get(sessionMatch[1])
        if (!found) return send(response, 404, { error: { code: 'active_session_not_found', message: 'That simulator session is gone.' } })
        return send(response, 200, { id: found.id, status: found.status })
      }
      if (sessionMatch && request.method === 'DELETE') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        const found = sessions.get(sessionMatch[1])
        if (found) found.status = 'released'
        return send(response, 200, { released: true })
      }
      const interactionsMatch = /^\/run-cloud\/ios\/([^/]+)\/interactions$/u.exec(path)
      if (interactionsMatch && request.method === 'POST') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        const found = sessions.get(interactionsMatch[1])
        if (!found) return send(response, 404, { error: { code: 'active_session_not_found', message: 'That simulator session is gone.' } })
        const body = JSON.parse((await readBody(request)).toString('utf8'))
        if (control.interactionFailOnce) { control.interactionFailOnce = false; return send(response, 200, { ok: false, status: 'failed', error: { code: 'invalid_interaction', message: 'That interaction could not run.', retryable: true } }) }
        found.lastInteraction = body
        return send(response, 200, { ok: true, status: 'completed' })
      }
      const openUrlMatch = /^\/run-cloud\/ios\/([^/]+)\/open-url$/u.exec(path)
      if (openUrlMatch && request.method === 'POST') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        const found = sessions.get(openUrlMatch[1])
        if (!found) return send(response, 404, { error: { code: 'active_session_not_found', message: 'That simulator session is gone.' } })
        const body = JSON.parse((await readBody(request)).toString('utf8'))
        found.lastInteraction = { action: 'openUrl', url: body.url }
        return send(response, 200, { ok: true })
      }
      const screenshotMatch = /^\/run-cloud\/ios\/([^/]+)\/screenshot$/u.exec(path)
      if (screenshotMatch && request.method === 'GET') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        if (!sessions.has(screenshotMatch[1])) return send(response, 404, { error: { code: 'active_session_not_found', message: 'That simulator session is gone.' } })
        return send(response, 200, PIXEL_PNG)
      }
      const accessibilityMatch = /^\/run-cloud\/ios\/([^/]+)\/accessibility$/u.exec(path)
      if (accessibilityMatch && request.method === 'GET') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        const found = sessions.get(accessibilityMatch[1])
        if (!found) return send(response, 404, { error: { code: 'active_session_not_found', message: 'That simulator session is gone.' } })
        const roots = [{ id: 'root', role: 'Application', label: 'Fake App', value: null, identifier: 'root', bounds: { x: 0, y: 0, width: found.screen.width, height: found.screen.height }, states: { enabled: true, focused: false }, children: [
          { id: 'button', role: 'Button', label: 'Continue', value: null, identifier: 'continue-button', bounds: { x: 20, y: 40, width: 100, height: 44 }, states: { enabled: true, focused: false }, children: [] },
        ] }]
        return send(response, 200, { schemaVersion: 1, screen: found.screen, nodeCount: 2, truncated: false, roots })
      }
      const activityMatch = /^\/run-cloud\/ios\/([^/]+)\/activity$/u.exec(path)
      if (activityMatch && request.method === 'POST') {
        if (!authorized(request)) return send(response, 401, { error: { message: 'That key is not one run.cloud accepts.' } })
        await readBody(request)
        return send(response, 200, { ok: true })
      }
      const viewerMatch = /^\/viewer\/([^/]+)$/u.exec(path)
      if (viewerMatch && request.method === 'GET') {
        const found = sessions.get(viewerMatch[1])
        const detail = found ? JSON.stringify(found.lastInteraction) : 'none'
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(`<!doctype html><html><body style="margin:0;width:100vw;height:100vh;overflow:hidden;background:#2a6;display:flex;align-items:center;justify-content:center;color:#fff;font-family:sans-serif"><div id="last-interaction" style="padding:16px;font-size:14px;word-break:break-all">${detail.replace(/</gu, '&lt;')}</div></body></html>`)
        return
      }
      send(response, 404, { error: { message: `No fake route for ${request.method} ${path}.` } })
    } catch (error) {
      send(response, 500, { error: { message: error instanceof Error ? error.message : 'fake run.cloud failed' } })
    }
  })
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      boundPort = actual
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        key: acceptedKey,
        control: patch => Object.assign(control, patch),
        assets, sessions,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}
