#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

_VOXTRAL_RUNTIME = {
    "model_spec": None,
    "processor": None,
    "model": None,
    "device": None,
    "dtype": None,
}
_PARAKEET_RUNTIME = {
    "model_spec": None,
    "pipe": None,
}
_MLX_AUDIO_RUNTIME = {
    "model_spec": None,
    "model": None,
}


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


def emit_line(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def model_spec_for(provider: str, model_dir: Path) -> str:
    if provider == "voxtral_local":
        if (model_dir / "config.json").exists():
            return str(model_dir)
        return "mistralai/Voxtral-Mini-4B-Realtime-2602"
    if provider == "parakeet_ctc":
        manifest = model_dir / "manifest.json"
        if manifest.exists():
            payload = json.loads(manifest.read_text())
            model_id = str(payload.get("model_id", "")).strip()
            if model_id:
                return model_id
        return "nvidia/parakeet-ctc-0.6b"
    if provider == "mlx_audio_stt":
        manifest = model_dir / "manifest.json"
        if not model_dir.exists():
            raise ValueError(f"MLX Audio model directory missing: {model_dir}")
        if manifest.exists():
            payload = json.loads(manifest.read_text())
            model_id = str(payload.get("model_id", "")).strip()
            has_artifacts = any(
                child.name != "manifest.json" for child in model_dir.iterdir()
            )
            if model_id and has_artifacts:
                return str(model_dir)
            if model_id:
                return model_id
        if any(child.name != "manifest.json" for child in model_dir.iterdir()):
            return str(model_dir)
        raise ValueError(f"MLX Audio model manifest missing in {model_dir}")
    raise ValueError(f"Unsupported provider: {provider}")


def _parse_version_tuple(version: str):
    parts = []
    for token in version.split("."):
        match = re.match(r"^(\d+)", token)
        if not match:
            break
        parts.append(int(match.group(1)))
    return tuple(parts or [0])


def _require_transformers(min_version: str):
    import transformers

    current = _parse_version_tuple(transformers.__version__)
    minimum = _parse_version_tuple(min_version)
    if current < minimum:
        raise RuntimeError(
            f"transformers>={min_version} is required (found {transformers.__version__})"
        )


def _choose_device_dtype(torch):
    if torch.cuda.is_available():
        return "cuda", torch.bfloat16
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps", torch.float16
    return "cpu", torch.float32


def _tune_torch_threads(torch, device: str):
    if device != "cpu":
        return
    cpu_count = os.cpu_count() or 4
    try:
        torch.set_num_threads(max(1, min(cpu_count, 8)))
    except Exception:
        pass
    try:
        torch.set_num_interop_threads(max(1, min(cpu_count // 2, 4)))
    except Exception:
        pass


def _prepare_inputs_for_device(inputs, torch, device: str, dtype):
    prepared = {}
    for key, value in inputs.items():
        if not hasattr(value, "to"):
            prepared[key] = value
            continue
        if torch.is_tensor(value) and value.dtype.is_floating_point:
            prepared[key] = value.to(device=device, dtype=dtype)
        else:
            prepared[key] = value.to(device)
    return prepared


def _max_new_tokens_for_audio_length(num_samples: int, sample_rate: int) -> int:
    if sample_rate <= 0:
        return 160
    seconds = max(float(num_samples) / float(sample_rate), 0.0)
    estimated = int(seconds * 6.0 + 32.0)
    return max(64, min(320, estimated))


def _decode_generated(processor, outputs) -> str:
    decoded = None
    if hasattr(processor, "batch_decode"):
        decoded = processor.batch_decode(outputs, skip_special_tokens=True)
    elif hasattr(processor, "decode"):
        first = outputs[0] if hasattr(outputs, "__getitem__") else outputs
        decoded = [processor.decode(first, skip_special_tokens=True)]
    if not decoded:
        return ""
    return str(decoded[0]).strip()


def _reset_voxtral_runtime(torch_module=None):
    _VOXTRAL_RUNTIME["model_spec"] = None
    _VOXTRAL_RUNTIME["processor"] = None
    _VOXTRAL_RUNTIME["model"] = None
    _VOXTRAL_RUNTIME["device"] = None
    _VOXTRAL_RUNTIME["dtype"] = None
    if torch_module is not None:
        try:
            if torch_module.cuda.is_available():
                torch_module.cuda.empty_cache()
        except Exception:
            pass


def _load_voxtral_runtime(model_spec: str):
    import torch
    from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration

    cached_spec = _VOXTRAL_RUNTIME["model_spec"]
    cached_processor = _VOXTRAL_RUNTIME["processor"]
    cached_model = _VOXTRAL_RUNTIME["model"]
    cached_device = _VOXTRAL_RUNTIME["device"]
    cached_dtype = _VOXTRAL_RUNTIME["dtype"]
    if (
        cached_spec == model_spec
        and cached_processor is not None
        and cached_model is not None
        and cached_device is not None
        and cached_dtype is not None
    ):
        return cached_processor, cached_model, cached_device, cached_dtype, torch

    if cached_spec is not None and cached_spec != model_spec:
        _reset_voxtral_runtime(torch)

    processor = AutoProcessor.from_pretrained(model_spec, trust_remote_code=True)
    device, dtype = _choose_device_dtype(torch)
    _tune_torch_threads(torch, device)
    model_kwargs = {
        "trust_remote_code": True,
        "torch_dtype": dtype,
    }
    if device == "cuda":
        model_kwargs["device_map"] = "auto"
    model = VoxtralRealtimeForConditionalGeneration.from_pretrained(model_spec, **model_kwargs)
    if device != "cuda":
        model = model.to(device)
    model.eval()

    _VOXTRAL_RUNTIME["model_spec"] = model_spec
    _VOXTRAL_RUNTIME["processor"] = processor
    _VOXTRAL_RUNTIME["model"] = model
    _VOXTRAL_RUNTIME["device"] = device
    _VOXTRAL_RUNTIME["dtype"] = dtype
    return processor, model, device, dtype, torch


def run_probe(provider: str):
    if provider == "voxtral_local":
        import torch  # noqa: F401
        import transformers  # noqa: F401
        import soundfile  # noqa: F401
        import librosa  # noqa: F401
    if provider == "parakeet_ctc":
        import torch  # noqa: F401
        import transformers  # noqa: F401
        import soundfile  # noqa: F401
        import librosa  # noqa: F401
    if provider == "mlx_audio_stt":
        import mlx_audio.stt  # noqa: F401
        import mlx.core  # noqa: F401
    if provider == "voxtral_local":
        from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration  # noqa: F401
        from mistral_common.tokens.tokenizers.audio import Audio  # noqa: F401
        _require_transformers("5.2.0")
    if provider == "parakeet_ctc":
        from transformers import pipeline  # noqa: F401
    return {"ok": True}


def run_download(provider: str, model_dir: Path, model_id: Optional[str] = None):
    from huggingface_hub import snapshot_download

    model_dir.mkdir(parents=True, exist_ok=True)
    if provider == "voxtral_local":
        repo_id = "mistralai/Voxtral-Mini-4B-Realtime-2602"
        allow_patterns = [
            "*.json",
            "*.safetensors",
            "*.txt",
            "*.model",
            "tokenizer*",
            "processor_config.json",
            "tekken.json",
            "*.bin",
        ]
    elif provider == "parakeet_ctc":
        manifest = model_dir / "manifest.json"
        repo_id = str(model_id or "nvidia/parakeet-ctc-0.6b")
        if not repo_id.startswith("nvidia/"):
            repo_id = f"nvidia/{repo_id}"
        if manifest.exists() and not model_id:
            payload = json.loads(manifest.read_text())
            repo_id = str(payload.get("repo_id") or payload.get("model_id") or repo_id)
        allow_patterns = [
            "*.json",
            "*.safetensors",
            "*.model",
            "*.txt",
            "tokenizer*",
            "preprocessor_config.json",
            "config.json",
        ]
    elif provider == "mlx_audio_stt":
        if not model_id:
            raise ValueError("model_id is required for MLX Audio downloads")
        repo_id = str(model_id).strip()
        if repo_id == "canary-1b-v2-mlx":
            raise ValueError(
                "Canary does not have an official downloadable MLX repo yet. Convert or place a local canary-1b-v2-mlx bundle into the selected model directory."
            )
        allow_patterns = None
    else:
        raise ValueError(f"Unsupported provider for download: {provider}")

    download_kwargs = {
        "repo_id": repo_id,
        "local_dir": str(model_dir),
        "local_dir_use_symlinks": False,
    }
    if allow_patterns is not None:
        download_kwargs["allow_patterns"] = allow_patterns

    snapshot_download(**download_kwargs)

    if provider in {"parakeet_ctc", "mlx_audio_stt"}:
        manifest = model_dir / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "provider": provider,
                    "repo_id": repo_id,
                    "model_id": repo_id,
                },
                ensure_ascii=True,
                indent=2,
            )
        )

    return {"ok": True}


def _reset_mlx_audio_runtime():
    _MLX_AUDIO_RUNTIME["model_spec"] = None
    _MLX_AUDIO_RUNTIME["model"] = None


def _load_mlx_audio_model(model_spec: str):
    from mlx_audio.stt import load

    cached_spec = _MLX_AUDIO_RUNTIME["model_spec"]
    cached_model = _MLX_AUDIO_RUNTIME["model"]
    if cached_spec == model_spec and cached_model is not None:
        return cached_model

    model = load(model_spec)
    _MLX_AUDIO_RUNTIME["model_spec"] = model_spec
    _MLX_AUDIO_RUNTIME["model"] = model
    return model


def _load_parakeet_pipeline(model_spec: str):
    import torch
    from transformers import pipeline

    cached_spec = _PARAKEET_RUNTIME["model_spec"]
    cached_pipe = _PARAKEET_RUNTIME["pipe"]
    if cached_spec == model_spec and cached_pipe is not None:
        return cached_pipe

    device = 0 if torch.cuda.is_available() else -1
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    pipe = pipeline(
        "automatic-speech-recognition",
        model=model_spec,
        dtype=dtype,
        device=device,
    )
    _PARAKEET_RUNTIME["model_spec"] = model_spec
    _PARAKEET_RUNTIME["pipe"] = pipe
    return pipe


def run_transcribe_parakeet(model_spec: str, audio_path: Path):
    pipe = _load_parakeet_pipeline(model_spec)
    output = pipe(str(audio_path))
    text = _extract_text(output)
    if not text:
        raise RuntimeError("Parakeet local returned an empty transcription")
    return {
        "text": text,
        "language": "en",
        "confidence": 0.9,
    }


def _extract_text(payload):
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return str(payload).strip()

    text = payload.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()

    chunks = payload.get("chunks") or payload.get("segments")
    if isinstance(chunks, list):
        parts = []
        for chunk in chunks:
            if isinstance(chunk, dict):
                chunk_text = chunk.get("text")
                if isinstance(chunk_text, str) and chunk_text.strip():
                    parts.append(chunk_text.strip())
        joined = " ".join(parts).strip()
        if joined:
            return joined

    return ""


def _load_audio_array(audio_path: Path, target_sr: int):
    import librosa
    import numpy as np
    import soundfile as sf

    audio, sr = sf.read(str(audio_path), always_2d=False)
    if getattr(audio, "ndim", 1) > 1:
        audio = np.mean(audio, axis=1)
    if sr != target_sr:
        audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=target_sr)
        sr = target_sr
    return audio, sr


def _generate_voxtral_text(processor, model, torch, device: str, dtype, audio_array, target_sr: int):
    max_new_tokens = _max_new_tokens_for_audio_length(len(audio_array), target_sr)
    inputs = processor(audio_array, sampling_rate=target_sr, return_tensors="pt")
    prepared_inputs = _prepare_inputs_for_device(inputs, torch, device, dtype)
    with torch.inference_mode():
        outputs = model.generate(
            **prepared_inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            temperature=0.0,
        )
    return _decode_generated(processor, outputs)


def run_transcribe_voxtral(model_spec: str, audio_path: Path):
    from mistral_common.tokens.tokenizers.audio import Audio

    _require_transformers("5.2.0")

    processor, model, device, dtype, torch = _load_voxtral_runtime(model_spec)
    target_sr = getattr(getattr(processor, "feature_extractor", None), "sampling_rate", 16000)
    audio = Audio.from_file(str(audio_path), strict=False)
    audio.resample(target_sr)
    audio_array = audio.audio_array
    try:
        text = _generate_voxtral_text(
            processor, model, torch, device, dtype, audio_array, target_sr
        )
    except Exception:
        _reset_voxtral_runtime(torch)
        raise

    if not text:
        # Some long utterances can decode to empty in a single pass.
        # Retry with smaller windows and concatenate non-empty chunks.
        chunk_samples = max(target_sr * 12, target_sr)
        parts = []
        for start in range(0, len(audio_array), chunk_samples):
            chunk = audio_array[start : start + chunk_samples]
            if len(chunk) < target_sr:
                continue
            try:
                chunk_text = _generate_voxtral_text(
                    processor, model, torch, device, dtype, chunk, target_sr
                )
            except Exception:
                _reset_voxtral_runtime(torch)
                raise
            if chunk_text:
                parts.append(chunk_text.strip())
        text = " ".join(parts).strip()

    if not text:
        raise RuntimeError("Voxtral local returned an empty transcription")
    return {
        "text": text,
        "language": "auto",
        "confidence": 0.9,
    }


def _result_text(payload) -> str:
    if payload is None:
        return ""
    text = getattr(payload, "text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()
    if isinstance(payload, str):
        return payload.strip()
    if isinstance(payload, dict):
        candidate = payload.get("text")
        if isinstance(candidate, str):
            return candidate.strip()
    return str(payload).strip()


def _result_language(payload) -> str:
    language = getattr(payload, "language", None)
    if isinstance(language, str) and language.strip():
        return language.strip()
    if isinstance(payload, dict):
        candidate = payload.get("language")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return "auto"


def _result_confidence(payload) -> float:
    confidence = getattr(payload, "confidence", None)
    if isinstance(confidence, (int, float)):
        return float(confidence)
    if isinstance(payload, dict):
        candidate = payload.get("confidence")
        if isinstance(candidate, (int, float)):
            return float(candidate)
    return 0.9


def run_transcribe_mlx_audio(model_spec: str, audio_path: Path):
    model = _load_mlx_audio_model(model_spec)
    try:
        result = model.generate(str(audio_path), verbose=False, generation_stream=False)
    except Exception:
        _reset_mlx_audio_runtime()
        raise

    text = _result_text(result)
    if not text:
        raise RuntimeError("MLX Audio returned an empty transcription")

    return {
        "text": text,
        "language": _result_language(result),
        "confidence": _result_confidence(result),
    }


def run_transcribe(provider: str, model_dir: Path, audio_path: Path):
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    model_spec = model_spec_for(provider, model_dir)
    if provider == "voxtral_local":
        result = run_transcribe_voxtral(model_spec, audio_path)
    elif provider == "parakeet_ctc":
        result = run_transcribe_parakeet(model_spec, audio_path)
    elif provider == "mlx_audio_stt":
        result = run_transcribe_mlx_audio(model_spec, audio_path)
    else:
        raise ValueError(f"Unsupported provider for transcription: {provider}")

    return {
        "ok": True,
        "text": result["text"],
        "language": result.get("language", "auto"),
        "confidence": result.get("confidence", 0.9),
    }


def run_serve(provider: str):
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue

        try:
            request = json.loads(raw)
        except Exception:
            emit_line({"ok": False, "error": "Invalid JSON request"})
            continue

        action = str(request.get("action", "")).strip()
        model_dir_value = request.get("model_dir")
        audio_path_value = request.get("audio_path")
        model_id_value = request.get("model_id")

        try:
            if action == "probe":
                emit_line(run_probe(provider))
                continue

            if not model_dir_value:
                raise ValueError("'model_dir' is required")
            model_dir = Path(str(model_dir_value)).expanduser().resolve()

            if action == "download":
                emit_line(run_download(provider, model_dir, str(model_id_value) if model_id_value else None))
                continue

            if action == "transcribe":
                if not audio_path_value:
                    raise ValueError("'audio_path' is required for transcribe action")
                audio_path = Path(str(audio_path_value)).expanduser().resolve()
                emit_line(run_transcribe(provider, model_dir, audio_path))
                continue

            raise ValueError(f"Unsupported action: {action}")
        except Exception as exc:  # noqa: BLE001
            emit_line({"ok": False, "error": str(exc)})


def main():
    parser = argparse.ArgumentParser(description="Nautilus Python ASR runner")
    parser.add_argument("--provider", required=True)
    parser.add_argument(
        "--action",
        required=True,
        choices=["probe", "download", "transcribe", "serve"],
    )
    parser.add_argument("--model-dir")
    parser.add_argument("--audio-path")
    parser.add_argument("--model-id")
    args = parser.parse_args()

    provider = args.provider.strip()
    action = args.action.strip()

    try:
        if action == "serve":
            run_serve(provider)
            return

        if action == "probe":
            emit(run_probe(provider))
            return

        if not args.model_dir:
            raise ValueError("--model-dir is required for this action")
        model_dir = Path(args.model_dir).expanduser().resolve()

        if action == "download":
            emit(run_download(provider, model_dir, args.model_id))
            return

        if action == "transcribe":
            if not args.audio_path:
                raise ValueError("--audio-path is required for transcribe action")
            audio_path = Path(args.audio_path).expanduser().resolve()
            emit(run_transcribe(provider, model_dir, audio_path))
            return

        raise ValueError(f"Unsupported action: {action}")
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
