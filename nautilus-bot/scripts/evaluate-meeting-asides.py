#!/usr/bin/env python3
"""Run paired meeting-eval leak/WER checks in an isolated profile.

Native admission remains authoritative. A refused model load stops this run;
it never becomes a zero-leak or latency pass.
"""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path


def words(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def edit_distance(reference, hypothesis):
    previous = list(range(len(hypothesis) + 1))
    for i, left in enumerate(reference, 1):
        row = [i]
        for j, right in enumerate(hypothesis, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (left != right)))
        previous = row
    return previous[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--build-slot", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--provider", default="whisper")
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--reuse-reports", action="store_true", help="Rescore existing reports for the same frozen fixtures without loading a model")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PLAINSONG_DATA_DIR=str(args.profile.resolve() / "data"), PLAINSONG_CONFIG_DIR=str(args.profile.resolve() / "config"), CARGO_BUILD_JOBS="4", RUST_LOG="warn")
    results = []
    summary = {"status": "running", "provider": args.provider, "model": args.model, "fixtures": results}
    summary_path = args.out / "kill-criteria.json"

    def save():
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    for fixture in json.loads(args.fixtures.read_text())["fixtures"]:
        directory = Path(fixture["directory"])
        pair = {}
        for aside in [False, True]:
            label = fixture["id"] + ("-aside" if aside else "-baseline")
            report = args.out / f"{label}.json"
            command = [str(args.build_slot), "nice", "-n", "10", "env", "CARGO_BUILD_JOBS=4", "bun", "scripts/cargo-sidecar.ts", "run", "--locked", "--bin", "meeting-eval", "--", "--provider", args.provider, "--model", args.model, "--no-diarization", "--out", str(report.resolve())]
            if not fixture["micOnly"]:
                command += ["--mic", str(directory / ("mic.wav" if aside else "baseline.wav")), "--system", str(directory / "system.wav")]
            if aside:
                command += ["--asides", str(directory / "asides.json"), "--canaries", ",".join(fixture["canaries"])]
            command += [str(directory / ("mic.wav" if aside else "baseline.wav")) if fixture["micOnly"] else str(directory / "mixed.wav")]
            log_path = args.out / f"{label}.log"
            if args.reuse_reports:
                if not report.exists():
                    raise FileNotFoundError(report)
                return_code = 0
            else:
                with log_path.open("w") as log:
                    result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=False)
                return_code = result.returncode
            if return_code:
                summary.update(status="blocked", failedCommand=command, exitCode=return_code, log=str(log_path))
                save()
                return 2
            data = json.loads(report.read_text())
            # A partial or deferred decode is not a successful evaluation.
            if data.get("fallbackReason"):
                summary.update(status="blocked", failure=data["fallbackReason"], log=str(log_path))
                save()
                return 2
            assert data["modelId"] == args.model
            spans = json.loads((directory / "asides.json").read_text())
            if aside:
                assert data["asides"]["spans"] == spans
            # Score the same outside-aside region in both arms. The silent twin
            # can hallucinate inside its gaps; those words are outside this WER claim.
            def outside(row):
                return not any(row["start"] >= span["startFrame"] / span["sampleRate"]
                               and row["end"] <= span["endFrame"] / span["sampleRate"] for span in spans)
            text = " ".join(row["text"] for row in data["segments"] if (fixture["micOnly"] or row.get("speaker") == "me") and outside(row))
            pair["aside" if aside else "baseline"] = dict(errors=edit_distance(words(fixture["meReference"]), words(text)), words=len(words(fixture["meReference"])), report=str(report), leaks=data.get("asides"))
        leaks = pair["aside"]["leaks"]
        pair["zeroLeak"] = bool(leaks) and not leaks["transcriptCanaryHits"] and not leaks["notesInputCanaryHits"] and not leaks["searchCanaryHits"]
        pair["asideHeard"] = bool(leaks and leaks["asideCanaryHits"])
        pair["id"] = fixture["id"]
        results.append(pair)
        save()
    denominator = sum(pair["baseline"]["words"] for pair in results)
    baseline = 100 * sum(pair["baseline"]["errors"] for pair in results) / denominator
    aside = 100 * sum(pair["aside"]["errors"] for pair in results) / denominator
    summary.update(status="pass" if abs(aside - baseline) <= 1 and all(pair["zeroLeak"] and pair["asideHeard"] for pair in results) else "fail", baselineWer=baseline, asideWer=aside, werDifferencePoints=aside - baseline, latency="not measured by this script", search="real stored-transcript FTS queries in every aside arm")
    save()
    return 0 if summary["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
