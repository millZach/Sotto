# Windows output measurement

`loopback.cpp` observes only the target process and its descendants through Windows process loopback. It does not open a microphone, capture other applications, or retain raw captured PCM. Each JSON packet records first/last sample at or above 33/32768 (about −60 dBFS), its peak, and the Windows audio engine timestamp. The stream is 48 kHz, stereo PCM16. This observes rendered Windows output, including output that continues after `Audio.pause()`; it does not measure a speaker or Bluetooth device acoustically.

Build on Windows 10 build 20348 or newer with MSVC C++ Build Tools and Windows SDK installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tts-bench/loopback-build.ps1
```

The executable goes into ignored `artifacts/tts-bench/loopback-build`. In the benchmark Node controller:

```js
import { startLoopback, qpcMs } from './loopback.mjs'
const capture = await startLoopback(electronMainPid)
const requestTime = qpcMs()
// Trigger the benchmark's own synthetic speech playback; wait through its stop and silence tail.
const summary = capture.summarize(requestTime, qpcMs())
await capture.stop()
// Persist capture.metadata, capture.packets, and summary with the trial report.
```

`capture.packets` updates throughout capture. `qpcMs` values share the Windows QPC clock with Node `process.hrtime`; the native ready event's timestamp and Node receipt were 0.208 ms apart in the clock probe. Renderer timestamps require a separately measured renderer-to-Node offset and uncertainty. The native packet timestamp locates its first frame; an output frame's timestamp is `qpcMs + frame / 48`. Ignore invalid timestamps (`flags & 4`), and report discontinuities (`flags & 1`) instead of silently accepting affected trials. Packet first/last fields delimit an entire packet, so summarize windows should have quiet margins rather than cut through active packets.

Observe at least 300 ms of silence after a stop. The last active sample can precede a stop issued during a natural speech pause; that trial does not establish cancellation latency while speech is active. Repeated trials should issue Stop during confirmed active speech, save the raw envelope, and distinguish a nonpositive result from a truncated/canceled recording. Missing packets do not prove silence.

Validation: `loopback-probe.cjs` plays a controlled 440 Hz oscillator in a separate Electron profile and captures only that Electron process tree. The verified probe measured 217.36 ms from main-process request to output onset and 96.44 ms from main-process stop request to silence, with zero timestamp errors and zero discontinuities. These values validate observation of the playback pipeline; they are not TTS provider results. Its packet evidence is saved as `artifacts/tts-bench/loopback-build/probe.json`. Run with `ELECTRON_RUN_AS_NODE` unset. `node --test scripts/tts-bench/loopback.test.mjs` validates envelope boundary math and timestamp-error handling.

Primary sources: [Microsoft process loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/), [IAudioCaptureClient GetBuffer timestamp units and flags](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer), [WASAPI loopback behavior](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording).
