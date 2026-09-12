// Benchmark-only, process-tree WASAPI output capture. No microphone or endpoint mix.
// API references: https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
// https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <audioclientactivationparams.h>
#include <wrl.h>
#include <iostream>
#include <iomanip>
#include <atomic>
#include <thread>
#include <string>
#include <cmath>

using namespace Microsoft::WRL;
static double nowMs() {
  LARGE_INTEGER n, f; QueryPerformanceCounter(&n); QueryPerformanceFrequency(&f);
  return double(n.QuadPart) * 1000.0 / double(f.QuadPart);
}
static void check(HRESULT result, const char* operation) {
  if (FAILED(result)) {
    std::cerr << operation << " failed: 0x" << std::hex << unsigned(result) << std::endl;
    ExitProcess(2);
  }
}
class Activation final : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE complete = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_PENDING;
  ComPtr<IAudioClient> client;
  ~Activation() { CloseHandle(complete); }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
    ComPtr<IUnknown> unknown;
    HRESULT activationResult;
    result = operation->GetActivateResult(&activationResult, &unknown);
    if (SUCCEEDED(result)) result = activationResult;
    if (SUCCEEDED(result)) result = unknown.As(&client);
    SetEvent(complete);
    return S_OK;
  }
};
int main(int argc, char** argv) {
  if (argc != 2 || std::stoul(argv[1]) == 0) { std::cerr << "Usage: loopback.exe TARGET_PID\n"; return 1; }
  DWORD target = std::stoul(argv[1]);
  check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "CoInitializeEx");
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = target;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT variant{}; variant.vt = VT_BLOB;
  variant.blob.cbSize = sizeof(params); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
  auto activation = Make<Activation>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, activation.Get(), &operation), "ActivateAudioInterfaceAsync");
  if (WaitForSingleObject(activation->complete, 10000) != WAIT_OBJECT_0) { std::cerr << "Activation timeout\n"; return 2; }
  check(activation->result, "ActivateCompleted");
  auto client = activation->client;
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2;
  format.nSamplesPerSec = 48000; format.wBitsPerSample = 16;
  format.nBlockAlign = 4; format.nAvgBytesPerSec = 192000;
  check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    0, 0, &format, nullptr), "Initialize");
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  check(client->SetEventHandle(ready), "SetEventHandle");
  ComPtr<IAudioCaptureClient> capture;
  check(client->GetService(IID_PPV_ARGS(&capture)), "GetService");
  std::atomic<bool> stopping{false};
  std::thread input([&] { std::string line; while (std::getline(std::cin, line)) { if (line == "stop") break; } stopping = true; });
  check(client->Start(), "Start");
  std::cout << std::fixed << std::setprecision(6);
  std::cout << "{\"type\":\"ready\",\"pid\":" << target << ",\"qpcMs\":" << nowMs()
    << ",\"rate\":48000,\"channels\":2,\"threshold\":33}" << std::endl;
  while (!stopping) {
    WaitForSingleObject(ready, 50);
    UINT32 frames = 0;
    check(capture->GetNextPacketSize(&frames), "GetNextPacketSize");
    while (frames) {
      BYTE* data; DWORD flags; UINT64 devicePosition, qpc100ns;
      check(capture->GetBuffer(&data, &frames, &flags, &devicePosition, &qpc100ns), "GetBuffer");
      int first = -1, last = -1, peak = 0;
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
        auto samples = reinterpret_cast<short*>(data);
        for (UINT32 frame = 0; frame < frames; ++frame) {
          int amplitude = std::max(std::abs(int(samples[frame * 2])), std::abs(int(samples[frame * 2 + 1])));
          peak = std::max(peak, amplitude);
          if (amplitude >= 33) { if (first < 0) first = int(frame); last = int(frame); }
        }
      }
      std::cout << "{\"type\":\"packet\",\"qpcMs\":" << double(qpc100ns) / 10000.0
        << ",\"receivedQpcMs\":" << nowMs() << ",\"frames\":" << frames << ",\"flags\":" << flags
        << ",\"firstFrame\":" << first << ",\"lastFrame\":" << last << ",\"peak\":" << peak << "}" << std::endl;
      check(capture->ReleaseBuffer(frames), "ReleaseBuffer");
      check(capture->GetNextPacketSize(&frames), "GetNextPacketSize");
    }
  }
  check(client->Stop(), "Stop");
  std::cout << "{\"type\":\"stopped\",\"qpcMs\":" << nowMs() << "}" << std::endl;
  input.join(); CloseHandle(ready);
  return 0;
}
