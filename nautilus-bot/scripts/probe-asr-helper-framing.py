#!/usr/bin/env python3
"""Exercise the rh/ane reader without building FluidAudio or loading a model."""

import argparse
import pathlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("worktree", type=pathlib.Path)
parser.add_argument("--revision", default="HEAD")
parser.add_argument("--working-copy", action="store_true")
args = parser.parse_args()
relative = "nautilus-bot/rust-sidecar/native/asr_helper/Sources/PlainsongAsrHelper/main.swift"
source = (args.worktree / relative).read_text() if args.working_copy else subprocess.check_output(
    ["git", "-C", str(args.worktree), "show", f"{args.revision}:{relative}"], text=True
)
reader = source[source.index("final class StdinReader {"):source.index("func writeResponse(")]
program = '''import Foundation
import Darwin
let maxLineBytes = 64 * 1024
struct HelperError: Error {
    init(_ code: String, _ message: String) {}
}
''' + reader + '''
do {
    let line = try StdinReader().readLine()
    print("accepted=\\(line?.utf8.count ?? 0) limit=\\(maxLineBytes)")
} catch {
    print("rejected")
}
'''
with tempfile.TemporaryDirectory(prefix="asr-framing-") as temporary:
    directory = pathlib.Path(temporary)
    swift = directory / "probe.swift"
    executable = directory / "probe"
    swift.write_text(program)
    subprocess.run(["xcrun", "swiftc", str(swift), "-o", str(executable)], check=True)
    for count in [65536, 65537]:
        fixture = directory / "request.txt"
        prefix, suffix = b'{"op":"hello","padding":"', b'"}'
        fixture.write_bytes(prefix + b"x" * (count - len(prefix) - len(suffix)) + suffix + b"\n")
        with fixture.open("rb") as stream:
            result = subprocess.run(
                [str(executable)], stdin=stream, capture_output=True, check=True
            )
        print(result.stdout.decode().strip())
        expected = "rejected" if args.working_copy and count > 65536 else f"accepted={count}"
        assert expected in result.stdout.decode(), "reader behavior changed; re-review"
