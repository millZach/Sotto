// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { checkOwnServer, serverRoot } from '../../../../src/main/ownModelServers/check'
import { OWN_SERVER_WORDS, type CheckResult } from '../../../../src/shared/ownModelServers'

interface Seen { method: string; path: string; auth: string | undefined; body: unknown }
type Route = (body: unknown) => { status?: number; json?: unknown; text?: string; hang?: boolean; headers?: Record<string, string> }

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))) })

/** A model server of the test's own: each route answers by method and path, and every request is written down. */
async function fake(routes: Record<string, Route>): Promise<{ address: string; host: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) as unknown : undefined
      seen.push({ method: request.method!, path: request.url!, auth: request.headers.authorization, body })
      const route = routes[`${request.method} ${request.url}`]
      if (!route) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Not Found'); return }
      const answer = route(body)
      if (answer.hang) return
      response.writeHead(answer.status ?? 200, { 'content-type': answer.text !== undefined ? 'text/plain' : 'application/json', ...answer.headers })
      response.end(answer.text ?? JSON.stringify(answer.json))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { address: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, seen }
}
const ok = (result: CheckResult): Extract<CheckResult, { status: 'ok' }> => { if (result.status !== 'ok') throw new Error(result.message); return result }
const list = (...items: unknown[]): Route => () => ({ json: { object: 'list', data: items } })

describe('what a check answers', () => {
  it('finds the models of a plain OpenAI-compatible server, with nothing it does not say', async () => {
    const server = await fake({ 'GET /v1/models': list({ id: 'alpha', owned_by: 'someone' }, { id: 'beta' }) })
    const result = ok(await checkOwnServer(server.address, undefined))
    expect(result).toMatchObject({ address: `${server.address}/v1`, kind: 'openai-compatible' })
    expect(result.models).toEqual([{ id: 'alpha', name: 'alpha', images: false }, { id: 'beta', name: 'beta', images: false }])
    expect(result.answeredMs).toBeGreaterThanOrEqual(0)
    // No key was given, so none was sent.
    expect(server.seen.every(request => request.auth === undefined)).toBe(true)
  })

  it('sends a key as a Bearer token to every request, and only to the address given', async () => {
    const server = await fake({ 'GET /v1/models': list({ id: 'alpha' }) })
    ok(await checkOwnServer(server.address, '  made-up-key-1  '))
    expect(server.seen.length).toBeGreaterThan(1)
    expect(server.seen.every(request => request.auth === 'Bearer made-up-key-1')).toBe(true)
  })

  it('says nothing answered when the port is closed or the server never answers', async () => {
    const closed = await fake({})
    await new Promise(resolve => { servers.pop()!.close(resolve) })
    expect(await checkOwnServer(closed.address, undefined)).toEqual({ status: 'refused', reason: 'unreachable', message: OWN_SERVER_WORDS.unreachable(closed.host) })
    const silent = await fake({ 'GET /v1/models': () => ({ hang: true }) })
    expect(await checkOwnServer(silent.address, undefined, { requestMs: 200 })).toMatchObject({ status: 'refused', reason: 'unreachable' })
  })

  it('asks for a key when none was given, and says the key was refused when one was', async () => {
    const server = await fake({ 'GET /v1/models': () => ({ status: 401, json: { error: 'no' } }) })
    expect(await checkOwnServer(server.address, undefined)).toEqual({ status: 'refused', reason: 'key-needed', message: OWN_SERVER_WORDS.keyNeeded(server.host) })
    expect(await checkOwnServer(server.address, 'wrong')).toEqual({ status: 'refused', reason: 'key-refused', message: OWN_SERVER_WORDS.keyRefused(server.host) })
    const forbidden = await fake({ 'GET /v1/models': () => ({ status: 403, text: 'Forbidden' }) })
    expect(await checkOwnServer(forbidden.address, 'wrong')).toMatchObject({ reason: 'key-refused' })
  })

  it('says something else answered for a missing route, an answer that is not JSON or one without a model list', async () => {
    const missing = await fake({})
    expect(await checkOwnServer(missing.address, undefined)).toEqual({ status: 'refused', reason: 'not-openai', message: OWN_SERVER_WORDS.notOpenAI(missing.host) })
    const page = await fake({ 'GET /v1/models': () => ({ text: '<html>router login</html>' }) })
    expect(await checkOwnServer(page.address, undefined)).toMatchObject({ reason: 'not-openai' })
    const shape = await fake({ 'GET /v1/models': () => ({ json: { models: ['alpha'] } }) })
    expect(await checkOwnServer(shape.address, undefined)).toMatchObject({ reason: 'not-openai' })
    const moved = await fake({ 'GET /v1/models': () => ({ status: 302, headers: { location: 'http://example.com/v1/models' }, text: '' }) })
    expect(await checkOwnServer(moved.address, 'made-up-key')).toMatchObject({ reason: 'not-openai' })
  })

  it('says the server has no models when its list is empty', async () => {
    const server = await fake({ 'GET /v1/models': list() })
    expect(await checkOwnServer(server.address, undefined)).toEqual({ status: 'refused', reason: 'no-models', message: OWN_SERVER_WORDS.noModels(server.host) })
  })

  it('refuses an address before sending anything to it', async () => {
    expect(await checkOwnServer('http://models.example.com', undefined)).toMatchObject({ reason: 'public-http', message: OWN_SERVER_WORDS.publicHttp('models.example.com') })
    expect(await checkOwnServer('ftp://localhost', undefined)).toMatchObject({ reason: 'bad-address', message: OWN_SERVER_WORDS.badAddress })
  })

  it('keeps at most 64 models, each once, in the server’s order', async () => {
    const items = [{ id: 'dup' }, { id: 'dup' }, { nope: true }, ...Array.from({ length: 80 }, (_, index) => ({ id: `m${index}` }))]
    const server = await fake({ 'GET /v1/models': list(...items) })
    const models = ok(await checkOwnServer(server.address, undefined)).models
    expect(models).toHaveLength(64)
    expect(models[0]!.id).toBe('dup')
    expect(models[1]!.id).toBe('m0')
  })

  it('ends the whole check by its overall deadline, leaving what was not answered unknown', async () => {
    const server = await fake({ 'GET /v1/models': list({ id: 'alpha' }), 'GET /api/tags': () => ({ hang: true }), 'GET /props': () => ({ hang: true }) })
    const started = Date.now()
    const result = ok(await checkOwnServer(server.address, undefined, { totalMs: 500, requestMs: 10_000 }))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result).toMatchObject({ kind: 'openai-compatible', models: [{ id: 'alpha', images: false }] })
  })
})

describe('what each kind of server says about its models', () => {
  it('reads vLLM’s context from its model list', async () => {
    const server = await fake({ 'GET /v1/models': list({ id: 'Qwen/Qwen3-32B', owned_by: 'vllm', max_model_len: 40_960 }) })
    const result = ok(await checkOwnServer(server.address, undefined))
    expect(result).toMatchObject({ kind: 'vllm', models: [{ id: 'Qwen/Qwen3-32B', context: 40_960, images: false }] })
    expect(result.models[0]!.thinking).toBeUndefined()
    // The list said which kind it is, so nothing else was asked.
    expect(server.seen.map(request => request.path)).toEqual(['/v1/models'])
  })

  it('reads SGLang’s context from its list, and whether it thinks from its reasoning parser', async () => {
    const thinking = await fake({ 'GET /v1/models': list({ id: 'deepseek-ai/DeepSeek-V4.1-Flash', owned_by: 'sglang', max_model_len: 163_840 }),
      'GET /model_info': () => ({ json: { model_path: 'deepseek-ai/DeepSeek-V4.1-Flash', reasoning_parser: 'deepseek-r1', has_image_understanding: false } }) })
    expect(ok(await checkOwnServer(thinking.address, undefined))).toMatchObject({ kind: 'sglang', models: [{ context: 163_840, thinking: true, images: false }] })
    const plain = await fake({ 'GET /v1/models': list({ id: 'llama', owned_by: 'sglang', max_model_len: 8_192 }), 'GET /model_info': () => ({ json: { reasoning_parser: null } }) })
    expect(ok(await checkOwnServer(plain.address, undefined)).models[0]).toMatchObject({ thinking: false })
    const unknown = await fake({ 'GET /v1/models': list({ id: 'llama', owned_by: 'sglang', max_model_len: 8_192 }) })
    expect(ok(await checkOwnServer(unknown.address, undefined)).models[0]!.thinking).toBeUndefined()
  })

  it('asks Ollama about each model: its architecture’s context, thinking and vision, and leaves embedding models out', async () => {
    const shown: Record<string, unknown> = {
      'qwen3:32b': { model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40_960 }, capabilities: ['completion', 'tools', 'thinking'] },
      'gemma3:27b': { model_info: { 'general.architecture': 'gemma3', 'gemma3.context_length': 131_072 }, capabilities: ['completion', 'vision'] },
      'nomic-embed-text:latest': { model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 2_048 }, capabilities: ['embedding'] },
    }
    const server = await fake({
      'GET /v1/models': list({ id: 'qwen3:32b', owned_by: 'library' }, { id: 'gemma3:27b', owned_by: 'library' }, { id: 'nomic-embed-text:latest', owned_by: 'library' }),
      'GET /api/tags': () => ({ json: { models: [{ name: 'qwen3:32b' }] } }),
      'POST /api/show': body => ({ json: shown[(body as { model: string }).model] }),
    })
    const result = ok(await checkOwnServer(`${server.address}/v1`, undefined))
    expect(result.kind).toBe('ollama')
    expect(result.models).toEqual([
      { id: 'qwen3:32b', name: 'qwen3:32b', context: 40_960, thinking: true, images: false },
      { id: 'gemma3:27b', name: 'gemma3:27b', context: 131_072, thinking: false, images: true },
    ])
  })

  it('reads LM Studio’s own model list, preferring the context a loaded model runs with', async () => {
    const server = await fake({
      'GET /v1/models': list({ id: 'qwen/qwen3-30b-a3b', owned_by: 'organization_owner' }, { id: 'google/gemma-3-12b', owned_by: 'organization_owner' }, { id: 'text-embedding-nomic', owned_by: 'organization_owner' }),
      'GET /api/v1/models': () => ({ json: { models: [
        { type: 'llm', key: 'qwen/qwen3-30b-a3b', display_name: 'Qwen3 30B A3B', max_context_length: 131_072, capabilities: { vision: false, trained_for_tool_use: true, reasoning: { allowed_options: ['off', 'on'] } },
          loaded_instances: [{ id: 'qwen/qwen3-30b-a3b', config: { context_length: 32_768 } }] },
        { type: 'llm', key: 'google/gemma-3-12b', display_name: 'Gemma 3 12B', max_context_length: 131_072, capabilities: { vision: true, trained_for_tool_use: false } },
        { type: 'embedding', key: 'text-embedding-nomic', max_context_length: 2_048 },
      ] } }),
    })
    const result = ok(await checkOwnServer(server.address, undefined))
    expect(result.kind).toBe('lmstudio')
    expect(result.models).toEqual([
      { id: 'qwen/qwen3-30b-a3b', name: 'Qwen3 30B A3B', context: 32_768, thinking: true, images: false },
      { id: 'google/gemma-3-12b', name: 'Gemma 3 12B', context: 131_072, thinking: false, images: true },
    ])
  })

  it('reads an older LM Studio’s v0 list when v1 is not there', async () => {
    const server = await fake({
      'GET /v1/models': list({ id: 'llava', owned_by: 'organization_owner' }),
      'GET /api/v0/models': () => ({ json: { object: 'list', data: [{ id: 'llava', type: 'vlm', max_context_length: 4_096 }] } }),
    })
    expect(ok(await checkOwnServer(server.address, undefined))).toMatchObject({ kind: 'lmstudio', models: [{ id: 'llava', context: 4_096, images: true }] })
  })

  it('reads llama.cpp’s running context, template and vision from /props, and its trained context from the list without them', async () => {
    const server = await fake({
      'GET /v1/models': list({ id: 'gpt-oss-20b', owned_by: 'llamacpp', meta: { n_ctx_train: 131_072 } }),
      'GET /props': () => ({ json: { default_generation_settings: { n_ctx: 65_536 }, chat_template_caps: { supports_tools: true, supports_reasoning_effort: true }, modalities: { vision: false } } }),
    })
    expect(ok(await checkOwnServer(server.address, undefined))).toMatchObject({ kind: 'llamacpp', models: [{ context: 65_536, thinking: true, images: false }] })
    const bare = await fake({ 'GET /v1/models': list({ id: 'm', owned_by: 'llamacpp', meta: { n_ctx_train: 131_072 } }) })
    expect(ok(await checkOwnServer(bare.address, undefined)).models[0]).toMatchObject({ context: 131_072 })
  })

  it('finds llama.cpp by /props when its list does not say', async () => {
    const server = await fake({
      'GET /v1/models': list({ id: 'm' }),
      'GET /props': () => ({ json: { default_generation_settings: { n_ctx: 16_384 }, modalities: { vision: true } } }),
    })
    expect(ok(await checkOwnServer(server.address, undefined))).toMatchObject({ kind: 'llamacpp', models: [{ context: 16_384, images: true }] })
  })

  it('reads TGI’s longest prompt from /info', async () => {
    const server = await fake({ 'GET /v1/models': list({ id: 'tgi' }), 'GET /info': () => ({ json: { model_id: 'meta-llama/Llama-3.1-8B', max_input_tokens: 8_191, max_total_tokens: 8_192 } }) })
    expect(ok(await checkOwnServer(server.address, undefined))).toMatchObject({ kind: 'tgi', models: [{ id: 'tgi', context: 8_191 }] })
  })

  it('leaves a context out that no model could be given', async () => {
    const server = await fake({ 'GET /v1/models': list({ id: 'tiny', owned_by: 'vllm', max_model_len: 512 }, { id: 'huge', owned_by: 'vllm', max_model_len: 1e12 }) })
    const models = ok(await checkOwnServer(server.address, undefined)).models
    expect(models.every(model => model.context === undefined)).toBe(true)
  })

  it('treats an extra request that fails as unknown, never as a refusal', async () => {
    const server = await fake({ 'GET /v1/models': list({ id: 'm' }), 'GET /api/tags': () => ({ status: 500, text: 'boom' }), 'GET /props': () => ({ text: 'not json' }) })
    expect(ok(await checkOwnServer(server.address, undefined))).toMatchObject({ kind: 'openai-compatible', models: [{ id: 'm' }] })
  })

  it('finds a server’s own routes beside the OpenAI path it was given', () => {
    expect(serverRoot('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(serverRoot('https://proxy.example.com/ollama/v1')).toBe('https://proxy.example.com/ollama')
    expect(serverRoot('http://localhost:8000/openai')).toBe('http://localhost:8000/openai')
  })
})
