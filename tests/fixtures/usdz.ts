/**
 * A tiny USDZ built in memory, for tests of the check that one is whole before a phone is handed it (the Meshy plan's
 * ticket 7): a ZIP archive of stored files, the first `first`, with its central directory and end record, as the ZIP
 * specification lays one out. `method` is the first file's compression method; 0 is stored, as a USDZ must be.
 */
export function usdzBytes(files: readonly (readonly [name: string, body: Uint8Array])[] = [['model.usdc', new Uint8Array(64)]], method = 0): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  files.forEach(([name, body], index) => {
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(index === 0 ? method : 0, 8)
    local.writeUInt32LE(body.byteLength, 18)
    local.writeUInt32LE(body.byteLength, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(body.byteLength, 20)
    entry.writeUInt32LE(body.byteLength, 24)
    entry.writeUInt16LE(nameBytes.byteLength, 28)
    entry.writeUInt32LE(offset, 42)
    const written = Buffer.concat([local, nameBytes, Buffer.from(body)])
    locals.push(written)
    central.push(Buffer.concat([entry, nameBytes]))
    offset += written.byteLength
  })
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}
