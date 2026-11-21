import { pictureCopy, pictureRedraw, pictureThumbnail, type PictureAnswer, type PictureRequest } from './pictureCopy'

/**
 * The headless host's picture worker (ADR-0203): a process of its own, started by `PictureMaker` with Node's `fork`, that
 * makes the copies phones ask for at a longest edge, one picture at a time in the order asked, so decoding and encoding
 * never hold the host's own thread and the memory they take goes back to the system when it ends. Built beside the host's
 * index.js (`scripts/build-host.mjs`). A picture it cannot make is answered with no copy, and the phone is sent it whole.
 * It writes nothing to standard output or error, which the host does not read.
 */
process.on('message', (request: PictureRequest) => {
  let copy: string | null = null
  let kind: 'image/jpeg' | 'image/png' | undefined
  try {
    if (request.op === 'thumbnail') copy = pictureThumbnail(request.dataUrl, request.width, request.height)
    else if (request.op === 'redraw') {
      const drawn = pictureRedraw(request.dataUrl, request.kind)
      if (drawn) { copy = drawn.dataUrl; kind = drawn.kind }
    } else copy = pictureCopy(request.dataUrl, request.edge)
  } catch { copy = null }
  process.send?.({ id: request.id, copy, ...(kind ? { kind } : {}), pid: process.pid } satisfies PictureAnswer)
})
// It ends with the host: once the channel to it closes, nothing is left to ask.
process.on('disconnect', () => { process.exit(0) })
