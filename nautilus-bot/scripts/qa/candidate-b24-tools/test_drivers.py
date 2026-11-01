import unittest
from qa_session import module

hud = module('full-hud-idle')
pressure = module('pressure-release')


class DriverTests(unittest.TestCase):
    def test_meeting_must_be_completed_and_overlay_terminal(self):
        for status in ['pending', 'processing', 'error']:
            self.assertFalse(hud.settled_meeting({'id': 'owned', 'status': status}, {'phase': 'ready'}, 'owned'))
        for phase in ['preparing', 'recording', 'stopping', 'processing']:
            self.assertFalse(hud.settled_meeting({'id': 'owned', 'status': 'completed'}, {'phase': phase}, 'owned'))
        self.assertTrue(hud.settled_meeting({'id': 'owned', 'status': 'completed'}, {'phase': 'ready', 'recordingId': 'owned'}, 'owned'))
        self.assertFalse(hud.settled_meeting({'id': 'other', 'status': 'completed'}, {'phase': 'ready'}, 'owned'))
        self.assertFalse(hud.settled_meeting({'id': 'owned', 'status': 'completed'}, {'phase': 'ready', 'recordingId': 'other'}, 'owned'))

    def test_hud_creation_binds_recording_id_and_uses_fresh_owned_gestures(self):
        owner = self
        class Session:
            def invoke(self, command, args=None, prefix=''):
                if command == 'get_recording':
                    owner.assertEqual(args, {'recordingId': 'owned'})
                    return {'id': 'owned', 'status': 'completed'}
                if command == 'get_recording_overlay_state':
                    return {'phase': 'ready', 'recordingId': 'owned'}
                if command == 'get_dictation_overlay_state':
                    return {'phase': 'idle'}
                if command == 'start_dictation':
                    owner.assertEqual(prefix, '// gesture\n')
            def call(self, script):
                owner.assertTrue(script.startswith('// gesture\n'))
                return 'owned' if 'begin_meeting_capture' in script else None
            def hidden_wait(self, seconds):
                pass
        owner.assertEqual(hud.create_huds(Session())['recordingId'], 'owned')

    def test_pressure_operations_cannot_enable_an_injector_command(self):
        with self.assertRaises(ValueError):
            pressure.validate_operations({})
        operations = {lane: {'command': next(iter(commands)), 'args': {}} for lane, commands in pressure.OPERATIONS.items()}
        pressure.validate_operations(operations)
        operations['notes']['command'] = 'set_memory_pressure'
        with self.assertRaises(ValueError):
            pressure.validate_operations(operations)

    def test_operation_owned_models_are_distinct_from_idle_models(self):
        events = [{'lane': 'speaker', 'id': 1, 'loaded': True}, {'lane': 'speaker', 'id': 1, 'loaded': False},
                  {'lane': 'notes', 'id': 2, 'loaded': True}, {'lane': 'speaker', 'id': 3, 'loaded': True}]
        loaded, unloaded = pressure.lifecycle(events, 'speaker')
        self.assertEqual(loaded, {1, 3})
        self.assertEqual(loaded - unloaded, {3})
        self.assertEqual(pressure.lifecycle(events, 'notes'), ({2}, set()))


if __name__ == '__main__':
    unittest.main()
