#!/usr/bin/env python3
"""Checks for the notes variant generator and its independent detectors."""
import importlib.util
import json
from pathlib import Path
import re
import unittest

APP = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('variants', APP / 'scripts/evaluate-notes-variants.py')
variants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(variants)


def gold_for(fixture):
    meetings = {m['id']: m for m in variants.load_fixtures()}
    meeting = meetings[fixture]
    source = ' '.join(s['text'] for s in meeting['segments'])
    vocab = {w.lower() for w in re.findall(r'[A-Za-z]+', source)}
    vocab |= {s['speaker'].lower() for s in meeting['segments'] if s.get('speaker')}
    gold = dict(variants.load_gold()[fixture], names=meeting['names'])
    return meeting, gold, set(variants.canon_tokens(source)), vocab


class GeneratorTests(unittest.TestCase):
    def test_variants_are_deterministic_and_cover_every_fixture(self):
        first = variants.generate(30, 'test-seed')
        second = variants.generate(30, 'test-seed')
        self.assertEqual(json.dumps(first), json.dumps(second))
        fixtures = {v['fixture'] for v in first}
        self.assertEqual(fixtures, {m['id'] for m in variants.load_fixtures()})
        self.assertTrue(all(sum(v['fixture'] == f for v in first) == 30 for f in fixtures))

    def test_variant_zero_is_the_exact_fixture(self):
        for meeting in variants.load_fixtures():
            exact = variants.make_variant(meeting, 0, 'seed')['rows']
            self.assertEqual(exact, variants.base_rows(meeting))

    def test_variants_keep_meaning_words_and_aside_gaps(self):
        for variant in variants.generate(30, 'test-seed', {'b23-aside-normal', 'release-handoff'}):
            text = ' '.join(row['text'] for row in variant['transcriptSegments']).lower()
            if variant['fixture'] == 'release-handoff':
                self.assertIn('only if', text)
            meeting = next(m for m in variants.load_fixtures() if m['id'] == variant['fixture'])
            for aside in meeting.get('asideRanges', []):
                self.assertFalse(any(aside['startTime'] <= row['startTime'] and row['endTime'] <= aside['endTime']
                                     for row in variant['transcriptSegments']))

    def test_number_forms(self):
        self.assertEqual(variants.deadline_keys('the fourteenth'), ['14'])
        self.assertEqual(variants.deadline_keys('the 14'), ['14'])
        self.assertEqual(variants.deadline_keys('march sixth'), ['march 6'])
        self.assertEqual(variants.date_keys(variants.canon_tokens('take the Friday rota')), [])
        self.assertEqual(variants.date_keys(variants.canon_tokens('by Wednesday, not Monday')), ['wednesday'])


class QuotedActionTests(unittest.TestCase):
    def test_date_phrases_and_in_sentence_corrections(self):
        keys = lambda text: variants.date_keys(variants.canon_tokens(text))
        self.assertEqual(keys('on the 9th of October'), ['october 9'])
        self.assertEqual(keys('October the ninth'), ['october 9'])
        self.assertEqual(keys('by the 5th of June, sorry, I mean the 6th of June'), ['june 6'])
        self.assertEqual(keys('by February 20th, or rather February 24th'), ['february 24'])
        self.assertEqual(keys('by Thursday, no, Friday'), ['friday'])
        self.assertEqual(variants.deadline_keys('the 9th of October'), ['october 9'])

    def test_a_condition_opening_a_later_clause_leads_it(self):
        parts = variants.clauses('Good, and unless the inspection slips, Aksel will drive the van on Thursday.')
        self.assertEqual(parts[-1][1], 'unless the inspection slips')

    def test_quoted_items_resolve_each_speaker_and_explain_shown_corrections(self):
        item = {'task': "I'll repair the scull by the 21st. Not the 21st, the 28th.", 'assignee': 'Hector',
                'evidence': "Hector (0:40): “I'll repair the scull by the 21st.”\nImogen (0:50): “Not the 21st, the 28th.”"}
        self.assertTrue(variants.verbatim_item(item))
        self.assertEqual(variants.item_sentences(item),
                         ['Hector will repair the scull by the 21st.', 'Not the 21st, the 28th.'])
        gold = {'commitments': [{'id': 'repair', 'dates': ['28'], 'condition': None, 'verb': ['repair'],
                                 'object': ['scull']}]}
        self.assertTrue(variants.correction_shown([('date_changed', 'repair:21')], 'Hector will repair the scull by the 21st.',
                                                  [], ['Not the 21st, the 28th.'], gold))
        self.assertFalse(variants.correction_shown([('date_changed', 'repair:21')], 'Hector will repair the scull by the 21st.',
                                                   [], [], gold))
        self.assertFalse(variants.verbatim_item(dict(item, task='Repair the scull by the 28th.')))


class DetectorTests(unittest.TestCase):
    def issues(self, fixture, sentence):
        meeting, gold, tokens, vocab = gold_for(fixture)
        return [kind for kind, _ in variants.sentence_issues(sentence, gold, tokens, vocab, meeting)]

    def test_b25_condition_transfers_are_detected(self):
        for sentence in [
            'The commitment to review the notes is conditional on the memory gate passing.',
            "The memory gate's outcome determines both the beta shipment and Priya's review of the notes.",
            'If the memory gate passes, the beta will ship on the 14th and Priya will review the notes.',
        ]:
            self.assertIn('condition_scope_transfer', self.issues('b25-full-16gb', sentence), sentence)

    def test_faithful_sentences_pass(self):
        for sentence in [
            'We agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes.',
            'Priya will review the notes.',
            'The beta will be shipped on the fourteenth if the memory gate passes.',
        ]:
            self.assertEqual(self.issues('b25-full-16gb', sentence), [], sentence)
        self.assertEqual(self.issues('workshop-schedule', 'Noah will send the room plan by Wednesday, not Monday.'), [])

    def test_other_meaning_changes_are_detected(self):
        self.assertIn('condition_dropped', self.issues('b25-full-16gb', 'We agreed to ship the beta on the 14th.'))
        self.assertIn('negation_flip', self.issues('renewal-terms', 'Dev will migrate data after Ben approves the appendix.'))
        self.assertIn('owner_changed', self.issues('b25-full-16gb', 'Priya will ship the beta on the 14th if the memory gate passes.'))
        self.assertIn('date_changed', self.issues('b25-full-16gb', 'Priya will review the notes on the 15th.'))
        self.assertIn('invented_status', self.issues('b25-full-16gb', 'The memory gate passed.'))

    def test_round2_classes_are_detected(self):
        cases = [
            ('conditional-beta', "The commitment to ship the beta is conditional on the memory gate passing and Priya's "
                                 'review of the notes.', 'condition_added'),
            ('b25-full-16gb', 'The beta will be shipped on the 14th if the memory gate and other conditions are met.',
             'condition_added'),
            ('conditional-beta', 'The memory gate pass condition is explicitly stated across multiple lines.',
             'source_commentary'),
            ('conditional-beta', "The phrase 'the 14th' is consistently referenced as the shipment date.",
             'source_commentary'),
            ('b24-full-16gb', 'The owners and responsibilities are clearly defined, with Priya responsible for '
                              'reviewing the notes.', 'source_commentary'),
            ('b25-full-16gb', 'The commitment is to ship the fixture beta on the 14th if the memory gate passes.',
             'label_entity'),
            ('b25-full-16gb', 'The owner is Plainsong, and the deadline is the 14th.', 'label_entity'),
            ('release-handoff', 'Mara proposes adding offline search as a suggestion, not a task.',
             'speaker_not_supported'),
            ('release-handoff', 'Mara is piloting a system with 24 seats.', 'actor_not_supported'),
            ('renewal-terms', 'The 80-seat price is $29 per seat per month with monthly billing at $32.',
             'restriction_dropped'),
            ('workshop-schedule', 'The budget for the room plan is $900, not $1,900.', 'number_relation'),
            ('garden-sensors', 'The Elm garden has 16 sensors in the north bed.', 'number_relation'),
        ]
        for fixture, sentence, expected in cases:
            self.assertIn(expected, self.issues(fixture, sentence), sentence)

    def test_round2_faithful_restatements_pass(self):
        cases = [
            ('release-handoff', 'Nina suggested adding offline search, but it is not a task for this release.'),
            ('release-handoff', 'Leo mentioned the export test still has 3 failures.'),
            ('release-handoff', 'Mara will ship version 2.8 on Friday, contingent on Nina approving the export report.'),
            ('renewal-terms', 'The proposed 80-seat price is $29 per seat per month only with an annual contract.'),
            ('renewal-terms', 'Monthly billing stays at $32.'),
            ('garden-sensors', 'The north bed has 5 dry sensors, and the south bed has 2.'),
            ('b25-full-16gb', 'The commitment is to ship the beta on the 14th if the memory gate passes, and the '
                              'review of the notes is assigned to Priya.'),
        ]
        for fixture, sentence in cases:
            self.assertEqual(self.issues(fixture, sentence), [], sentence)

    def test_key_decision_coverage_needs_condition_and_date(self):
        _, gold, _, _ = gold_for('b25-full-16gb')
        ship = next(c for c in gold['commitments'] if c['id'] == 'ship')
        self.assertTrue(variants.covers_key('We agreed to ship the beta on the 14th if the memory gate passes.', ship, gold))
        self.assertFalse(variants.covers_key('The commitment to ship the beta is conditional on the memory gate passing.', ship, gold))


class QuotedRecapTests(unittest.TestCase):
    def test_quoted_recap_claims_resolve_first_person_to_the_speaker(self):
        response = ('Topics: export report.\n\n### Action items\n'
                    '- Leo (0:27): \u201cI\'ll send my report by Tuesday after I rerun the checks.\u201d\n'
                    '- 0:40: \u201cI can help.\u201d')
        self.assertEqual(variants.prose_sentences(response), [
            'export report.',
            "Leo will send Leo's report by Tuesday after Leo rerun the checks.",
            'I can help.',
        ])
        self.assertIsNone(variants.extractive_sentences('Leo will send the report.'))

    def test_leading_conditions_after_discourse_words_or_without_a_comma(self):
        for sentence in ('Yes, if Noah sends the final version, Sam will review the room plan by Thursday.',
                         'If Noah sends the final version Sam will review the room plan by Thursday.'):
            clauses = variants.clauses(sentence)
            self.assertEqual(len(clauses), 1, sentence)
            self.assertIn('noah sends', clauses[0][1].lower(), sentence)



class RoundThreeReadingTests(unittest.TestCase):
    """Scorer readings fixed in the third extractive round, on synthetic gold."""

    def gold(self):
        return {
            'names': ['Beatrix', 'Leopold', 'Felix', 'Solveig'],
            'labels': [],
            'statuses': [],
            'actors': {'Beatrix': ['agree'], 'Leopold': ['find'], 'Felix': ['print', 'has'],
                       'Solveig': ['print']},
            'numbers': [
                {'value': '12', 'terms': ['pound', 'student'], 'restriction': ['student']},
                {'value': '12', 'terms': ['choir', 'singer'], 'restriction': ['least']},
                {'value': '15', 'terms': ['pound', 'member'], 'restriction': ['member']},
            ],
            'commitments': [variants.canonical_terms(c) for c in [
                {'id': 'surgery', 'owner': None, 'verb': ['open'], 'object': ['surgery'],
                 'condition': ['leopold', 'find', 'second', 'nurse'], 'dates': ['october 9'],
                 'negated': False, 'key': True, 'action': True},
                {'id': 'plan', 'owner': 'Solveig', 'verb': ['print'], 'object': ['plan'],
                 'condition': None, 'dates': ['thursday'], 'negated': False, 'key': False, 'action': True},
            ]],
        }

    def meeting(self, text):
        return {'segments': [{'text': text, 'speaker': 'Beatrix'}]}

    def issues(self, sentence, source):
        gold = self.gold()
        vocab = {w.lower() for w in re.findall(r'[A-Za-z]+', source)}
        return variants.sentence_issues(sentence, gold, set(variants.canon_tokens(source)), vocab,
                                        self.meeting(source), quoted=True)

    def test_number_words_in_gold_conditions_read_like_the_sentence(self):
        gold = self.gold()
        surgery = gold['commitments'][0]
        self.assertTrue(variants.covers_key(
            'We agreed to open the surgery from October the ninth, but only if Leopold can find a second nurse.',
            surgery, gold))

    def test_a_restriction_is_checked_on_the_quantity_the_part_names(self):
        source = 'Tickets are 12 pounds for students. Felix will record it only if the choir has at least 12 singers.'
        hits = self.issues('Felix will record it only if the choir has at least 12 singers.', source)
        self.assertNotIn(('restriction_dropped', '12'), hits)
        self.assertIn(('restriction_dropped', '12'), self.issues('Tickets are 12 pounds.', source))

    def test_a_day_after_the_is_not_a_quantity(self):
        source = 'Membership is 15 pounds for members. Not the 8th, the 15th. Fine, the 15th then.'
        self.assertEqual(self.issues('Not the 8th, the 15th.', source), [])
        self.assertEqual(self.issues('Fine, the 15th then.', source), [])

    def test_a_possessive_name_is_not_a_subject(self):
        source = "No, that's Solveig's file, so Solveig should print it."
        hits = self.issues(source, source)
        self.assertFalse([hit for hit in hits if hit[0] == 'actor_not_supported'], hits)

    def test_an_owner_correction_later_in_the_item_explains_the_first_owner(self):
        gold = self.gold()
        flagged = [('owner_changed', 'plan:felix')]
        later = ["No, that's Solveig's file, so Solveig should print it.", 'Fine, Solveig will print it by Thursday.']
        self.assertTrue(variants.correction_shown(flagged, 'Felix will print the seating plan by Thursday.', [],
                                                  later, gold))
        self.assertFalse(variants.correction_shown(flagged, 'Felix will print the seating plan by Thursday.', [],
                                                   ['The hall opens at nine.'], gold))

    def test_a_trailing_condition_is_fronted_only_over_one_commitment(self):
        rng = variants.random.Random(1)
        two = "I'll order the chains by Tuesday, but I won't pay the invoice until Corin checks the stock."
        for _ in range(20):
            self.assertFalse(any(out.startswith('Until') for out in variants.clause_order(two, rng)))
        one = "I won't pay the invoice until Corin checks the stock."
        self.assertTrue(any(variants.clause_order(one, variants.random.Random(seed))[0].startswith('Until')
                            for seed in range(20)))


if __name__ == '__main__':
    unittest.main()
