// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { glbProblem } from '../../../../../src/main/tools/meshy/glb'
import { glbBytes, selfContainedGlb, texturedCubeGlb } from '../../../../fixtures/glb'

/** A GLB the window draws must hold everything it needs (ADR-0141): any `uri` would have a viewer fetch it. */
describe('whether a GLB stands alone', () => {
  it('takes one whose buffer and image are in its own binary chunk', () => {
    expect(glbProblem(selfContainedGlb())).toBeNull()
    expect(glbProblem(glbBytes({ asset: { version: '2.0' } }))).toBeNull()
    // The textured cube the end-to-end journey draws.
    expect(glbProblem(texturedCubeGlb())).toBeNull()
  })

  it('refuses one whose buffer or image names a uri, whatever it names', () => {
    for (const uri of ['model.bin', 'https://example.com/model.bin', 'file:///C:/Windows/win.ini', 'data:application/octet-stream;base64,AAAA', ''])
      expect(glbProblem(glbBytes({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri }] }))).toBe('external')
    expect(glbProblem(glbBytes({ asset: { version: '2.0' }, images: [{ uri: '../../secret.png' }] }))).toBe('external')
    expect(glbProblem(glbBytes({ asset: { version: '2.0' }, images: [{ bufferView: 0 }, { uri: 'second.png' }] }))).toBe('external')
  })

  it('refuses what is not a GLB', () => {
    expect(glbProblem(new TextEncoder().encode('{"asset":{"version":"2.0"}}'))).toBe('not-glb')
    expect(glbProblem(new Uint8Array(0))).toBe('not-glb')
    const version1 = selfContainedGlb()
    new DataView(version1.buffer).setUint32(4, 1, true)
    expect(glbProblem(version1)).toBe('not-glb')
    // A JSON chunk that is not JSON, or not an object.
    const broken = glbBytes({ asset: { version: '2.0' } })
    broken[20] = 0x7b; broken[21] = 0x7b
    expect(glbProblem(broken)).toBe('not-glb')
    expect(glbProblem(glbBytes([1, 2]))).toBe('not-glb')
    expect(glbProblem(glbBytes({ buffers: 'model.bin' }))).toBe('not-glb')
  })

  it('refuses one cut short', () => {
    const whole = selfContainedGlb()
    expect(glbProblem(whole.subarray(0, whole.byteLength - 4))).toBe('truncated')
    expect(glbProblem(whole.subarray(0, 8))).toBe('truncated')
    // A chunk that says it runs past the file's own length.
    const long = selfContainedGlb()
    new DataView(long.buffer).setUint32(12, 10_000, true)
    expect(glbProblem(long)).toBe('truncated')
  })
})
