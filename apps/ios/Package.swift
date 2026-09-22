// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "SottoCore", platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "SottoCore", targets: ["SottoCore"])],
    targets: [.target(name: "SottoCore"), .testTarget(name: "SottoCoreTests", dependencies: ["SottoCore"])])
