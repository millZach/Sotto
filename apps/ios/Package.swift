// swift-tools-version: 5.9
import PackageDescription
import Foundation

// Compile the actual app model against scripted storage and transport on macOS. Keep SwiftUI
// out of SottoCore; the core's protocol tests remain usable with a standalone Swift toolchain.
var modelTests: [Target] = []
#if os(macOS)
let modelSources = ["Sotto/AppModel.swift", "Sotto/KeychainStore.swift", "Sotto/PhotoPipeline.swift", "Sotto/PhonePreferences.swift", "Tests/SottoAppModelTests"]
let appDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Sotto")
let otherAppFiles = (try? FileManager.default.contentsOfDirectory(atPath: appDirectory.path)) ?? []
modelTests = [.testTarget(name: "SottoAppModelTests", dependencies: ["SottoCore"], path: ".",
    exclude: ["Sources", "Scripts", "Sotto.xcodeproj", "README.md", "ExportOptions.example.plist", "Tests/SottoCoreTests", "Tests/SottoUITests", "Tests/SottoConnectionTests"]
        + otherAppFiles.filter { !["AppModel.swift", "KeychainStore.swift", "PhotoPipeline.swift", "PhonePreferences.swift"].contains($0) }.map { "Sotto/" + $0 }, sources: modelSources)]
modelTests.append(.testTarget(name: "SottoConnectionTests", dependencies: ["SottoCore"], path: ".",
    exclude: ["Sources", "Scripts", "Sotto.xcodeproj", "README.md", "ExportOptions.example.plist", "Tests/SottoCoreTests", "Tests/SottoUITests", "Tests/SottoAppModelTests"]
        + otherAppFiles.filter { $0 != "HostConnection.swift" }.map { "Sotto/" + $0 },
    sources: ["Sotto/HostConnection.swift", "Tests/SottoConnectionTests"]))
#endif
let package = Package(name: "SottoCore", platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "SottoCore", targets: ["SottoCore"])],
    targets: [.target(name: "SottoCore"), .testTarget(name: "SottoCoreTests", dependencies: ["SottoCore"])] + modelTests)
