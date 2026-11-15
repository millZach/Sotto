import { Box3, Group, Mesh, Texture, Vector3, type Material, type Object3D } from 'three'
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * A GLB's bytes as a scene the turnable view draws (ADR-0141; the Meshy plan's ticket 4), with nothing of React, so it
 * loads with three.js and only then. Every picture in the model is decoded from the model's own bytes: nothing is
 * loaded through an address, and a picture with no bytes of its own is not drawn at all.
 */

/** The model, centred and scaled to fit a sphere of radius one, whatever size Meshy made it. */
export function parseModel(bytes: Uint8Array): Promise<Group> {
  const loader = new GLTFLoader()
  loader.register(parser => { picturesFromBytes(parser); return { name: 'sotto_pictures_from_bytes' } })
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Promise((resolve, reject) => {
    loader.parse(buffer, '', gltf => {
      const box = new Box3().setFromObject(gltf.scene)
      const radius = box.getSize(new Vector3()).length() / 2 || 1
      gltf.scene.position.sub(box.getCenter(new Vector3()))
      const holder = new Group()
      holder.add(gltf.scene)
      holder.scale.setScalar(1 / radius)
      resolve(holder)
    }, reject)
  })
}

/**
 * Has the parser decode each of the GLB's pictures from its own bytes. three.js would otherwise hand each one to the
 * window as a `blob:` address, which the main window's policy does not allow, and a picture that names an address of
 * its own would be fetched.
 */
function picturesFromBytes(parser: GLTFParser): void {
  parser.loadImageSource = async (sourceIndex: number): Promise<Texture> => {
    const source = (parser.json as { images?: readonly { bufferView?: number; mimeType?: string }[] }).images?.[sourceIndex]
    if (source?.bufferView === undefined) throw new Error('A picture outside the 3D model is not drawn.')
    const bytes = await parser.getDependency('bufferView', source.bufferView) as ArrayBuffer
    const picture = await createImageBitmap(new Blob([bytes], source.mimeType ? { type: source.mimeType } : {}), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const texture = new Texture(picture)
    texture.needsUpdate = true
    if (source.mimeType) texture.userData.mimeType = source.mimeType
    return texture
  }
}

/** Frees what a scene holds on the graphics card, and the pictures behind its textures. */
export function disposeScene(root: Object3D): void {
  root.traverse(node => {
    if (!(node instanceof Mesh)) return
    node.geometry.dispose()
    for (const material of (Array.isArray(node.material) ? node.material : [node.material]) as Material[]) {
      for (const value of Object.values(material)) if (value instanceof Texture) { (value.image as { close?: () => void } | undefined)?.close?.(); value.dispose() }
      material.dispose()
    }
  })
}
