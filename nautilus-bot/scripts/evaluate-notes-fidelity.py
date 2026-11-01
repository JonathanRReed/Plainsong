#!/usr/bin/env python3
"""Run the ignored native probe sequentially, or score its synthetic receipts.

Run under the repository's build-slot guard. This never downloads weights,
changes admission, or opens an app. Summary entailment needs a separate audit
JSON; the pipeline's own grounded flag is reported only as a diagnostic.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time

APP = Path(__file__).resolve().parents[1]
FIXTURES = APP / 'docs/evals/notes-fidelity-fixtures.json'


def contains(text, term):
    text = text.replace("won't", 'will not').replace('’', "'")
    return re.search(r'(?<!\w)' + re.escape(term.lower()) + r'(?!\w)', text.lower()) is not None




def draft_sentences(draft):
    # Match the production statement splitter: formatting is not a claim.
    result = []
    for line in draft.splitlines():
        line = line.strip()
        words = line.split()
        title = words and len(words) <= 5 and not line.endswith(('.', '!', '?')) and all(
            not word[0].islower() for word in words)
        if not line or line.startswith('#') or title or line.endswith(':') and len(words) <= 6:
            continue
        body = re.sub(r'^(?:[-+*>•]\s*)+|^\d+[.)]\s*', '', line)
        body = re.sub(r'\s*[\[(]L[1-9][0-9]*(?:\s*[,\-–]\s*L?[1-9][0-9]*)*[\])]', '', body)
        if re.match(r'(?i)^lineids\s*:', body):
            continue
        result.extend(s.strip() for s in re.split(r'(?<=[.!?])\s+', body)
                      if s.strip() and not re.match(r'(?i)^lineids\s*:', s.strip()))
    return result


def generated_candidates(receipt):
    summary = receipt.get('summary', {})
    verification = summary.get('verification')
    if verification is not None:
        return verification.get('statements', [])
    # Older receipts predate sentence selection. Recover the last generated
    # draft for auditing only when the delivered summary is entirely excerpts.
    if not summary.get('response', '').lstrip().startswith('### Source details'):
        return []
    for call in reversed(receipt.get('trace', [])[:receipt.get('summaryCalls', 0)]):
        try:
            payload = json.loads(call['text'])
        except (KeyError, ValueError):
            continue
        draft = payload.get('answer', payload.get('response'))
        if isinstance(draft, str):
            return [{'text': text.strip(), 'retained': False, 'reason': 'legacy_whole_summary_fallback'}
                    for text in draft_sentences(draft)]
    return []


def summary_metrics(meeting, receipt, audit):
    summary = receipt.get('summary', {})
    text = summary.get('response', '')
    verification = summary.get('verification')
    # Excerpts and timestamps are not generated sentences.
    prose = '\n'.join(line for line in text.splitlines()
                      if line.strip() and not line.lstrip().startswith(('#', '>')))
    sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', prose) if s.strip()]
    excerpts = []
    for block in re.split(r'\n\s*\n', text):
        quoted = [line.lstrip()[1:].strip() for line in block.splitlines()
                  if line.lstrip().startswith('>')]
        body = [line for line in quoted if line and not re.match(r'^\d+:\d+(?::\d+)?(?:\s|$)', line)]
        if body:
            excerpts.append(' '.join(body))
    normalize = lambda value: ' '.join(value.split())
    excerpts_supported = all(any(normalize(excerpt) in normalize(row['text'])
                                 for row in meeting.get('segments', [])) for excerpt in excerpts)
    checks = generated_candidates(receipt)
    delivered = audit.get('delivered', []) if audit else None
    pruned = audit.get('pruned', []) if audit else None
    def matches(decisions, texts):
        return isinstance(decisions, list) and len(decisions) == len(texts) and all(
            isinstance(c.get('supported'), bool) and c.get('text') == sentence
            for c, sentence in zip(decisions, texts))
    delivered_complete = matches(delivered, sentences)
    pruned_complete = matches(pruned, [c['text'] for c in checks if not c['retained']])
    return {
        'generatedSentencesRetained': len(sentences),
        'supportedGeneratedSentencesRetained': sum(c['supported'] for c in delivered) if delivered_complete else None,
        'unsupportedSentencesDelivered': sum(not c['supported'] for c in delivered) if delivered_complete and excerpts_supported else None,
        'paraphraseFalseRejections': sum(c['supported'] and c.get('paraphrase', False) for c in pruned) if pruned_complete else None,
        'prunedSentences': sum(not c['retained'] for c in checks),
        'supportedGeneratedSentencesPruned': sum(c['supported'] for c in pruned) if pruned_complete else None,
        'excerptFallback': verification['excerptFallback'] if verification else bool(excerpts) and not sentences,
        'sourceExcerpts': len(excerpts),
        'sourceExcerptsMatchFixture': excerpts_supported,
        'sentenceCount': len(sentences),
        'noRawQuotes': not excerpts and not re.search(r'["“”]', prose),
        'auditComplete': delivered_complete and excerpts_supported and pruned_complete,
    }


def score(meeting, receipt, audit=None):
    items = receipt.get('actions', {}).get('items', [])
    used = set()
    matches = []
    wrong_owners = []
    for expected in meeting['actions']:
        candidates = [i for i, item in enumerate(items) if i not in used and
                      all(contains(item['task'], term) for term in expected['task'])]
        # Prefer the correct relationship when duplicates exist, but report
        # wrong-owner duplicates below as well.
        candidates.sort(key=lambda i: items[i].get('assignee') != expected['owner'])
        at = candidates[0] if candidates else None
        if at is not None:
            used.add(at)
        item = items[at] if at is not None else {}
        owner = at is not None and item.get('assignee') == expected['owner']
        due = at is not None and (any(contains(item.get('deadline') or '', d) for d in expected['due'])
                                 if expected['due'] else item.get('deadline') is None)
        matches.append({'expected': expected, 'item': at, 'task': at is not None,
                        'owner': owner, 'due': due, 'complete': owner and due})
        for i, candidate in enumerate(items):
            if all(contains(candidate['task'], t) for t in expected['task']) and candidate.get('assignee') is not None and candidate['assignee'] != expected['owner']:
                wrong_owners.append(i)
    summary = receipt.get('summary', {})
    text = summary.get('response', '') + '\n' + '\n'.join(
        ' '.join(str(item.get(k) or '') for k in ['task', 'assignee', 'deadline']) for item in items)
    errors = [part for part in ['summary', 'actions'] if 'error' in receipt.get(part, {})]
    trace = receipt.get('trace', [])
    return {
        'fixture': meeting['id'], 'model': receipt['model'], 'errors': errors,
        'actions': {'total': len(matches), 'task': sum(m['task'] for m in matches),
                    'owner': sum(m['owner'] for m in matches), 'due': sum(m['due'] for m in matches),
                    'complete': sum(m['complete'] for m in matches),
                    'wrongOwners': sorted(set(wrong_owners)), 'matches': matches},
        'names': {'kept': sum(contains(text, n) for n in meeting['names']), 'total': len(meeting['names'])},
        'numbers': {'kept': sum(any(contains(text, n) for n in alternatives) for alternatives in meeting['numbers']),
                    'total': len(meeting['numbers'])},
        'summaryAudit': audit,
        'summaryMetrics': summary_metrics(meeting, receipt, audit),
        'summaryCandidates': generated_candidates(receipt),
        'pipelineDiagnostics': {'summaryGrounded': summary.get('grounded'),
                                'unverified': summary.get('unverified'),
                                'actionsGrounded': receipt.get('actions', {}).get('grounded')},
        'summaryMs': receipt.get('summaryMs'), 'actionsMs': receipt.get('actionsMs'),
        'calls': len(trace), 'generatedTokens': sum(c['generatedTokens'] for c in trace),
        'helperPeakMiB': max((c['peakFootprintBytes'] for c in trace), default=0) / 2**20,
        'helperPeakResidentMiB': max((c.get('peakResidentBytes', 0) for c in trace), default=0) / 2**20,
        'nativeWorkObserved': bool(trace),
        'measurementValid': bool(trace) and not errors,
        'processMemory': receipt.get('processMemory'),
    }


def run(args):
    # Reuse the existing macOS physical-footprint sampler. The test runner and
    # helper, including short-lived children, belong to this invocation only.
    spec = importlib.util.spec_from_file_location('local_notes', APP / 'scripts/evaluate-local-notes.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    args.out.mkdir(parents=True, exist_ok=True)
    # Compile before sampling. Compiler memory is not notes memory.
    with (args.out / 'probe-build.log').open('w') as log:
        subprocess.run(['nice', '-n', '10', 'env', 'CARGO_BUILD_JOBS=4', 'bun',
                        'scripts/cargo-sidecar.ts', 'test', '--locked', '--lib', '--no-run'],
                       cwd=APP, stdout=log, stderr=log, check=True)
    paths = sorted((APP / 'rust-sidecar/src').rglob('*.rs')) + [FIXTURES, APP / 'dist-native/plainsong-text-helper']
    source = {str(p.relative_to(APP)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    source_bytes = json.dumps(source, indent=2).encode()
    source_digest = hashlib.sha256(source_bytes).hexdigest()
    (args.out / ('source-' + source_digest + '.json')).write_bytes(source_bytes)
    class NativeSampler(module.Sampler):
        def __init__(self, pid):
            super().__init__(pid)
            self.resident_peak = 0

        def run(self):
            while not self.stop.is_set():
                pending, seen, resident, footprint = [self.pid], set(), 0, 0
                while pending:
                    pid = pending.pop()
                    if pid in seen:
                        continue
                    seen.add(pid)
                    pending.extend(module.children(pid))
                    if not module.process_name(pid).startswith(('plainsong_lib', 'plainsong-text')):
                        continue
                    item = module.usage(pid)
                    if item:
                        resident += item['resident']
                        footprint += item['footprint']
                        if module.process_name(pid).startswith('plainsong-text'):
                            self.helper_peak = max(self.helper_peak, item['lifetimePeak'])
                self.resident_peak = max(self.resident_peak, resident)
                self.sum_peak = max(self.sum_peak, footprint)
                self.samples.append([time.monotonic(), resident, footprint])
                self.stop.wait(0.05)

    rows = json.loads(FIXTURES.read_text())['meetings']
    if args.fixture:
        rows = [row for row in rows if row['id'] == args.fixture]
    failures = []
    for model, gb in [('qwen3-1.7b-q4_k_m', '8'), ('qwen3-4b-instruct-2507-q4_k_m', '16')]:
        if args.model and model != args.model:
            continue
        for row in rows:
            out = args.out / (model + '--' + row['id'] + '.json')
            previous = None
            actions_only = False
            if out.exists() and args.resume:
                existing = json.loads(out.read_text())
                if existing.get('trace') and all('error' not in existing.get(part, {}) for part in ['summary', 'actions']):
                    continue
                previous = existing
                actions_only = bool(existing.get('summary', {}).get('response')) and 'error' in existing.get('actions', {})
                out.rename(out.with_suffix('.rejected-' + str(time.time_ns()) + '.json'))
            if out.exists():
                raise RuntimeError('Refusing to overwrite receipt: ' + str(out))
            host = subprocess.check_output(['memory_pressure'], text=True)
            (out.with_suffix('.host.txt')).write_text(host + subprocess.check_output(['uptime'], text=True))
            env = dict(os.environ, NOTES_PROBE_MODELS=str(args.models), NOTES_PROBE_MODEL=model,
                       NOTES_PROBE_FIXTURE=row['id'], NOTES_PROBE_FIXTURES=str(FIXTURES),
                       NOTES_PROBE_OUT=str(out), PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=gb)
            # Deliberately do not simulate available memory or pressure.
            env.pop('PLAINSONG_SIMULATE_AVAILABLE_GB', None)
            env.pop('PLAINSONG_SIMULATE_AVAILABLE_BASELINE_BYTES', None)
            env.pop('NOTES_PROBE_ACTIONS_ONLY', None)
            if actions_only:
                env['NOTES_PROBE_ACTIONS_ONLY'] = '1'
            command = ['nice', '-n', '10', 'env', 'CARGO_BUILD_JOBS=4', 'bun', 'scripts/cargo-sidecar.ts',
                       'test', '--locked', '--lib', 'llm::notes_probe::native_notes_probe', '--',
                       '--ignored', '--exact', '--test-threads=1', '--nocapture']
            started = time.monotonic()
            with out.with_suffix('.log').open('w') as log:
                child = subprocess.Popen(command, cwd=APP, env=env, stdout=log, stderr=log)
                sampler = NativeSampler(child.pid)
                sampler.thread.start()
                result = child.wait()
                sampler.finish()
            if result or not out.exists():
                raise RuntimeError('Native probe failed; see ' + str(out.with_suffix('.log')))
            receipt = json.loads(out.read_text())
            receipt.update(wallMs=round((time.monotonic() - started) * 1000),
                           sourceHead=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=APP, text=True).strip(),
                           fixtureSha256=hashlib.sha256(FIXTURES.read_bytes()).hexdigest(),
                           sourceManifestSha256=source_digest,
                           processMemory={'sampleIntervalMs': 50, 'treePeakMiB': sampler.sum_peak / 2**20,
                                          'nativeTreePeakResidentMiB': sampler.resident_peak / 2**20,
                                          'scope': 'native test process and text helper; excludes compiler and CLI',
                                          'helperPeakMiB': sampler.helper_peak / 2**20,
                                          'samples': len(sampler.samples)})
            if actions_only:
                stage = out.with_name(out.stem + '.actions-stage.json')
                stage.write_text(json.dumps(receipt, indent=2) + '\n')
                receipt['summary'] = previous['summary']
                receipt['summaryMs'] = previous['summaryMs']
                receipt['summaryCalls'] = previous['summaryCalls']
                receipt['trace'] = previous['trace'][:previous['summaryCalls']] + receipt['trace']
                receipt['separateStageProcesses'] = True
                receipt['calls'] = len(receipt['trace'])
                receipt['summarySkipped'] = False
                receipt['summarySourceManifestSha256'] = previous.get('sourceManifestSha256')
                receipt['processMemory']['nativeTreePeakResidentMiB'] = max(previous['processMemory'].get('nativeTreePeakResidentMiB', 0), receipt['processMemory']['nativeTreePeakResidentMiB'])
                receipt['processMemory']['treePeakMiB'] = max(previous['processMemory']['treePeakMiB'], receipt['processMemory']['treePeakMiB'])
            out.write_text(json.dumps(receipt, indent=2) + '\n')
            result = score(row, receipt)
            print(json.dumps(result), flush=True)
            if not result['measurementValid']:
                failures.append(out.name)
                if not result['nativeWorkObserved']:
                    raise RuntimeError('No native generation occurred; remaining probes deferred. Review ' + str(out))
    if failures:
        raise RuntimeError('Incomplete native measurements: ' + ', '.join(failures))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    runner = sub.add_parser('run')
    runner.add_argument('--fixture', choices=[row['id'] for row in json.loads(FIXTURES.read_text())['meetings']])
    runner.add_argument('--model', choices=['qwen3-1.7b-q4_k_m', 'qwen3-4b-instruct-2507-q4_k_m'])
    runner.add_argument('--models', type=Path, required=True)
    runner.add_argument('--out', type=Path, required=True)
    runner.add_argument('--resume', action='store_true', help='Keep successful receipts; archive failures before retrying')
    scorer = sub.add_parser('score')
    scorer.add_argument('receipt', type=Path)
    scorer.add_argument('--audit', type=Path)
    args = parser.parse_args()
    if args.command == 'run':
        run(args)
    else:
        receipt = json.loads(args.receipt.read_text())
        meeting = next(m for m in json.loads(FIXTURES.read_text())['meetings'] if m['id'] == receipt['fixture'])
        print(json.dumps(score(meeting, receipt, json.loads(args.audit.read_text()) if args.audit else None), indent=2))


if __name__ == '__main__':
    main()
