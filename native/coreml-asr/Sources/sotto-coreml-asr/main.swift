// Sotto's Core ML speech helper. It loads one FluidAudio Parakeet model folder and
// transcribes audio that Sotto sends on stdin. Sotto speaks protocol version 2:
//   sotto-coreml-asr --version                      prints {"protocol":2}
//   sotto-coreml-asr <modelDirectory> <v2|v3|ultra> prints {"protocol":2,"ready":true}, or {"error":"load"} and exits 1
// Each request on stdin is little-endian: uint32 id, uint32 sample count (at most 4800000),
// then that many float32 samples at 16 kHz mono. Each response is one JSON line on stdout,
// in request order: {"id":N,"text":"..."} or {"id":N,"error":"failed"}. stdin EOF exits 0.
// FluidAudio prints its own logs to stdout, so the helper keeps the real stdout for
// protocol lines and points fd 1 at stderr. Transcript text is never printed anywhere else.

import FluidAudio
import Foundation

// Sotto's longest recording, 300 seconds at 16 kHz (MAX_TRANSCRIPTION_SAMPLES in src/shared/audio.ts).
// The model itself reads 15 seconds at a time; FluidAudio cuts anything longer into windows that
// overlap by 2 seconds and merges their words there, as it already did for 15 to 60 seconds. On
// speech with no pause at a seam that merge can still drop or repeat a word or two.
// Protocol 1 stopped at 60 seconds, which refused a long recording sent whole.
let maxSampleCount: UInt32 = 16_000 * 300

// Keep the real stdout for protocol lines; library prints go to stderr.
let protocolFd = dup(1)
dup2(2, 1)

// FluidAudio also writes to the unified log, which no file descriptor catches. Only faults go
// there, and none to the console, so what a person said cannot reach a log by that road either.
AppLogger.minimumLevel = .fault
AppLogger.mirrorsToConsole = false

func send(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
    return
  }
  var line = data
  line.append(0x0A)
  line.withUnsafeBytes { buffer in
    var offset = 0
    while offset < buffer.count {
      let written = write(protocolFd, buffer.baseAddress! + offset, buffer.count - offset)
      if written <= 0 {
        if written < 0 && errno == EINTR { continue }
        exit(1)
      }
      offset += written
    }
  }
}

/// Reads exactly `count` bytes from stdin. Returns nil on EOF or a read error.
func readExactly(_ count: Int) -> [UInt8]? {
  var bytes = [UInt8](repeating: 0, count: count)
  var offset = 0
  while offset < count {
    let got = bytes.withUnsafeMutableBytes { buffer in
      read(0, buffer.baseAddress! + offset, count - offset)
    }
    if got < 0 && errno == EINTR { continue }
    if got <= 0 { return nil }
    offset += got
  }
  return bytes
}

func littleEndianUInt32(_ bytes: [UInt8], at index: Int) -> UInt32 {
  UInt32(bytes[index]) | UInt32(bytes[index + 1]) << 8 | UInt32(bytes[index + 2]) << 16
    | UInt32(bytes[index + 3]) << 24
}

let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--version" {
  send(["protocol": 2])
  exit(0)
}

let versions: [String: AsrModelVersion] = ["v2": .v2, "v3": .v3, "ultra": .ultra]
guard arguments.count == 3, let version = versions[arguments[2]] else {
  FileHandle.standardError.write(Data("usage: sotto-coreml-asr <modelDirectory> <v2|v3|ultra>\n".utf8))
  exit(2)
}

let manager = AsrManager(config: .default)
do {
  let models = try AsrModels.loadLocal(
    from: URL(fileURLWithPath: arguments[1], isDirectory: true), version: version)
  try await manager.loadModels(models)
} catch {
  send(["error": "load"])
  exit(1)
}
// The ready line names the protocol, so Sotto refuses a helper older than itself before using it.
send(["ready": true, "protocol": 2])

while let header = readExactly(8) {
  let id = littleEndianUInt32(header, at: 0)
  let count = littleEndianUInt32(header, at: 4)
  if count > maxSampleCount {
    // The rest of the stream can't be found again, so stop.
    send(["id": id, "error": "failed"])
    exit(1)
  }
  guard let body = readExactly(Int(count) * 4) else { exit(0) }
  let samples: [Float] = (0..<Int(count)).map { index in
    Float(bitPattern: littleEndianUInt32(body, at: index * 4))
  }
  do {
    var state = TdtDecoderState.make()
    let result = try await manager.transcribe(samples, decoderState: &state)
    send(["id": id, "text": result.text.trimmingCharacters(in: .whitespacesAndNewlines)])
  } catch {
    send(["id": id, "error": "failed"])
  }
}
exit(0)
