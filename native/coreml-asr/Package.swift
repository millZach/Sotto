// swift-tools-version: 6.0
// Sotto's Core ML speech helper. It runs FluidAudio's Parakeet models on Apple silicon Macs.
import PackageDescription

let package = Package(
  name: "sotto-coreml-asr",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "sotto-coreml-asr", targets: ["sotto-coreml-asr"])],
  dependencies: [
    .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7")
  ],
  targets: [
    .executableTarget(
      name: "sotto-coreml-asr",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
    )
  ]
)
