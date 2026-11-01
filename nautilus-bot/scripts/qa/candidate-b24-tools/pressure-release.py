"""Instance-only warning/recovery probe using real, seeded model operations."""
import json
from qa_session import preflight, wait_for

OPERATIONS = {'notes': {'summarize_recording', 'summarize_recording_grounded', 'analyze_recording'},
              'cleanup': {'reprocess_dictation_text'},
              'search': {'search_transcripts', 'ask_memory', 'reindex_embeddings'},
              'speaker': {'run_diarization'}}


def validate_operations(operations):
    if set(operations) != set(OPERATIONS):
        raise ValueError('Provide one real operation for notes, cleanup, search and speaker')
    for lane, operation in operations.items():
        if not isinstance(operation, dict) or operation.get('command') not in OPERATIONS[lane] or not isinstance(operation.get('args', {}), dict):
            raise ValueError('Unsupported operation for ' + lane)


def lifecycle(events, lane):
    values = [e for e in events if e.get('lane') == lane]
    return ({e['id'] for e in values if e['loaded']}, {e['id'] for e in values if not e['loaded']})


def probe(session, context, operations):
    validate_operations(operations)
    result = {'binding': context['binding'], 'lanes': [], 'finished': False}
    output = session.work / 'pressure-release.json'
    def write():
        output.write_text(json.dumps(result, indent=2) + '\n')
    try:
        for lane, operation in operations.items():
            row = {'lane': lane, 'operation': operation, 'admission': preflight()}
            result['lanes'].append(row)
            start = len(session.model_events())
            row['firstResult'] = session.invoke(operation['command'], operation.get('args', {}), prefix='// gesture\n')
            events = session.model_events()[start:]
            first_loaded, first_unloaded = lifecycle(events, lane)
            if not first_loaded:
                raise RuntimeError(lane + ' operation did not load its real model')
            row['before'] = session.model_state()
            row['beforeFootprint'] = session.footprint(lane + '-before-warning')
            row['residency'] = 'idle' if first_loaded - first_unloaded else 'operation'
            if lane in {'notes', 'cleanup'} and row['residency'] != 'idle':
                raise RuntimeError(lane + ' did not retain an idle model for the pressure test')
            row['warningAck'] = session.inject_pressure('warning')
            wait_for(session.model_state, lambda values: not any(v['lane'] == lane for v in values),
                     30, lane + ' release')
            row['warningState'] = session.model_state()
            row['warningFootprint'] = session.footprint(lane + '-warning')
            row['normalAck'] = session.inject_pressure('normal')
            row['normalAdmission'] = preflight()
            reload_start = len(session.model_events())
            row['secondResult'] = session.invoke(operation['command'], operation.get('args', {}), prefix='// gesture\n')
            second_loaded, second_unloaded = lifecycle(session.model_events()[reload_start:], lane)
            row['freshModelIds'] = sorted(second_loaded)
            if not second_loaded or first_loaded & second_loaded:
                raise RuntimeError(lane + ' did not reload a new model instance on use')
            if row['residency'] == 'operation' and not second_loaded <= second_unloaded:
                raise RuntimeError(lane + ' left an operation-owned model resident')
            row['reloadedState'] = session.model_state()
            row['reloadedFootprint'] = session.footprint(lane + '-reloaded')
            row['events'] = session.model_events()[start:]
            row['passed'] = True
            write()
        result['finished'] = True
        return result
    finally:
        session.pressure.write_text('normal\n')
        result['events'] = session.model_events()
        write()
