#!/bin/bash

echo "====================================="
echo "Nautilus Bot Setup"
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

if ! command -v cargo &> /dev/null; then
    echo "Rust/Cargo not found. Install Rust first:"
    echo "   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi
echo "Cargo found: $(cargo --version)"

echo ""
echo "Installing dependencies..."
bun install

if [ $? -ne 0 ]; then
    echo "Failed to install dependencies"
    exit 1
fi

echo ""
echo "Compiling Electron and sidecar entry points..."
bun run electron:compile
cargo build --manifest-path rust-sidecar/Cargo.toml --bin nautilus-sidecar

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
