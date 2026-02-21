#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


def model_spec_for(provider: str, model_dir: Path) -> str:
    if provider == "vibevoice":
        if (model_dir / "config.json").exists():
            return str(model_dir)
        return "microsoft/VibeVoice-ASR"
    if provider == "voxtral_local":
        if (model_dir / "config.json").exists():
            return str(model_dir)
        return "mistralai/Voxtral-Mini-4B-Realtime-2602"
    raise ValueError(f"Unsupported provider: {provider}")


def run_probe(provider: str):
    if provider in {"vibevoice", "voxtral_local"}:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        import soundfile  # noqa: F401
        import librosa  # noqa: F401
    emit({"ok": True})


def run_download(provider: str, model_dir: Path):
    from huggingface_hub import snapshot_download

    model_dir.mkdir(parents=True, exist_ok=True)
    if provider == "vibevoice":
        repo_id = "microsoft/VibeVoice-ASR"
    elif provider == "voxtral_local":
        repo_id = "mistralai/Voxtral-Mini-4B-Realtime-2602"
    else:
        raise ValueError(f"Unsupported provider for download: {provider}")

    snapshot_download(
        repo_id=repo_id,
        local_dir=str(model_dir),
        local_dir_use_symlinks=False,
        allow_patterns=[
            "*.json",
            "*.safetensors",
            "*.txt",
            "*.model",
            "tokenizer*",
            "*.bin",
        ],
    )
    emit({"ok": True})


def run_transcribe(provider: str, model_dir: Path, audio_path: Path):
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    from transformers import pipeline

    model_spec = model_spec_for(provider, model_dir)

    # Let transformers choose available backend/device; this keeps startup simple
    # while still supporting Apple Silicon / CUDA environments.
    pipe = pipeline(
        task="automatic-speech-recognition",
        model=model_spec,
        trust_remote_code=True,
    )

    result = pipe(str(audio_path))
    text = ""
    if isinstance(result, dict):
        text = str(result.get("text", "")).strip()
    else:
        text = str(result).strip()

    emit({
        "ok": True,
        "text": text,
        "language": "auto",
        "confidence": 0.9,
    })


def main():
    parser = argparse.ArgumentParser(description="Nautilus Python ASR runner")
    parser.add_argument("--provider", required=True)
    parser.add_argument("--action", required=True, choices=["probe", "download", "transcribe"])
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--audio-path")
    parser.add_argument("--model-id")
    args = parser.parse_args()

    provider = args.provider.strip()
    action = args.action.strip()
    model_dir = Path(args.model_dir).expanduser().resolve()

    try:
        if action == "probe":
            run_probe(provider)
            return

        if action == "download":
            run_download(provider, model_dir)
            return

        if action == "transcribe":
            if not args.audio_path:
                raise ValueError("--audio-path is required for transcribe action")
            audio_path = Path(args.audio_path).expanduser().resolve()
            run_transcribe(provider, model_dir, audio_path)
            return

        raise ValueError(f"Unsupported action: {action}")
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
