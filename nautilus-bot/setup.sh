#!/bin/bash
set -euo pipefail

echo "====================================="
echo "Plainsong Setup"
echo "====================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v bun &> /dev/null; then
    echo "Bun not found. Install Bun first:"
    echo "  curl -fsSL https://bun.sh/install | bash"
    exit 1
fi
echo "Bun found: $(bun --version)"

if ! command -v cargo &> /dev/null || ! command -v rustc &> /dev/null; then
    echo "Stable Rust toolchain not found. Install Rust first:"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi
echo "Cargo found: $(cargo --version)"
echo "Rust compiler found: $(rustc --version)"

if ! command -v cmake &> /dev/null; then
    echo "CMake not found. Install it first:"
    echo "  brew install cmake"
    exit 1
fi
CMAKE_VERSION="$(cmake --version)"
echo "CMake found: ${CMAKE_VERSION%%$'\n'*}"

if ! command -v xcrun &> /dev/null || ! xcrun --find swiftc &> /dev/null; then
    echo "Xcode Command Line Tools with the Swift compiler were not found."
    echo "Install them first:"
    echo "  xcode-select --install"
    exit 1
fi
echo "Swift compiler found: $(xcrun --find swiftc)"

echo ""
echo "Installing dependencies from bun.lock..."
bun install --frozen-lockfile

echo ""
echo "Compiling Electron and the locked release sidecar..."
bun run electron:compile
bun run sidecar:build:release

echo ""
echo "====================================="
echo "Setup complete!"
echo "====================================="
echo ""
echo "To run the app in development mode:"
echo "  bun run dev"
echo ""
echo "To build for production:"
echo "  bun run build"
echo ""
