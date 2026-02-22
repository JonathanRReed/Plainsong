#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


def emit_line(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
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


def run_probe(provider: str):
    if provider in {"vibevoice", "voxtral_local"}:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        import soundfile  # noqa: F401
        import librosa  # noqa: F401
    if provider == "vibevoice":
        import sentencepiece  # noqa: F401
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor  # noqa: F401
        _require_transformers("4.57.6")
    if provider == "voxtral_local":
        from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration  # noqa: F401
        from mistral_common.tokens.tokenizers.audio import Audio  # noqa: F401
        _require_transformers("5.2.0")
    return {"ok": True}


def run_download(provider: str, model_dir: Path):
    from huggingface_hub import snapshot_download

    model_dir.mkdir(parents=True, exist_ok=True)
    if provider == "vibevoice":
        repo_id = "microsoft/VibeVoice-ASR"
        allow_patterns = [
            "*.json",
            "*.safetensors",
            "*.txt",
            "*.model",
            "*.py",
            "tokenizer*",
            "processor_config.json",
            "*.bin",
        ]
    elif provider == "voxtral_local":
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
    else:
        raise ValueError(f"Unsupported provider for download: {provider}")

    snapshot_download(
        repo_id=repo_id,
        local_dir=str(model_dir),
        local_dir_use_symlinks=False,
        allow_patterns=allow_patterns,
    )
    return {"ok": True}


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


def run_transcribe_vibevoice(model_spec: str, audio_path: Path):
    import torch
    from transformers import AutoModelForCausalLM, AutoModelForSpeechSeq2Seq, AutoProcessor

    _require_transformers("4.57.6")

    pipeline_error = None
    try:
        from transformers import pipeline

        pipe = pipeline(
            task="automatic-speech-recognition",
            model=model_spec,
            trust_remote_code=True,
        )
        result = pipe(str(audio_path))
        text = _extract_text(result)
        if text:
            return {
                "text": text,
                "language": result.get("language") if isinstance(result, dict) else "auto",
                "confidence": 0.9,
            }
        pipeline_error = "pipeline returned empty transcription"
    except Exception as exc:  # noqa: BLE001
        pipeline_error = str(exc)

    processor = AutoProcessor.from_pretrained(model_spec, trust_remote_code=True)
    target_sr = getattr(getattr(processor, "feature_extractor", None), "sampling_rate", 16000)
    audio, _ = _load_audio_array(audio_path, target_sr)
    max_new_tokens = _max_new_tokens_for_audio_length(len(audio), target_sr)
    device, dtype = _choose_device_dtype(torch)
    _tune_torch_threads(torch, device)

    model = None
    model_errors = []
    for model_cls in (AutoModelForSpeechSeq2Seq, AutoModelForCausalLM):
        try:
            model = model_cls.from_pretrained(
                model_spec,
                trust_remote_code=True,
                torch_dtype=dtype,
            )
            break
        except Exception as exc:  # noqa: BLE001
            model_errors.append(f"{model_cls.__name__}: {exc}")

    if model is None:
        errors = "; ".join(model_errors) if model_errors else "unknown model load failure"
        raise RuntimeError(f"VibeVoice model loading failed ({errors})")

    if hasattr(model, "to"):
        model = model.to(device)
    model.eval()

    input_errors = []
    inputs = None
    builders = (
        lambda: processor(
            audio=audio,
            sampling_rate=target_sr,
            return_tensors="pt",
            padding=True,
            add_generation_prompt=True,
        ),
        lambda: processor(
            audio=audio,
            sampling_rate=target_sr,
            return_tensors="pt",
        ),
        lambda: processor(
            audio,
            sampling_rate=target_sr,
            return_tensors="pt",
        ),
    )
    for builder in builders:
        try:
            inputs = builder()
            break
        except Exception as exc:  # noqa: BLE001
            input_errors.append(str(exc))

    if inputs is None:
        raise RuntimeError(
            "VibeVoice input preparation failed: "
            + ("; ".join(input_errors) if input_errors else "unknown error")
        )

    prepared_inputs = _prepare_inputs_for_device(inputs, torch, device, dtype)
    with torch.inference_mode():
        outputs = model.generate(
            **prepared_inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
        )
    text = _decode_generated(processor, outputs)

    if not text:
        details = f"pipeline error: {pipeline_error}" if pipeline_error else "empty decoder output"
        raise RuntimeError(f"VibeVoice returned an empty transcription ({details})")
    return {
        "text": text,
        "language": "auto",
        "confidence": 0.9,
    }


def run_transcribe_voxtral(model_spec: str, audio_path: Path):
    import torch
    from mistral_common.tokens.tokenizers.audio import Audio
    from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration

    _require_transformers("5.2.0")

    processor = AutoProcessor.from_pretrained(model_spec, trust_remote_code=True)
    target_sr = getattr(getattr(processor, "feature_extractor", None), "sampling_rate", 16000)
    audio = Audio.from_file(str(audio_path), strict=False)
    audio.resample(target_sr)
    audio_array = audio.audio_array
    max_new_tokens = _max_new_tokens_for_audio_length(len(audio_array), target_sr)

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

    inputs = processor(audio_array, sampling_rate=target_sr, return_tensors="pt")
    prepared_inputs = _prepare_inputs_for_device(inputs, torch, device, dtype)

    with torch.inference_mode():
        outputs = model.generate(
            **prepared_inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            temperature=0.0,
        )

    text = _decode_generated(processor, outputs)
    if not text:
        raise RuntimeError("Voxtral local returned an empty transcription")
    return {
        "text": text,
        "language": "auto",
        "confidence": 0.9,
    }


def run_transcribe(provider: str, model_dir: Path, audio_path: Path):
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    model_spec = model_spec_for(provider, model_dir)
    if provider == "vibevoice":
        result = run_transcribe_vibevoice(model_spec, audio_path)
    elif provider == "voxtral_local":
        result = run_transcribe_voxtral(model_spec, audio_path)
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

        try:
            if action == "probe":
                emit_line(run_probe(provider))
                continue

            if not model_dir_value:
                raise ValueError("'model_dir' is required")
            model_dir = Path(str(model_dir_value)).expanduser().resolve()

            if action == "download":
                emit_line(run_download(provider, model_dir))
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
            emit(run_download(provider, model_dir))
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
