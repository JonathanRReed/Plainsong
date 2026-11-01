#!/usr/bin/env python3
"""Score complete, paired stop-to-local-text receipts. Reject errors and omissions."""
import argparse
import json
from pathlib import Path


def percentile(values, quantile):
    ordered = sorted(values)
    index = (len(ordered) - 1) * quantile
    lower = int(index)
    return ordered[lower] + (ordered[min(lower + 1, len(ordered) - 1)] - ordered[lower]) * (index - lower)


def score(manifest, receipt, process_exit_code=0):
    clips = json.loads(manifest.read_text())
    rows = [json.loads(line) for line in receipt.read_text().splitlines() if line.strip()]
    pairs = {}
    errors = [row for row in rows if row.get("error")]
    for row in rows:
        key = (row["clip"], row["aside"])
        if key in pairs:
            raise ValueError(f"Duplicate arm: {key}")
        pairs[key] = row
    expected = {(clip, aside) for clip in clips for aside in [False, True]}
    if set(pairs) != expected or errors:
        return dict(status="blocked", expectedArms=len(expected), completedArms=len(rows), errors=errors)
    mismatches = [clip for clip in clips if pairs[(clip, False)]["text"] != pairs[(clip, True)]["text"]]
    stats = {}
    for aside, name in [(False, "standalone"), (True, "aside")]:
        values = [pairs[(clip, aside)]["stopToLocalTextMs"] for clip in clips]
        stats[name] = {f"p{q}": percentile(values, q / 100) for q in [50, 90, 95]}
    difference = stats["aside"]["p95"] - stats["standalone"]["p95"]
    limit = max(20, stats["standalone"]["p95"] * 0.05)
    return dict(status="pass" if difference <= limit and not mismatches and process_exit_code == 0 else "fail", processExitCode=process_exit_code, clips=len(clips), errors=0, textMismatches=mismatches, **stats, p95DifferenceMs=difference, allowedDifferenceMs=limit, scope="capture tail, WAV encode, aside journal, checkpoint, ASR and local formatting; excludes Electron delivery and optional AI formatting")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    args = parser.parse_args()
    result = score(args.manifest, args.receipt, args.exit_code)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
