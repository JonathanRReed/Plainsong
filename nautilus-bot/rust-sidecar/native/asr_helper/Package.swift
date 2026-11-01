// swift-tools-version: 6.1
//
// Plainsong's speech helper: Parakeet on the Neural Engine through FluidAudio.
//
// FluidAudio is pinned to one exact release (Apache-2.0). Its optional
// `NemoTextProcessing` trait links a prebuilt binary framework downloaded at
// build time; Plainsong turns every trait off (`traits: []`) so the helper is
// built only from source that this pin and Package.resolved fix.
import PackageDescription

let package = Package(
    name: "PlainsongAsrHelper",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            exact: "0.17.7",
            traits: []
        )
    ],
    targets: [
        .executableTarget(
            name: "PlainsongAsrHelper",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/PlainsongAsrHelper"
        )
    ],
    swiftLanguageModes: [.v5]
)
