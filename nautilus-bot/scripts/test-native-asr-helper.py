#!/usr/bin/env python3
"""Exercise the built helper's framing without loading any model."""
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest

HELPER = sys.argv.pop(1) if len(sys.argv) > 1 else "dist-native/plainsong-native-asr-helper"


class ProtocolTests(unittest.TestCase):
    def run_frame(self, data):
        result = subprocess.run([HELPER], input=data, capture_output=True, timeout=5)
        return result.returncode, [json.loads(line) for line in result.stdout.splitlines()]

    def test_multiple_requests_share_one_pipe(self):
        code, rows = self.run_frame(b'{"op":"hello"}\n{"op":"unload"}\n')
        self.assertEqual(code, 0)
        self.assertEqual([row["op"] for row in rows], ["hello", "unload"])
        self.assertTrue(all(row["ok"] for row in rows))

    def test_hello_reports_protocol_3(self):
        code, rows = self.run_frame(b'{"op":"hello"}\n')
        self.assertEqual(code, 0)
        self.assertEqual(rows[0]["protocolVersion"], 3)
        self.assertEqual(rows[0]["engine"], "fluidaudio")

    def test_unknown_compute_units_are_rejected_before_the_model_is_touched(self):
        with tempfile.TemporaryDirectory(prefix="plainsong-asr-protocol-") as directory:
            for units in ("gpu", "ane", "cpu", ""):
                frame = json.dumps(
                    dict(op="load", modelDir=directory, family="v3", computeUnits=units)
                ).encode() + b"\n"
                code, rows = self.run_frame(frame)
                self.assertEqual(code, 0)
                self.assertFalse(rows[0]["ok"], units)
                self.assertEqual(rows[0]["code"], "bad_request", units)
                self.assertIn("compute units", rows[0]["message"])

    def test_a_load_without_compute_units_reaches_the_model_check(self):
        # Version 2 sidecars never sent computeUnits; the default
        # (cpuAndNeuralEngine) keeps them working, so the request fails only
        # later, on the unverified optional graph in the model folder.
        with tempfile.TemporaryDirectory(prefix="plainsong-asr-protocol-") as directory:
            Path(directory, "CtcHead.mlmodelc").mkdir()
            frame = json.dumps(dict(op="load", modelDir=directory, family="v3")).encode() + b"\n"
            code, rows = self.run_frame(frame)
            self.assertEqual(code, 0)
            self.assertEqual(rows[0]["code"], "unverified_component")

    def test_oversized_header_is_rejected_with_or_without_newline(self):
        for suffix in (b'"}\n', b''):
            code, rows = self.run_frame(b'{"op":"hello","padding":"' + b'x' * 300000 + suffix)
            self.assertEqual(code, 65)
            self.assertFalse(rows[0]["ok"])

    def test_malformed_headers_fail_closed(self):
        for frame in (b'[]\n', b'{\n', b'{"op":"hello","x":"\xff"}\n'):
            code, rows = self.run_frame(frame)
            self.assertEqual(code, 65)
            self.assertFalse(rows[0]["ok"])

    def test_unverified_optional_graphs_are_not_loaded(self):
        with tempfile.TemporaryDirectory(prefix="plainsong-asr-protocol-") as directory:
            Path(directory, "CtcHead.mlmodelc").mkdir()
            frame = json.dumps(dict(op="load", modelDir=directory, family="v3")).encode() + b"\n"
            code, rows = self.run_frame(frame)
            self.assertEqual(code, 0)
            self.assertEqual(rows[0]["code"], "unverified_component")

    def test_invalid_sample_counts_cannot_desynchronize_the_pipe(self):
        for count in (-1, True, 1.5, 115200001, "2"):
            code, rows = self.run_frame(json.dumps({"op": "transcribe", "sampleCount": count}).encode() + b'\n')
            self.assertEqual(code, 65)
            self.assertFalse(rows[0]["ok"])

    def test_nonfinite_audio_is_rejected_before_inference(self):
        for sample in (float("nan"), float("inf"), -float("inf")):
            code, rows = self.run_frame(b'{"op":"transcribe","sampleCount":1}\n' + struct.pack("<f", sample))
            self.assertEqual(code, 0)
            self.assertEqual(rows[0]["code"], "bad_audio")

    def test_binary_newlines_do_not_become_headers(self):
        code, rows = self.run_frame(b'{"op":"transcribe","sampleCount":1}\n' + b'\n\0\0\0' + b'{"op":"hello"}\n')
        self.assertEqual(code, 0)
        self.assertEqual(rows[0]["code"], "not_loaded")
        self.assertEqual(rows[1]["op"], "hello")

    def test_truncated_payload_exits_without_reusing_the_frame(self):
        code, rows = self.run_frame(b'{"op":"transcribe","sampleCount":4}\n\0')
        self.assertEqual(code, 0)
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
