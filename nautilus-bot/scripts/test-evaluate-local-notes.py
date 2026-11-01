import runpy
from pathlib import Path
import unittest

observe = runpy.run_path(str(Path(__file__).with_name('evaluate-local-notes.py')))['memory_wait_observation']


class MemoryWaitObservationTests(unittest.TestCase):
    def test_active_generation_leaves_a_full_idle_window_for_the_next_stage(self):
        expired, deadline = observe(60, 180, 1800, 180, True)
        self.assertFalse(expired)
        expired, deadline = observe(600, deadline, 1800, 180, True)
        self.assertFalse(expired)
        expired, deadline = observe(601, deadline, 1800, 180, False)
        self.assertFalse(expired, 'a ten-minute generation must not cancel the next memory wait')
        expired, deadline = observe(779, deadline, 1800, 180, False)
        self.assertFalse(expired)
        expired, _ = observe(780, deadline, 1800, 180, False)
        self.assertTrue(expired)

    def test_a_job_without_admitted_work_still_stops_at_the_idle_deadline(self):
        expired, deadline = observe(179, 180, 1800, 180, False)
        self.assertFalse(expired)
        expired, _ = observe(180, deadline, 1800, 180, False)
        self.assertTrue(expired)

    def test_active_work_cannot_extend_the_overall_deadline(self):
        expired, _ = observe(1800, 2000, 1800, 180, True)
        self.assertTrue(expired)

    def test_zero_idle_wait_still_allows_an_admitted_generation(self):
        expired, deadline = observe(60, 0, 1800, 0, True)
        self.assertFalse(expired)
        expired, _ = observe(61, deadline, 1800, 0, False)
        self.assertTrue(expired)


if __name__ == '__main__':
    unittest.main()
