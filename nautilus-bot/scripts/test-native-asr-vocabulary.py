#!/usr/bin/env python3
"""Test the helper's production scoring code without models or XCTest."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent / "rust-sidecar/native/asr_helper"
with tempfile.TemporaryDirectory(prefix="plainsong-vocabulary-tests-") as directory:
    binary = str(Path(directory) / "vocabulary-tests")
    subprocess.run([
        "swiftc", "-O", "-num-threads", "4",
        str(root / "Sources/PlainsongAsrHelper/VocabularyScoring.swift"),
        str(root / "Tests/VocabularyScoring/main.swift"), "-o", binary,
    ], check=True)
    subprocess.run([binary], check=True)
