#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from qa_session import Session, module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('suite', choices=['pressure', 'huds', 'guards', 'smoke'])
    parser.add_argument('--app-root', type=Path, required=True)
    parser.add_argument('--seed', type=Path)
    parser.add_argument('--app', type=Path)
    parser.add_argument('--operations', type=Path)
    parser.add_argument('--recording-id')
    args = parser.parse_args()
    operations = json.loads(args.operations.read_text()) if args.operations else None
    if args.suite == 'pressure':
        if operations is None:
            parser.error('pressure requires --operations with real disposable fixture commands')
        module('pressure-release').validate_operations(operations)
    session = None
    try:
        session = Session(args.app_root, seed=args.seed, app=args.app)
        print(json.dumps({'runtime': str(session.root)}), flush=True)
        if args.suite == 'smoke':
            assert session.call('void 0') is None
            assert session.call('Promise.resolve(undefined)') is None
            assert session.call('({nullable:null, value:42})') == {'nullable': None, 'value': 42}
            result = {'finished': True, 'binding': session.context['binding'], 'settings': session.invoke('get_settings')}
            try:
                result['warningAck'] = session.inject_pressure('warning')
                result['normalAck'] = session.inject_pressure('normal')
            finally:
                session.pressure.write_text('normal\n')
        elif args.suite == 'pressure':
            result = module('pressure-release').probe(session, session.context, operations)
        elif args.suite == 'huds':
            result = module('full-hud-idle').probe(session, session.context)
        else:
            result = module('resume-ui-guards').probe(session, session.context, args.recording_id)
        (session.work / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'finished': True, 'receipts': str(session.work)}))
    finally:
        if session:
            session.quit()


if __name__ == '__main__':
    main()
