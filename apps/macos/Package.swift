// swift-tools-version: 5.10
import PackageDescription
let package = Package(
    name: "ReifyMac", platforms: [.macOS(.v14)],
    products: [.executable(name: "Reify", targets: ["Reify"]), .executable(name: "ReifyE2E", targets: ["ReifyE2E"])],
    targets: [.target(name: "ReifyCloud"), .executableTarget(name: "Reify", dependencies: ["ReifyCloud"], resources: [.copy("Resources")]),
              .executableTarget(name: "ReifyE2E", dependencies: ["ReifyCloud"])]
)
