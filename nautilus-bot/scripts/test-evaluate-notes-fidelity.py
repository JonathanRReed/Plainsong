import runpy
from pathlib import Path
import unittest

module = runpy.run_path(str(Path(__file__).with_name('evaluate-notes-fidelity.py')))
score = module['score']


class FidelityScoringTests(unittest.TestCase):
    def setUp(self):
        self.meeting = {'id': 'test', 'actions': [
            {'task': ['send', 'report', 'if', 'approved'], 'owner': 'Nina', 'due': ['Friday']}],
            'names': ['Nina'], 'numbers': [['18']]}

    def check_item(self, task, assignee, deadline):
        return score(self.meeting, {'model': 'test', 'summary': {'response': 'Nina discussed 180 seats.'},
                                   'actions': {'items': [dict(task=task, assignee=assignee, deadline=deadline)]}})

    def test_owner_and_due_must_belong_to_the_matching_conditional_task(self):
        result = self.check_item('Send report if approved', 'Noah', 'Friday')
        self.assertEqual(result['actions']['wrongOwners'], [0])
        self.assertEqual(result['actions']['complete'], 0)
        self.assertEqual(result['numbers']['kept'], 0, '18 must not match 180')
        self.assertIsNone(result['summaryAudit'], 'no inferred entailment score')
        self.assertFalse(result['nativeWorkObserved'])

    def test_condition_loss_does_not_count_as_recall(self):
        self.assertEqual(self.check_item('Send report', 'Nina', 'Friday')['actions']['task'], 0)

    def test_due_in_task_text_does_not_hide_a_missing_deadline(self):
        result = self.check_item('Send report Friday if approved', 'Nina', None)
        self.assertEqual(result['actions']['task'], 1)
        self.assertEqual(result['actions']['due'], 0)

    def test_matching_relationship_is_retained(self):
        self.assertEqual(self.check_item('Send report if approved', 'Nina', 'Friday')['actions']['complete'], 1)

    def test_summary_audit_must_match_delivered_sentences(self):
        summary = {'response': 'The trial has 12 guides. The captions are finished.',
                   'verification': {'excerptFallback': False, 'statements': [
                       {'text': 'The trial has 12 guides.', 'retained': True},
                       {'text': 'The captions are finished.', 'retained': True},
                       {'text': 'Evening tours were approved.', 'retained': False}]}}
        receipt = {'model': 'test', 'summary': summary}
        audit = {'delivered': [{'text': s, 'supported': True} for s in
                              ['The trial has 12 guides.', 'The captions are finished.']],
                 'pruned': [{'text': 'Evening tours were approved.', 'supported': False}]}
        metrics = score(self.meeting, receipt, audit)['summaryMetrics']
        self.assertEqual(metrics['supportedGeneratedSentencesRetained'], 2)
        self.assertEqual(metrics['unsupportedSentencesDelivered'], 0)
        self.assertEqual(metrics['prunedSentences'], 1)
        self.assertTrue(metrics['auditComplete'])
        self.assertTrue(metrics['noRawQuotes'])
        audit['delivered'][0]['text'] = 'Unrelated audit'
        self.assertFalse(score(self.meeting, receipt, audit)['summaryMetrics']['auditComplete'])

    def test_excerpts_do_not_count_as_generated_summary_sentences(self):
        receipt = {'model': 'test', 'summary': {'response':
            '### Source details\n\n> 0:00 Elena\n>\n> The trial has 12 guides.'}}
        metrics = score(self.meeting, receipt)['summaryMetrics']
        self.assertEqual(metrics['generatedSentencesRetained'], 0)
        self.assertTrue(metrics['excerptFallback'])
        self.assertFalse(metrics['noRawQuotes'])
        self.assertIsNone(metrics['unsupportedSentencesDelivered'])

    def test_false_rejections_require_a_hand_audit(self):
        receipt = {'model': 'test', 'summary': {'response': 'The pilot has 24 seats.',
                   'verification': {'excerptFallback': True, 'statements': [
                       {'text': 'The pilot includes 24 seats.', 'retained': False}]}}}
        self.assertIsNone(score(self.meeting, receipt)['summaryMetrics']['paraphraseFalseRejections'])
        audit = {'delivered': [{'text': 'The pilot has 24 seats.', 'supported': True}],
                 'pruned': [{'text': 'The pilot includes 24 seats.', 'supported': True, 'paraphrase': True}]}
        self.assertEqual(score(self.meeting, receipt, audit)['summaryMetrics']['paraphraseFalseRejections'], 1)

    def test_legacy_fallback_retains_the_discarded_draft_for_audit(self):
        receipt = {'model': 'test', 'summary': {'response': '### Source details\n\n> The pilot has 24 seats.'},
                   'summaryCalls': 1, 'trace': [{'text': '{"answer":"The trial offers 24 seats.","lineIds":["L1"]}',
                                               'generatedTokens': 10, 'peakFootprintBytes': 1}]}
        result = score(self.meeting, receipt)
        self.assertEqual(result['summaryCandidates'][0]['text'], 'The trial offers 24 seats.')
        self.assertEqual(result['summaryMetrics']['prunedSentences'], 1)
        self.assertIsNone(result['summaryMetrics']['supportedGeneratedSentencesPruned'])

    def test_draft_audit_excludes_headings_and_canonical_markers(self):
        self.assertEqual(module['draft_sentences']('- Release Plan\n- The pilot has 24 seats (L1). LineIds:['),
                         ['The pilot has 24 seats.'])


if __name__ == '__main__':
    unittest.main()
