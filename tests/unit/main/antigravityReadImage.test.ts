// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { antigravityReadImagePath } from '../../../src/main/agents/antigravityActivity'

describe('antigravityReadImagePath', () => {
  it('resolves relative and absolute raster image paths from completed read calls', () => {
    expect(antigravityReadImagePath(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        kind: 'read',
        title: 'Read /repo/shot.png',
        status: 'completed',
        rawInput: { Path: 'assets/shot.png' },
      },
      { status: 'completed', title: 'Read /repo/shot.png' },
      '/repo',
      'linux',
    )).toBe('/repo/assets/shot.png')

    expect(antigravityReadImagePath(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_2',
        status: 'completed',
        locations: [{ path: '/tmp/artifacts/preview.WEBP' }],
      },
      { status: 'completed', title: 'Run read_file' },
      '/repo',
      'linux',
    )).toBe('/tmp/artifacts/preview.WEBP')
  })

  it('normalizes Windows /C:/ paths while preserving paths outside cwd', () => {
    expect(antigravityReadImagePath(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_3',
        kind: 'read',
        status: 'completed',
        locations: [{ path: '/C:/Users/zach/AppData/shot.jpeg' }],
      },
      { status: 'completed', title: 'Read' },
      'C:\\work\\repo',
      'win32',
    )).toBe('C:\\Users\\zach\\AppData\\shot.jpeg')
  })

  it('captures extensionless paths only when tool output indicates a raster image MIME type', () => {
    expect(antigravityReadImagePath(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_4',
        kind: 'read',
        status: 'completed',
        rawInput: { file_path: '/tmp/blob-123' },
        content: [{ type: 'content', content: { type: 'text', text: 'Loaded image/png (800x600)' } }],
      },
      { status: 'completed', title: 'Read' },
      '/repo',
      'linux',
    )).toBe('/tmp/blob-123')

    expect(antigravityReadImagePath(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_5',
        kind: 'read',
        status: 'completed',
        rawInput: { file_path: '/tmp/blob-svg' },
        content: [{ type: 'content', content: { type: 'text', text: 'Loaded image/svg+xml' } }],
      },
      { status: 'completed', title: 'Read' },
      '/repo',
      'linux',
    )).toBeUndefined()
  })

  it('skips incomplete/failed reads, non-read tools, SVGs/text files, existing media, and missing paths', () => {
    expect(antigravityReadImagePath(
      { sessionUpdate: 'tool_call', toolCallId: 'call_6', kind: 'read', status: 'in_progress', rawInput: { Path: 'a.png' } },
      { status: 'running', title: 'Read' },
      '/repo',
    )).toBeUndefined()

    expect(antigravityReadImagePath(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call_7', kind: 'read', status: 'failed', rawInput: { Path: 'a.png' } },
      { status: 'failed', title: 'Read' },
      '/repo',
    )).toBeUndefined()

    expect(antigravityReadImagePath(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call_8', kind: 'execute', status: 'completed', rawInput: { Path: 'a.png' } },
      { status: 'completed', title: 'Run run_command' },
      '/repo',
    )).toBeUndefined()

    expect(antigravityReadImagePath(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call_9', kind: 'read', status: 'completed', rawInput: { Path: 'icon.svg' } },
      { status: 'completed', title: 'Read icon.svg' },
      '/repo',
    )).toBeUndefined()

    expect(antigravityReadImagePath(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call_10', kind: 'read', status: 'completed', rawInput: { Path: 'src/app.ts' } },
      { status: 'completed', title: 'Read src/app.ts' },
      '/repo',
    )).toBeUndefined()

    expect(antigravityReadImagePath(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call_11', kind: 'read', status: 'completed', rawInput: { Path: 'a.png' } },
      {
        status: 'completed',
        title: 'Read a.png',
        media: [{ id: 'm0', digest: 'a'.repeat(64), kind: 'image', mimeType: 'image/png', sizeBytes: 100, name: 'a.png', source: 'tool' }],
      },
      '/repo',
    )).toBeUndefined()

    expect(antigravityReadImagePath(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call_12', kind: 'read', status: 'completed' },
      { status: 'completed', title: 'Read' },
      '/repo',
    )).toBeUndefined()
  })
})
