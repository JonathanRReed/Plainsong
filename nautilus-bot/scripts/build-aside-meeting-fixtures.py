#!/usr/bin/env python3
"""Build paired meeting fixtures from an existing, hash-pinned speech manifest.

No downloads, speech synthesis, devices, or playback. The twin has silence in
place of each aside, so both arms have exactly the same meeting timeline.
"""
import argparse
import array
import hashlib
import json
import re
import struct
import wave
from pathlib import Path


def samples(clip):
    raw = Path(clip["wav"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == clip["sha256"], clip["clip"]
    assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
    offset, fmt, data = 12, None, None
    while offset + 8 <= len(raw):
        name, length = struct.unpack_from("<4sI", raw, offset)
        block = raw[offset + 8:offset + 8 + length]
        if name == b"fmt ":
            fmt = struct.unpack_from("<HHIIHH", block)
        if name == b"data":
            data = block
        offset += 8 + length + length % 2
    encoding, channels, rate, _, _, bits = fmt
    assert channels == 1 and rate == 48000, clip["clip"]
    if encoding == 3 and bits == 32:
        return list(array.array("f", data))
    assert encoding == 1 and bits == 16
    return [value / 32768 for value in array.array("h", data)]


def write(path, values):
    pcm = array.array("h", (round(max(-1, min(1, v)) * 32767) for v in values))
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
        output.writeframes(pcm.tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    clips = [c for c in json.loads(args.manifest.read_text())["clips"] if c["source"] == "synthetic-say" and c["sampleRate"] == 48000]
    tokens = lambda text: set(re.findall(r"[a-z]+", text.lower()))
    cache = {c["clip"]: samples(c) for c in clips}
    fixtures = []
    for index in range(20):
        me, them = clips[index % len(clips)], clips[(index + 1) % len(clips)]
        candidates = [c for c in clips if len(tokens(c["verbatim"]) - tokens(me["verbatim"] + " " + them["verbatim"])) >= 3]
        chosen = [candidates[(index + j) % len(candidates)] for j in range(1 + index % 3)]
        mic = [0.0] * 24000 + cache[me["clip"]] + [0.0] * 48000
        spans = []
        if index == 18:
            mic += [0.0] * max(0, 89 * 48000 - len(mic))
        for number, clip in enumerate(chosen):
            start = len(mic)
            mic += cache[clip["clip"]]
            spans.append(dict(asideId=f"fixture-{index}-{number}", dictationSessionId=number + 1, sampleRate=48000, startFrame=start, endFrame=len(mic), startedAtMs=0, endedAtMs=1, pausedFrames=0))
            if index != 19:
                mic += [0.0] * 48000
        if index != 19:
            mic += cache[me["clip"]] + [0.0] * 24000
        system = [0.0] * len(mic)
        system_start = len(cache[me["clip"]]) + 48000
        far = cache[them["clip"]]
        system[system_start:system_start + min(len(far), len(system) - system_start)] = far[:max(0, len(system) - system_start)]
        baseline = mic.copy()
        for span in spans:
            baseline[span["startFrame"]:span["endFrame"]] = [0.0] * (span["endFrame"] - span["startFrame"])
        directory = args.out / f"meeting-{index:02}"
        directory.mkdir()
        # The combined track already excludes the mic during asides, as capture does.
        mixed = [0.5 * (a + b) for a, b in zip(baseline, system)]
        for name, audio in [("mic", mic), ("baseline", baseline), ("system", system), ("mixed", mixed)]:
            write(directory / f"{name}.wav", audio)
        (directory / "asides.json").write_text(json.dumps(spans, indent=2) + "\n")
        canaries = sorted(set.union(*(tokens(c["verbatim"]) for c in chosen)) - tokens(me["verbatim"] + " " + them["verbatim"]))
        fixtures.append(dict(id=directory.name, directory=str(directory.resolve()), canaries=canaries, meReference=me["verbatim"] * 1 if index == 19 else me["verbatim"] + " " + me["verbatim"], sourceClips=[me["clip"], them["clip"], *[c["clip"] for c in chosen]], sourceHashes=[c["sha256"] for c in [me, them, *chosen]], micOnly=index % 2 == 0))
    (args.out / "manifest.json").write_text(json.dumps(dict(fixtures=fixtures, sourceManifest=str(args.manifest.resolve()), coverage=["1-3 asides", "mic-only and Me + Them", "90-second boundary", "aside at track end"]), indent=2) + "\n")


if __name__ == "__main__":
    main()
