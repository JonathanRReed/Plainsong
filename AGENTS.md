# NautilusBot - Development Guide

## Project Overview

NautilusBot is a macOS speech-to-text application with:
- Local-first transcription using Whisper, Parakeet, Canary, and Distil-Whisper
- Dictation mode with global hotkey (Cmd+Shift+Space)
- Meeting recording with voice activity detection
- AI-powered summarization and action item extraction
- Lemon Squeezy licensing (30-day trial, one-time purchase)

## Architecture

```
src-tauri/           # Rust backend
├── src/
│   ├── lib.rs       # Main Tauri commands
│   ├── license.rs   # Lemon Squeezy integration
│   ├── settings.rs  # Settings persistence
│   ├── asr/         # Speech recognition providers
│   ├── llm/         # LLM providers (Ollama, OpenAI, Anthropic, Gemini, DeepSeek)
│   ├── audio/       # Audio capture and VAD
│   └── crypto.rs    # AES-256-GCM encryption

src/                 # React frontend
├── components/
│   ├── views/       # Main app views
│   └── ui/          # Radix UI components
├── hooks/           # React hooks
├── lib/             # Utilities and Tauri bindings
└── types/           # TypeScript types
```

## Commands

```bash
npm run dev          # Start dev server
npm run build        # Build frontend
npm test             # Run tests
npm run tauri dev    # Full dev with Tauri
npm run tauri build  # Production build
```

## Key Features

### License System
- 30-day trial with `first_run_at` timestamp
- 7-day offline grace period
- Progressive nag: 24h → 12h → 4h intervals
- Friends Club tier gates: cloudSync, prioritySupport

### ASR Providers
- **Whisper**: whisper.cpp (native Rust, fastest)
- **Parakeet TDT**: ONNX runtime (ultra low-latency)
- **Canary Qwen**: Candle (max accuracy)
- **Distil-Whisper**: 6x faster than Whisper

### LLM Providers
- **Local**: Ollama
- **Cloud**: OpenAI, Anthropic, Gemini, DeepSeek
- Dynamic model fetching from APIs

## Configuration Files

| File | Purpose |
|------|---------|
| `tauri.conf.json` | Tauri bundle config |
| `Cargo.toml` | Rust dependencies |
| `package.json` | NPM dependencies |
| `src/types/settings.ts` | Settings types |

## Environment Variables

```
LEMONSQUEEZY_API_KEY   # License validation
OPENAI_API_KEY         # OpenAI models
ANTHROPIC_API_KEY      # Claude models
GEMINI_API_KEY         # Gemini models
DEEPSEEK_API_KEY       # DeepSeek models
```

## Testing

- `npm test` runs Vitest tests
- Tests located in `src/__tests__/`
- Mock Tauri APIs in test files

## Build for Production

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

## Store URLs

- Basic: https://nautilusbot.lemonsqueezy.com/buy/basic
- Friends Club: https://nautilusbot.lemonsqueezy.com/buy/friends-club
