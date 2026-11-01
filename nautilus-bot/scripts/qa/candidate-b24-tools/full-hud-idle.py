"""Adapted from b23 full-hud-idle.py. Uses only the owned app's CDP pipe."""
import json
import time
from qa_session import wait_for

TERMINAL = {'idle', 'ready', 'error', 'recoverable', 'cancelled'}


def settled_meeting(recording, overlay, recording_id):
    return (recording.get('id') == recording_id and recording.get('status') == 'completed'
            and overlay.get('phase') in TERMINAL
            and overlay.get('recordingId') in (None, recording_id))


def create_huds(session):
    session.invoke('save_settings', {'patch': [
        {'op': 'set', 'path': ['transcription', 'enableDiarization'], 'value': False},
        {'op': 'set', 'path': ['transcription', 'enableAutoAnalysis'], 'value': False},
        {'op': 'set', 'path': ['ui', 'dictationSounds'], 'value': False}], 'preserveSavedPrompts': True})
    # Project just the id. Never serialize a capture object or a Promise handle.
    recording_id = session.call('''// gesture
      (async()=>{const r=await window.electronAPI.invoke('begin_meeting_capture',
        {options:{mic:true,systemAudio:false,projectId:'inbox',meetingCaptureMode:'mic_only'}});
        return typeof r==='string'?r:r.recordingId;})()''')
    if not isinstance(recording_id, str) or not recording_id:
        raise RuntimeError('Capture did not return a recording id')
    session.hidden_wait(1)
    session.call('// gesture\n(async()=>{await window.electronAPI.invoke("end_meeting_capture",' +
                 json.dumps({'recordingId': recording_id}) + ');return null;})()')
    def state():
        return {'recording': session.invoke('get_recording', {'recordingId': recording_id}),
                'overlay': session.invoke('get_recording_overlay_state')}
    # end_meeting_capture only finalizes capture. Transcription can still be pending.
    terminal = wait_for(state, lambda v: settled_meeting(v['recording'], v['overlay'], recording_id),
                        300, 'meeting publication and terminal HUD')
    session.invoke('start_dictation', {'options': {'deliveryMode': 'preview', 'saveToInbox': False}}, prefix='// gesture\n')
    session.hidden_wait(1)
    session.call('// gesture\n(async()=>{await window.electronAPI.invoke("stop_dictation");return null;})()')
    wait_for(lambda: session.invoke('get_dictation_overlay_state'),
             lambda v: v.get('phase') in TERMINAL, 180, 'dictation terminal HUD')
    return {'recordingId': recording_id, 'terminal': terminal}


def probe(session, context, loops=3):
    work = session.work / 'full-hud-idle'
    work.mkdir()
    result = {'binding': context['binding'], 'runs': [], 'finished': False}
    def write():
        (work / 'outcome.json').write_text(json.dumps(result, indent=2) + '\n')
    def targets():
        return session.browser('Target.getTargets')['targetInfos']
    def hud_pages(snapshot):
        return {t['targetId']: t['url'] for t in snapshot if t['type'] == 'page' and 'overlay=' in t.get('url', '')}
    def renderers(snapshot):
        return {p['id'] for p in snapshot['processInfo'] if p['type'] == 'renderer'}
    def ui():
        return session.call('''({page:document.querySelector('button[aria-current=page]')?.textContent?.trim(),
          bounds:{x:screenX,y:screenY,width:outerWidth,height:outerHeight},canSuspend:window.__plainsongCanSuspend?.()})''')
    try:
        result['creation'] = create_huds(session)
        session.invoke('open_main_window_to', {'view': 'dashboard'})
        wait_for(lambda: session.call('window.__plainsongCanSuspend?.()'), lambda v: v is True, 60, 'safe Home view')
        session.invoke('__window_set_size__', {'width': 1040, 'height': 760})
        initial_huds = hud_pages(targets())
        if len(initial_huds) != 2:
            raise RuntimeError('Both HUD targets are required')
        for index in range(loops):
            row = {'index': index + 1, 'beforeUi': ui(),
                   'beforeProcesses': session.browser('SystemInfo.getProcessInfo')}
            result['runs'].append(row)
            write()
            if row['beforeUi']['canSuspend'] is not True:
                raise RuntimeError('Main view is not safe to suspend')
            session.invoke('__window_hide__')
            started = time.monotonic()
            session.hidden_wait(135)
            row['hiddenSeconds'] = time.monotonic() - started
            row['closedTargets'] = targets()
            row['closedProcesses'] = session.browser('SystemInfo.getProcessInfo')
            pages = [t for t in row['closedTargets'] if t['type'] == 'page' and not t['url'].startswith('devtools:')]
            if len(pages) != 2 or hud_pages(pages) != initial_huds:
                raise RuntimeError('Main target was retained or a HUD target was replaced')
            row['samples'] = []
            for sample in range(6):
                footprint = session.footprint(f'hud-{index+1}-sample-{sample+1}')
                helpers = [pid for pid, _, command in footprint['processes']
                           if 'plainsong-native-asr-helper' in command]
                if len(helpers) != 1:
                    raise RuntimeError('One warm owned speech helper is required for every sample')
                row['samples'].append(footprint)
                write()
                session.hidden_wait(5)
            started = time.monotonic()
            session.invoke('open_main_window', prefix='// dictation-overlay\n')
            wait_for(lambda: session.call('Boolean(document.querySelector("main#main-content")&&window.electronAPI?.invoke)'),
                     bool, 30, 'recreated main window')
            session.invoke('get_settings')
            row['reopenCommandFileMs'] = (time.monotonic() - started) * 1000
            row['afterUi'] = ui()
            row['afterProcesses'] = session.browser('SystemInfo.getProcessInfo')
            row['boundsRestored'] = row['beforeUi']['bounds'] == row['afterUi']['bounds']
            row['navigationRestored'] = row['beforeUi']['page'] == row['afterUi']['page']
            closed = renderers(row['closedProcesses'])
            row['hudPidsPreserved'] = (len(closed) == 2 and
                closed <= renderers(row['beforeProcesses']) & renderers(row['afterProcesses']))
            if not all(row[k] for k in ['boundsRestored', 'navigationRestored', 'hudPidsPreserved']):
                raise RuntimeError('Bounds, navigation or HUD renderer preservation failed')
            write()
        result['finished'] = True
        return result
    finally:
        write()
