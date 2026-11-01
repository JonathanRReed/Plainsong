#!/usr/bin/env python3
"""Evaluate one fictional meeting through an isolated, real sidecar process.
Run under realistic-hardware/build-slot.sh. No live profile or keychain is used.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time

APP = Path(__file__).resolve().parents[1]
RECEIPTS = APP / 'artifacts/continuation-2026-10-20/opus-loop/realistic-hardware/notes'
FIXTURES = json.loads((APP / 'docs/evals/meeting-notes-fixtures.json').read_text())['meetings']

# Darwin sys/resource.h, rusage_info_v4: UUID followed by 35 uint64_t fields.
class Usage(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16), ('values', ctypes.c_uint64 * 35)]

LIB = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True) if sys.platform == 'darwin' else None
if LIB:
    LIB.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    LIB.proc_pid_rusage.restype = ctypes.c_int
    LIB.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    LIB.proc_listchildpids.restype = ctypes.c_int
    LIB.proc_name.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    LIB.proc_name.restype = ctypes.c_int


def usage(pid):
    result = Usage()
    if LIB.proc_pid_rusage(pid, 4, ctypes.byref(result)) != 0:
        return None
    return {'footprint': result.values[7], 'lifetimePeak': result.values[28],
            'resident': result.values[6], 'started': result.values[8]}


def children(pid):
    values = (ctypes.c_int * 128)()
    size = LIB.proc_listchildpids(pid, values, ctypes.sizeof(values))
    return list(values)[:max(0, min(size, len(values)))]


def process_name(pid):
    value = ctypes.create_string_buffer(1024)
    if LIB.proc_name(pid, value, len(value)) <= 0:
        return ''
    return value.value.decode('utf-8', errors='replace')


class Sampler:
    def __init__(self, pid):
        self.pid = pid
        self.stop = threading.Event()
        self.samples = []
        self.known_helpers = {}
        self.parent_peak = 0
        self.sum_peak = 0
        self.helper_peak = 0
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            parent = usage(self.pid)
            if parent:
                self.parent_peak = max(self.parent_peak, parent['lifetimePeak'])
                total = parent['footprint']
                pending = list(children(self.pid))
                seen = set()
                while pending:
                    pid = pending.pop()
                    if pid in seen:
                        continue
                    seen.add(pid)
                    item = usage(pid)
                    if item:
                        total += item['footprint']
                        name = process_name(pid)
                        if name.startswith('plainsong-text'):
                            self.known_helpers[pid] = item['started']
                            self.helper_peak = max(self.helper_peak, item['lifetimePeak'])
                        pending.extend(children(pid))
                self.sum_peak = max(self.sum_peak, total)
                self.samples.append([time.monotonic(), parent['footprint'], total])
            self.stop.wait(0.05)

    def finish(self):
        self.stop.set()
        self.thread.join()


class Sidecar:
    def __init__(self, binary, env, fixture, events_file=None):
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding='utf-8', env=env)
        self.responses = queue.Queue()
        self.ready = threading.Event()
        self.events = []
        self.startup_errors = []
        self.fixture = fixture
        self.events_file = events_file
        self.event_log_error = None
        self.serial = 0
        self.stdout_reader = threading.Thread(target=self.read_stdout, daemon=True)
        self.stderr_reader = threading.Thread(target=self.read_stderr, daemon=True)
        self.stdout_reader.start()
        self.stderr_reader.start()
        deadline = time.monotonic() + 90
        while not self.ready.wait(0.1) and self.process.poll() is None and time.monotonic() < deadline:
            pass
        if not self.ready.is_set():
            self.close()
            raise RuntimeError('Sidecar did not become ready: ' + '\n'.join(self.startup_errors))

    def read_stderr(self):
        for line in self.process.stderr:
            if '[sidecar] ready' in line:
                self.ready.set()
            elif not self.ready.is_set() and ('[PLAINSONG_' in line or '[sidecar]' in line):
                self.startup_errors.append(line.strip())
                self.startup_errors = self.startup_errors[-20:]

    def read_stdout(self):
        for line in self.process.stdout:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if value.get('method') == 'event':
                params = value.get('params', {})
                payload = params.get('payload', {})
                if isinstance(payload, dict) and payload.get('recordingId') == self.fixture:
                    event = {'time': time.monotonic(), 'event': params.get('event'), 'payload': payload}
                    self.events.append(event)
                    if self.events_file:
                        try:
                            with self.events_file.open('a') as stream:
                                stream.write(json.dumps(event, ensure_ascii=False) + '\n')
                        except OSError as error:
                            self.event_log_error = str(error)
            elif value.get('id') is not None:
                self.responses.put(value)
        self.responses.put(None)

    def call(self, method, params=None, timeout=120):
        self.serial += 1
        request_id = self.serial
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params or {}}) + '\n')
        self.process.stdin.flush()
        end = time.monotonic() + timeout
        while True:
            try:
                value = self.responses.get(timeout=max(0.001, end - time.monotonic()))
            except queue.Empty:
                raise RuntimeError('Sidecar timed out during ' + method) from None
            if value is None:
                raise RuntimeError('Sidecar exited during ' + method)
            if value.get('id') != request_id:
                raise RuntimeError('Sidecar returned an unexpected response ID')
            if 'error' in value:
                raise RuntimeError(str(value['error']))
            return value.get('result')

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        self.stdout_reader.join(timeout=2)
        self.stderr_reader.join(timeout=2)


def score(meeting, text):
    lower = text.lower()
    result = {}
    for category, items in meeting['expected'].items():
        kept, missing = [], []
        for item in items:
            any_match = any(term.lower() in lower for term in item.get('anyOf', ['']))
            all_match = all(term.lower() in lower for term in item.get('allOf', []))
            (kept if any_match and all_match else missing).append(item['label'])
        result[category] = {'kept': len(kept), 'total': len(items), 'retained': kept, 'missing': missing}
    return result


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def source_manifest():
    paths = list((APP / 'rust-sidecar/src').rglob('*.rs'))
    paths += [APP / value for value in ['rust-sidecar/Cargo.toml', 'rust-sidecar/Cargo.lock',
              'rust-sidecar/text-helper/Cargo.toml', 'rust-sidecar/text-helper/Cargo.lock',
              'rust-sidecar/text-helper/src/main.rs', 'scripts/model-weights-manifest.mjs',
              'scripts/sidecar-cargo-features.ts', 'scripts/build-native-text-helper.ts',
              'scripts/build-native-language-model-helper.ts', 'scripts/native-macos-language-model-helper.swift',
              'scripts/evaluate-local-notes.py', 'docs/evals/meeting-notes-fixtures.json']]
    values = {str(path.relative_to(APP)): digest(path) for path in sorted(set(paths))}
    content = json.dumps(values, sort_keys=True, indent=2).encode()
    return content, hashlib.sha256(content).hexdigest()


def memory_wait_observation(now, idle_deadline, overall_deadline, wait_seconds, running):
    if running:
        idle_deadline = min(overall_deadline, now + max(0, wait_seconds))
    expired = now >= overall_deadline or (now >= idle_deadline and not running)
    return expired, idle_deadline


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', required=True, choices=[item['id'] for item in FIXTURES])
    parser.add_argument('--tier', required=True, choices=['light', 'balanced', 'best'])
    parser.add_argument('--simulate', required=True, choices=['8', '16'])
    parser.add_argument('--provider', choices=['native_text', 'apple_language_model'], default='native_text')
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--wait-memory-seconds', type=int, default=180,
                        help='Maximum idle observation window while waiting for memory')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('The footprint sampler requires macOS')
    meeting = next(item for item in FIXTURES if item['id'] == args.fixture)
    if args.out.exists():
        previous = json.loads(args.out.read_text())
        archive = args.out.with_name(args.out.stem + '--' + previous.get('result', 'unknown') + '-' + str(time.time_ns()) + '.json')
        args.out.replace(archive)
    binary = APP / 'rust-sidecar/target/release/plainsong-sidecar'
    helper = APP / 'dist-native/plainsong-text-helper'
    manifest, manifest_digest = source_manifest()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    manifest_name = 'source-' + manifest_digest + '.json'
    (args.out.parent / manifest_name).write_bytes(manifest)
    receipt = {'sourceManifest': manifest_name, 'sourceManifestSha256': manifest_digest, 'schema': 'plainsong-real-notes-eval-v1', 'fixture': args.fixture, 'tier': args.tier,
               'simulatedPhysicalMemoryGb': int(args.simulate), 'provider': args.provider, 'electronMeasured': False,
               'captureModelLoaded': False, 'sampleIntervalMs': 50,
               'memoryWaitIdleLimitSeconds': max(0, args.wait_memory_seconds),
               'overallObservationLimitSeconds': 1800,
               'hostCpu': subprocess.check_output(['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip(),
               'hostOsVersion': subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'], text=True).strip(),
               'bunVersion': subprocess.check_output(['bun', '--version'], text=True).strip(),
               'rustcVersion': subprocess.check_output(['rustc', '--version'], text=True).strip(),
               'hostPhysicalMemoryBytes': int(subprocess.check_output(['/usr/sbin/sysctl', '-n', 'hw.memsize'], text=True)),
               'hostLogicalCores': int(subprocess.check_output(['/usr/sbin/sysctl', '-n', 'hw.ncpu'], text=True)),
               'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=APP, text=True).strip(),
               'sidecarSha256': digest(binary), 'helperSha256': digest(helper),
               'appleHelperSha256': digest(APP / 'dist-native/plainsong-native-language-model-helper'), 'result': 'failed'}
    events_name = args.out.stem + '-events-' + str(time.time_ns()) + '.jsonl'
    events_file = args.out.parent / events_name
    events_file.touch()
    receipt.update(result='preparing', eventsFile=events_name)
    args.out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    client = sampler = started = None
    with tempfile.TemporaryDirectory(prefix='plainsong-notes-eval-') as directory:
        root = Path(directory).resolve()
        data, config = root / 'data', root / 'config'
        data.mkdir()
        config.mkdir()
        env = dict(os.environ, TMPDIR=str(root), PLAINSONG_QA_MODE='1', PLAINSONG_QA_EPHEMERAL_SECRETS='1',
                   PLAINSONG_DATA_DIR=str(data), PLAINSONG_CONFIG_DIR=str(config),
                   PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=args.simulate, CARGO_BUILD_JOBS='4',
                   NOTES_EVAL_DATA_DIR=str(data), NOTES_EVAL_FIXTURE=args.fixture)
        model_dir = 'native_text_light' if args.tier == 'light' else 'native_text'
        if args.provider == 'native_text':
            target = data / 'Plainsong/models' / model_dir
            target.mkdir(parents=True)
            for source in (RECEIPTS / 'models' / model_dir).iterdir():
                if source.name == 'LICENSE' or source.suffix == '.gguf':
                    subprocess.run(['/bin/cp', '-c', str(source), str(target / source.name)], check=True)
        seed = subprocess.run(['bun', 'scripts/cargo-sidecar.ts', 'test', '--locked', '--lib',
                               'llm::native_text::tests::seed_notes_fixture', '--', '--ignored', '--exact', '--test-threads=1'],
                              cwd=APP, env=env, capture_output=True, text=True)
        if seed.returncode:
            raise RuntimeError('Fixture seed failed: ' + seed.stdout[-4000:] + seed.stderr[-4000:])
        try:
            client = Sidecar(binary, env, args.fixture, events_file)
            if args.provider == 'apple_language_model' or (args.fixture == 'standup-3min' and args.tier == 'light' and args.simulate == '8'):
                try:
                    receipt['appleAvailability'] = client.call('get_apple_language_model_availability', {'refresh': True})
                except Exception as error:
                    receipt['appleProbeError'] = str(error)
            settings = client.call('get_settings')
            initial_status = client.call('get_native_text_model_status')
            chosen = next(item for item in initial_status['sizes'] if item['size'] == args.tier)
            model_id = chosen['modelId']
            settings['privacy']['meetingsAi'] = {'provider': args.provider, 'modelId': None if args.provider != 'native_text' or initial_status['recommendedModelId'] == model_id else model_id}
            settings['privacy']['remoteProcessingEnabled'] = False
            client.call('save_settings', {'settings': settings})
            if args.provider == 'native_text':
                client.call('download_native_text_model', {'modelId': model_id}, timeout=180)
            before = client.call('get_native_text_model_status', {'modelId': model_id})
            expected_model = model_id if args.provider == 'native_text' else 'apple-on-device'
            receipt.update(modelId=expected_model, recommendedModelId=before['recommendedModelId'],
                           hardwareTier=before['hardwareTier'], admissionBefore=before if args.provider == 'native_text' else None,
                           availableMemoryBeforeBytes=before['memoryAvailableBytes'],
                           loadAverageBefore=list(os.getloadavg()))
            sampler = Sampler(client.process.pid)
            sampler.thread.start()
            receipt['result'] = 'running'
            args.out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
            started = time.monotonic()
            recording = client.call('retry_meeting_analysis', {'recordingId': args.fixture}, timeout=1800)
            initial_failure = recording.get('analysisFailure')
            memory_wait_observed = initial_failure == 'Notes will be written when memory frees up.'
            wait_deadline = time.monotonic() + max(0, args.wait_memory_seconds)
            overall_deadline = started + 1800
            while recording.get('analysisFailure') == 'Notes will be written when memory frees up.':
                phases = [event for event in client.events if event['event'] == 'meeting-analysis-status']
                running = bool(phases and phases[-1]['payload'].get('phase') == 'running')
                expired, wait_deadline = memory_wait_observation(
                    time.monotonic(), wait_deadline, overall_deadline, args.wait_memory_seconds, running)
                if expired:
                    break
                time.sleep(2)
                recording = client.call('get_recording', {'recordingId': args.fixture})
            duration = round((time.monotonic() - started) * 1000)
            after = client.call('get_native_text_model_status', {'modelId': model_id})
            parent = usage(client.process.pid)
            if parent:
                sampler.parent_peak = max(sampler.parent_peak, parent['lifetimePeak'])
            failure = recording.get('analysisFailure')
            waiting = failure == 'Notes will be written when memory frees up.'
            if waiting:
                cancelled = client.call('cancel_meeting_notes_wait', {'recordingId': args.fixture})
                cancelled_recording = client.call('get_recording', {'recordingId': args.fixture})
                receipt['cancelAcknowledged'] = cancelled.get('cancelled') is True
                receipt['cancelledNoticePersisted'] = cancelled_recording.get('analysisFailure') == 'Automatic notes cancelled. Retry when ready.'
            summary = recording.get('summary') or ''
            actions = recording.get('actionItems') or []
            complete = bool(summary) and recording.get('actionItemsProvenance') is not None and failure is None
            selection_verified = before['hardwareTier'] == ('light' if args.simulate == '8' else 'balanced') and all(
                (recording.get(key) or {}).get('actualProvider') == args.provider and
                (recording.get(key) or {}).get('actualModel') == expected_model
                for key in ['summaryProvenance', 'actionItemsProvenance'])
            observed = after.get('observedHelperMemory', {})
            live_helpers = [pid for pid in children(client.process.pid) if process_name(pid).startswith('plainsong-text')]
            receipt.update(result='completed' if complete else 'waiting' if waiting else 'failed',
                           elapsedMs=duration if complete else None, attemptedElapsedMs=duration,
                           memoryWaitObserved=memory_wait_observed, initialFailure=initial_failure,
                           selectionVerified=selection_verified,
                           recording=recording, error=failure, nativeHelperMemory=observed,
                           helperExited=not live_helpers, sidecarLifetimePeakFootprintBytes=sampler.parent_peak,
                           helperPlusSidecarPeakUpperBoundBytes=sampler.parent_peak + max(sampler.helper_peak, observed.get('peakFootprintBytes', 0)),
                           sampledAllSidecarProcessesPeakBytes=sampler.sum_peak,
                           measurementValid=args.provider == 'native_text' and sampler.parent_peak > 0 and observed.get('peakFootprintBytes', 0) > 0,
                           admissionProfileCovered=args.provider == 'native_text' and 0 < observed.get('peakResidentBytes', 0) <= before.get('modelMemoryBytes', 0),
                           appleSystemModelMemoryMeasured=False,
                           scores=score(meeting, summary + '\n' + '\n'.join(actions)) if complete else None,
                           generatedScores=score(meeting, summary.rsplit('\n\n### Source details\n\n', 1)[0] + '\n' + '\n'.join(actions)) if complete else None,
                           loadAverageAfter=list(os.getloadavg()), events=client.events)
        except Exception as error:
            receipt['result'] = 'failed'
            receipt['error'] = str(error)
            if started is not None:
                receipt['attemptedElapsedMs'] = round((time.monotonic() - started) * 1000)
        finally:
            if client:
                client.close()
                receipt['sidecarExited'] = client.process.poll() is not None
                receipt['events'] = client.events
                receipt['eventLogError'] = client.event_log_error
            if sampler:
                sampler.finish()
                receipt['sampleCount'] = len(sampler.samples)
                observed = receipt.get('nativeHelperMemory', {})
                receipt['sidecarLifetimePeakFootprintBytes'] = sampler.parent_peak
                receipt['helperPlusSidecarPeakUpperBoundBytes'] = sampler.parent_peak + max(sampler.helper_peak, observed.get('peakFootprintBytes', 0))
                receipt['sampledAllSidecarProcessesPeakBytes'] = sampler.sum_peak
                killed = []
                for pid, started_at in sampler.known_helpers.items():
                    current = usage(pid)
                    if current and current['started'] == started_at and process_name(pid).startswith('plainsong-text'):
                        os.kill(pid, signal.SIGKILL)
                        killed.append(pid)
                receipt['orphanHelpersStopped'] = killed
                if killed:
                    receipt['helperExited'] = False
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: receipt.get(key) for key in ['fixture', 'tier', 'simulatedPhysicalMemoryGb', 'result', 'elapsedMs', 'error']}))
    return 0 if receipt['result'] == 'completed' and receipt.get('helperExited') and receipt.get('selectionVerified') and (args.provider == 'apple_language_model' or (receipt.get('measurementValid') and receipt.get('admissionProfileCovered'))) else 1


if __name__ == '__main__':
    raise SystemExit(main())
