"""Disposable b24 QA sessions. Never attaches to an existing app instance."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

Q = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Q / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def preflight():
    result = {'at': datetime.datetime.now().astimezone().isoformat()}
    for name, command in [('memoryPressure', ['memory_pressure']), ('disk', ['df', '-h', '/']),
                          ('diskGiB', ['df', '-g', '/']),
                          ('pressure', ['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])]:
        result[name] = subprocess.check_output(command, text=True).strip()
    if int(result['diskGiB'].splitlines()[1].split()[3]) < 20:
        raise RuntimeError('Resource-blocked: disk below 20 GiB')
    if result['pressure'] != '1':
        raise RuntimeError('Resource-blocked: host pressure must be normal')
    volume = subprocess.check_output(['osascript', '-e', 'get volume settings'], text=True)
    result['volume'] = volume
    import re
    match = re.search(r'output volume:(\d+)', volume)
    if not match or int(match[1]) > 25 or 'output muted:false' not in volume:
        raise RuntimeError('Volume must be at most 25 and unmuted')
    return result


def wait_for(sample, predicate, timeout=60, label='state'):
    deadline = time.monotonic() + timeout
    while True:
        value = sample()
        if predicate(value):
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(f'{label} did not settle: {value!r}')
        time.sleep(.25)


class Session:
    def __init__(self, app_root, seed=None, app=None):
        admission = preflight()
        self.root = Path(tempfile.mkdtemp(prefix='plainsong-b24-qa-')).resolve()
        self.work = self.root / 'receipts'
        self.work.mkdir()
        self.profile = self.root / 'profile'
        if seed:
            seed = Path(seed).resolve()
            live = Path.home() / 'Library/Application Support/Plainsong'
            if seed == live or live in seed.parents or not (seed / 'config').is_dir() or not (seed / 'data').is_dir():
                raise RuntimeError('Use an existing disposable QA profile seed with config/ and data/')
            subprocess.run(['cp', '-cR', str(seed), str(self.profile)], check=True)
        else:
            self.profile.mkdir()
        self.pressure = self.root / 'pressure'
        self.pressure.write_text('normal\n')
        self.pressure.chmod(0o600)
        self.models = self.pressure.with_suffix('.models.jsonl')
        self.models.touch(mode=0o600)
        self.app_root = Path(app_root).resolve()
        packaged = None
        bundle_binding = None
        if app:
            source = Path(app).resolve()
            if source == Path('/Applications/Plainsong.app') or source.suffix != '.app':
                raise RuntimeError('Pass a candidate bundle, never the installed app')
            bundle = self.root / 'bundle'
            bundle.mkdir()
            packaged = bundle / 'Plainsong.app'
            subprocess.run(['cp', '-cR', str(source), str(packaged)], check=True)
            def binding(candidate):
                code = ('import {captureAppReceiptBinding} from ' +
                        json.dumps(str(self.app_root / 'scripts/lib/app-receipt-binding.ts')) +
                        ';console.log(JSON.stringify(captureAppReceiptBinding(' + json.dumps(str(candidate)) + ')));')
                return json.loads(subprocess.check_output(['bun', '-e', code], text=True))
            bundle_binding = binding(packaged)
            if binding(source)['appBundleSha256'] != bundle_binding['appBundleSha256']:
                raise RuntimeError('Disposable bundle copy differs from the candidate')
        self.context = {'binding': {'sourceRoot': str(self.app_root),
                                   'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.app_root, text=True).strip(),
                                   'proofLayer': 'packaged' if packaged else 'dev', 'bundle': bundle_binding}, 'preflight': admission,
                        'runtime': str(self.root)}
        (self.work / 'context.json').write_text(json.dumps(self.context, indent=2) + '\n')
        self.log = (self.work / 'driver.log').open('w')
        env = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'
               and not k.startswith(('PLAINSONG_', 'FRESH_', 'B22_', 'B24_'))}
        env.update(B24_APP_ROOT=str(self.app_root), B24_PROFILE=str(self.profile),
                   PLAINSONG_QA_MODE='1', PLAINSONG_QA_PRESSURE_FILE=str(self.pressure),
                   PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB='8')
        if packaged:
            env['B24_APP'] = str(packaged)
        self.p = subprocess.Popen(['bun', str(Q / 'session-driver.ts'), str(self.work)],
                                  env=env, stdout=self.log, stderr=subprocess.STDOUT)
        self.identity = None
        try:
            def ready():
                self.check_alive()
                try:
                    events = json.loads((self.work / 'events.json').read_text())['events']
                    self.identity = next((e['value'] for e in events if e['step'] == 'profile'), None)
                    return any(e['step'] == 'interactive-ready' for e in events)
                except (OSError, ValueError):
                    return False
            wait_for(ready, bool, 180, 'owned session readiness')
            self.call('''(async()=>{let homeRequested=false;for(let i=0;i<120;i++){
              const d=document.querySelector('[role="dialog"][aria-modal="true"]');
              if(d){const b=[...d.querySelectorAll('button')].find(b=>/skip setup for now|skip model download/i.test(b.textContent||''));
                if(b&&!b.disabled){b.click();await new Promise(r=>setTimeout(r,500));}}
              if(!homeRequested&&!document.querySelector('[role="dialog"], [role="alertdialog"]')&&
                 document.querySelector('.app-shell:not([inert]) button[aria-current="page"]')){
                homeRequested=true;await window.electronAPI.invoke('open_main_window_to',{view:'dashboard'});
                await new Promise(r=>setTimeout(r,250));}
              if(WORKSPACE_READY)return true;
              await new Promise(r=>setTimeout(r,250));}throw Error('Workspace remained blocked by setup');})()'''.replace('WORKSPACE_READY', (Q / 'workspace-ready.js').read_text()))
        except BaseException:
            self.quit()
            raise

    def check_alive(self):
        if self.p.poll() is not None:
            raise RuntimeError(f'Owned session exited; see {self.work / "driver.log"}')

    def call(self, script, timeout=180):
        self.check_alive()
        folder = self.work / 'cmd'
        n = 1
        while (folder / f'{n}.js').exists():
            n += 1
        command = folder / f'{n}.js'
        temporary = command.with_suffix('.tmp')
        temporary.write_text(script)
        temporary.rename(command)
        output = command.with_suffix('.out.json')
        def read():
            self.check_alive()
            return json.loads(output.read_text()) if output.exists() else {'pending': True}
        value = wait_for(read, lambda value: not isinstance(value, dict) or 'pending' not in value,
                         timeout, f'CDP command {n}')
        if isinstance(value, dict) and value.get('error'):
            raise RuntimeError(str(value['error']))
        return value

    def invoke(self, command, args=None, prefix=''):
        return self.call(prefix + 'window.electronAPI.invoke(' + json.dumps(command) + ',' + json.dumps(args or {}) + ')')

    def browser(self, method, params=None):
        return self.call('// browser-cdp-command\n' + json.dumps({'method': method, 'params': params or {}}))

    def hidden_wait(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.check_alive()
            time.sleep(min(1, max(0, deadline - time.monotonic())))

    def footprint(self, label):
        rows = []
        for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True).splitlines():
            parts = line.strip().split(None, 2)
            if len(parts) == 3:
                rows.append((int(parts[0]), int(parts[1]), parts[2]))
        owned = {self.identity['pid']}
        while True:
            children = {pid for pid, parent, _ in rows if parent in owned}
            if children <= owned:
                break
            owned |= children
        args = ['/usr/bin/footprint', '-f', 'bytes']
        for pid in sorted(owned):
            args += ['-p', str(pid)]
        result = subprocess.run(args, capture_output=True, text=True, check=True)
        output = self.work / (label + '.footprint.txt')
        output.write_text(result.stdout + result.stderr)
        return {'path': str(output), 'pids': sorted(owned),
                'processes': [row for row in rows if row[0] in owned]}

    def inject_pressure(self, level):
        import re
        if level not in {'normal', 'warning', 'critical'}:
            raise ValueError('Unknown pressure level')
        log = self.work / 'app-output.log'
        offset = log.stat().st_size
        temporary = self.pressure.with_suffix('.tmp')
        temporary.write_text(level + '\n')
        temporary.chmod(0o600)
        temporary.replace(self.pressure)
        def ack():
            text = re.sub(r'\x1b\[[0-9;]*m', '', log.read_bytes()[offset:].decode('utf8', errors='replace')).lower()
            return next((line for line in text.splitlines()
                         if 'qa instance pressure applied' in line and 'pressure=' + level in line), None)
        return wait_for(ack, bool, 20, 'instance pressure acknowledgement')

    def model_events(self):
        # A concurrent append may expose its final line before the newline.
        lines = self.models.read_bytes().splitlines(keepends=True)
        return [json.loads(line) for line in lines if line.endswith(b'\n')]

    def model_state(self):
        active = {}
        for event in self.model_events():
            if event['loaded']:
                active[event['id']] = event
            else:
                active.pop(event['id'], None)
        return list(active.values())

    def create_guard_fixture(self):
        import sqlite3
        import uuid
        database = self.profile / 'data/Plainsong/plainsong.db'
        if self.profile not in database.resolve().parents:
            raise RuntimeError('Fixture database escaped the owned profile')
        recording_id = 'b24-guard-' + str(uuid.uuid4())
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with sqlite3.connect('file:' + str(database) + '?mode=rw', uri=True) as db:
            db.execute("INSERT INTO recordings(id,title,project_id,created_at,updated_at,source_type,status,meeting_notes,audio_path,duration) VALUES(?,?,?,?,?,'meeting','completed',?,'',0)",
                       (recording_id, 'B24 guard fixture', 'inbox', at, at, '## Decisions\n\nKeep the original note.'))
        return recording_id

    def quit(self):
        if self.p.poll() is None:
            (self.work / 'cmd').mkdir(exist_ok=True)
            (self.work / 'cmd/quit').touch()
            # The driver only signals its own spawned child process group.
            self.p.wait(timeout=195)
        self.log.close()
