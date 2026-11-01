#!/usr/bin/env python3
"""Measure helper latency and system memory; run through build-slot.sh."""
import argparse
import hashlib
import json
import pathlib
import platform
import re
import signal
import statistics
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--helper', required=True)
parser.add_argument('--model-dir', required=True)
parser.add_argument('--family', choices=['v2', 'v3'], required=True)
parser.add_argument('--encoder', default='int8-v2')
parser.add_argument('--audio', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--cycles', type=int, default=3)
args = parser.parse_args()
audio = subprocess.check_output(['ffmpeg', '-nostdin', '-v', 'error', '-i', args.audio,
                                 '-t', '10', '-ar', '16000', '-ac', '1', '-f', 'f32le', '-'])
assert len(audio) == 10 * 16000 * 4, 'Use a fixture at least ten seconds long'


def snapshot():
    raw = subprocess.check_output(['vm_stat'], text=True)
    page = int(re.search(r'page size of (\d+)', raw)[1])
    pages = {k: int(v) for k, v in re.findall(r'^([^:\n]+):\s+(\d+)', raw, re.M)}
    # Same estimate used by the app's measured_available_memory().
    available = sum(pages[k] for k in ('Pages free', 'Pages inactive', 'Pages speculative')) * page
    pressure = subprocess.check_output(['memory_pressure', '-Q'], text=True)
    return dict(availableBytes=available, wiredBytes=pages['Pages wired down'] * page,
                compressorBytes=pages['Pages occupied by compressor'] * page,
                freePercent=int(re.search(r'(\d+)%', pressure)[1]), vmStat=raw)


def timed_out(_signal, _frame):
    raise TimeoutError("Speech helper request timed out")


signal.signal(signal.SIGALRM, timed_out)
runs = []
for cycle in range(args.cycles):
    before = snapshot()
    child = subprocess.Popen([args.helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    def call(request, payload=b''):
        signal.setitimer(signal.ITIMER_REAL, 240 if request['op'] == 'load' else 20)
        try:
            child.stdin.write(json.dumps(request).encode() + b'\n' + payload)
            child.stdin.flush()
            row = json.loads(child.stdout.readline())
            if not row.get('ok'):
                raise RuntimeError(row)
            return row
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    try:
        hello = call(dict(op='hello'))
        started = time.perf_counter()
        loaded = call(dict(op='load', modelDir=args.model_dir, family=args.family, encoder=args.encoder))
        load_ms = (time.perf_counter() - started) * 1000
        latencies = []
        word_counts = []
        for _ in range(10):
            started = time.perf_counter()
            result = call(dict(op='transcribe', sampleCount=len(audio) // 4), audio)
            latencies.append((time.perf_counter() - started) * 1000)
            words = result['words']
            assert ' '.join(word['text'] for word in words).split() == result['text'].split()
            assert all(word['startMs'] >= 0 and word['endMs'] >= word['startMs'] for word in words)
            word_counts.append(len(words))
        footprint = call(dict(op='footprint'))['physFootprintBytes']
        during = snapshot()
        call(dict(op='unload'))
        unloaded = call(dict(op='footprint'))['physFootprintBytes']
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    after = snapshot()
    runs.append(dict(cycle=cycle, hello=hello, loadMs=load_ms, decode10sWallMs=latencies,
                     helperFootprintBytes=footprint, unloadedHelperFootprintBytes=unloaded,
                     wordCounts=word_counts, before=before, during=during, after=after,
                     availableDeltaBytes=during['availableBytes']-before['availableBytes'],
                     wiredDeltaBytes=during['wiredBytes']-before['wiredBytes']))
all_ms = sorted(ms for run in runs for ms in run['decode10sWallMs'])
report = dict(scope='helper stdio roundtrip only; excludes capture tail, audio finalization and text pipeline',
              machine=platform.platform(), helperSha256=hashlib.file_digest(open(args.helper, 'rb'), 'sha256').hexdigest(),
              audioSha256=hashlib.file_digest(open(args.audio, 'rb'), 'sha256').hexdigest(),
              family=args.family, encoder=args.encoder, runs=runs,
              p50Ms=statistics.median(all_ms), p95Ms=all_ms[max(0, int(len(all_ms)*.95+.999)-1)],
              maxFootprintBytes=max(run['helperFootprintBytes'] for run in runs),
              caveat='Shared host. System memory deltas include other applications and are not an isolated ANE allocation measurement.')
pathlib.Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: report[key] for key in ('p50Ms', 'p95Ms', 'maxFootprintBytes')}))
