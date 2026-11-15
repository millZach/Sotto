import { write as writePng } from 'pngjs/lib/png-sync'

/**
 * A tiny binary glTF built in memory, for tests of the check that a GLB stands alone (ADR-0141). `json` is the JSON
 * chunk; `bin`, when given, the binary chunk. Both are padded to four bytes, as the GLB layout asks.
 */
export function glbBytes(json: unknown, bin?: Uint8Array): Uint8Array {
  const text = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - text.byteLength % 4) % 4, 0x20)])
  const binChunk = bin ? Buffer.concat([Buffer.from(bin), Buffer.alloc((4 - bin.byteLength % 4) % 4)]) : undefined
  const length = 12 + 8 + jsonChunk.byteLength + (binChunk ? 8 + binChunk.byteLength : 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(length, 8)
  const chunk = (type: number, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(body.byteLength, 0)
    head.writeUInt32LE(type, 4)
    return Buffer.concat([head, body])
  }
  return new Uint8Array(Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), ...(binChunk ? [chunk(0x004e4942, binChunk)] : [])]))
}

/** A GLB holding one triangle's buffer and one image, both in its own binary chunk. */
export function selfContainedGlb(): Uint8Array {
  const bin = new Uint8Array(48)
  return glbBytes({
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }],
    images: [{ bufferView: 1, mimeType: 'image/png' }],
  }, bin)
}

/** A picture of `width` by `height` filled cell by cell: `colours` across `columns` cells in each row, as RGB. */
export function cellsPng(width: number, height: number, columns: number, colours: readonly (readonly [number, number, number])[]): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  const rows = Math.ceil(colours.length / columns)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = Math.floor(y / (height / rows)) * columns + Math.floor(x / (width / columns))
      const [r, g, b] = colours[cell] ?? [0, 0, 0]
      data.set([r, g, b, 255], (y * width + x) * 4)
    }
  }
  return new Uint8Array(writePng({ width, height, data }, { colorType: 6 }))
}

/** The cube's six faces, one colour each, so a turn is plain to see. */
const FACE_COLOURS = [[214, 92, 52], [64, 140, 214], [86, 170, 96], [232, 190, 64], [150, 96, 196], [220, 220, 214]] as const

/**
 * A cube with its six faces painted from one picture inside the GLB, a different colour each: the picture is in the
 * binary chunk, as Meshy's are, so drawing it goes through the view's decoding of a picture from the model's own bytes.
 */
export function texturedCubeGlb(): Uint8Array {
  const picture = cellsPng(96, 64, 3, FACE_COLOURS)
  // Each face: its normal and two axes along it; four corners each, with the face's cell of the picture.
  const faces = [[[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]] as const
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = []
  faces.forEach(([n, u, v], face) => {
    const [column, row] = [face % 3, Math.floor(face / 3)]
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
    for (const [a, b] of corners) {
      positions.push(...[0, 1, 2].map(axis => n[axis]! + a * u[axis]! + b * v[axis]!))
      normals.push(...n)
      // A little inside the cell, so no edge picks up its neighbour's colour.
      uvs.push((column + 0.1 + 0.8 * (a + 1) / 2) / 3, (row + 0.1 + 0.8 * (1 - (b + 1) / 2)) / 2)
    }
    const first = face * 4
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  })
  const padded = (bytes: Uint8Array): Buffer => Buffer.concat([Buffer.from(bytes), Buffer.alloc((4 - bytes.byteLength % 4) % 4)])
  const parts = [new Float32Array(positions), new Float32Array(normals), new Float32Array(uvs), new Uint16Array(indices)].map(array => padded(new Uint8Array(array.buffer)))
  parts.push(padded(picture))
  const offsets: number[] = []
  let at = 0
  for (const part of parts) { offsets.push(at); at += part.byteLength }
  const lengths = [positions.length * 4, normals.length * 4, uvs.length * 4, indices.length * 2, picture.byteLength]
  return glbBytes({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }],
    textures: [{ source: 0 }], images: [{ bufferView: 4, mimeType: 'image/png' }],
    buffers: [{ byteLength: at }],
    bufferViews: offsets.map((byteOffset, index) => ({ buffer: 0, byteOffset, byteLength: lengths[index]! })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  }, Buffer.concat(parts))
}

/** The still picture Meshy sends with a model: here, the cube's front colour beside its top's. */
export function stillPng(): Uint8Array { return cellsPng(64, 64, 2, [FACE_COLOURS[0], FACE_COLOURS[4]]) }
