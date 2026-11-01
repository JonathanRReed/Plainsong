"""b23 guard probe with scoped editor discovery and retained-text assertions."""
import json
from pathlib import Path
from qa_session import wait_for

EDIT_MEETING = Path(__file__).with_name('meeting-editor.js').read_text()


UI = '''({canSuspend:window.__plainsongCanSuspend?.(),
  dialog:document.querySelector('[role="dialog"], [role="alertdialog"]')?.innerText??null,
  fields:[...document.querySelectorAll('textarea')].map(e=>({label:e.getAttribute('aria-label'),value:e.value}))})'''


def probe(session, context, recording_id=None):
    result = {'binding': context['binding'], 'states': [], 'finished': False}
    output = session.work / 'ui-suspension-guards.json'
    def write():
        output.write_text(json.dumps(result, indent=2) + '\n')
    def targets():
        return session.browser('Target.getTargets')['targetInfos']
    def main_ids(rows):
        return [t['targetId'] for t in rows if t['type'] == 'page'
                and 'overlay=' not in t.get('url', '') and not t.get('url', '').startswith('devtools:')]
    def retain(label, marker=None):
        row = {'label': label, 'before': targets(), 'uiBefore': session.call(UI)}
        result['states'].append(row)
        write()
        if row['uiBefore']['canSuspend'] is not False:
            raise RuntimeError(label + ' did not veto suspension')
        session.invoke('__window_hide__')
        session.hidden_wait(135)
        row['after'] = targets()
        row['sameMainTarget'] = len(main_ids(row['before'])) == 1 and main_ids(row['before']) == main_ids(row['after'])
        if not row['sameMainTarget']:
            raise RuntimeError(label + ' lost its main renderer')
        session.invoke('open_main_window')
        row['uiAfter'] = session.call(UI)
        if row['uiAfter']['canSuspend'] is not False:
            raise RuntimeError(label + ' no longer vetoes suspension')
        if marker:
            row['textPreserved'] = any(marker in f['value'] for f in row['uiAfter']['fields'])
            if not row['textPreserved']:
                raise RuntimeError('Meeting edit was lost')
        elif row['uiBefore']['dialog'] != row['uiAfter']['dialog']:
            raise RuntimeError(label + ' dialog changed while hidden')
        write()
    try:
        session.invoke('open_main_window_to', {'view': 'projects'})
        session.call('''(async()=>{for(let i=0;i<100;i++){
          const b=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='New project');
          if(b){b.click();return true;}await new Promise(r=>setTimeout(r,100));}throw Error('New project absent');})()''')
        wait_for(lambda: session.call(UI), lambda v: v['dialog'] is not None, 20, 'project modal')
        retain('modal')
        session.call('''(()=>{const d=document.querySelector('[role="dialog"]');
          const b=[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Cancel');
          if(!b)throw Error('Cancel absent');b.click();return true;})()''')
        if recording_id is None:
            recordings = session.invoke('get_recordings')
            recording_id = next((r['id'] for r in recordings if r.get('sourceType') == 'meeting' and r.get('status') == 'completed'), None)
        if not recording_id:
            recording_id = session.create_guard_fixture()
        session.invoke('open_main_window_to', {'view': 'recordings', 'recordingId': recording_id})
        marker = 'B24 meeting edit must survive hiding.'
        result['edit'] = session.call(EDIT_MEETING.replace('MARKER', json.dumps(marker)))
        retain('meeting edit after input', marker)
        # Blur before navigation so the ordinary autosave path can flush.
        session.call('document.activeElement?.blur(); true')
        session.invoke('open_main_window_to', {'view': 'dashboard'})
        session.call('window.dispatchEvent(new CustomEvent("nautilus-open-onboarding",{detail:{mode:"full"}}));true')
        wait_for(lambda: session.call(UI), lambda v: v['dialog'] is not None, 20, 'setup dialog')
        retain('setup')
        result['finished'] = True
        return result
    finally:
        write()
