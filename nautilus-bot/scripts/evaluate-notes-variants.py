#!/usr/bin/env python3
"""Variant robustness eval for local meeting notes.

generate  Build deterministic ASR-style variants of every notes-fidelity fixture.
run       Run the ignored native batch probe on both notes models, sequentially.
score     Score receipts against hand-written meaning annotations.

Run `run` under the repository's build-slot guard. It never downloads weights,
changes admission or opens an app. The scorer's detectors are independent of
the Rust verifier: they read docs/evals/notes-variants-gold.json, not pipeline
flags. Sentences without a detector hit still need a source audit before a
zero-unsupported claim; `score` lists them in auditPool.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import time

APP = Path(__file__).resolve().parents[1]
FIXTURES = APP / 'docs/evals/notes-fidelity-fixtures.json'
GOLD = APP / 'docs/evals/notes-variants-gold.json'
MODELS = [('qwen3-1.7b-q4_k_m', '8'), ('qwen3-4b-instruct-2507-q4_k_m', '16')]

ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
        'nineteen']
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
ORDINAL_ONES = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
                'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
                'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth']
ORDINAL_TENS = {'twentieth': 20, 'thirtieth': 30}
MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
          'october', 'november', 'december']
WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']


def cardinal_words(n):
    if n < 20:
        return ONES[n]
    return TENS[n // 10] + ('' if n % 10 == 0 else '-' + ONES[n % 10])


def ordinal_words(n):
    if n < 20:
        return ORDINAL_ONES[n]
    if n % 10 == 0:
        return {20: 'twentieth', 30: 'thirtieth'}[n]
    return TENS[n // 10] + '-' + ORDINAL_ONES[n % 10]


WORD_NUMBERS = {cardinal_words(n): n for n in range(100)}
WORD_ORDINALS = {ordinal_words(n): n for n in range(1, 32)}
WORD_ORDINALS.update(ORDINAL_TENS)


# ---------------------------------------------------------------- canonical text

def canon_tokens(text):
    """Lowercase words with number words as digits and ordinal suffixes removed."""
    text = text.replace('’', "'").replace('“', '"').replace('”', '"')
    text = re.sub(r"(?i)\bwon't\b", 'will not', text)
    text = re.sub(r"(?i)\bcan't\b", 'can not', text)
    text = re.sub(r"(?i)n't\b", ' not', text)
    text = re.sub(r"(?i)'ll\b", ' will', text)
    text = re.sub(r"(?i)'s\b", '', text)
    text = re.sub(r'(?<=\d),(?=\d{3}\b)', '', text)
    text = re.sub(r'(?<=\d)-(?=[a-z])', ' ', text, flags=re.I)
    words = re.findall(r"[0-9]+(?:\.[0-9]+)?|[a-z]+(?:-[a-z]+)?", text.lower())
    out = []
    for word in words:
        if word in WORD_ORDINALS:
            out.append(str(WORD_ORDINALS[word]))
        elif word in WORD_NUMBERS:
            out.append(str(WORD_NUMBERS[word]))
        elif re.fullmatch(r'[0-9]+(st|nd|rd|th)', word):
            out.append(re.sub(r'(st|nd|rd|th)$', '', word))
        elif '-' in word:
            out.extend(str(WORD_NUMBERS[part]) if part in WORD_NUMBERS else part for part in word.split('-'))
        else:
            out.append(word)
    return out


def has_prefix(tokens, prefix):
    parts = prefix.split()
    if len(parts) > 1:
        return any(all(tokens[i + j].startswith(p) if j == len(parts) - 1 else tokens[i + j] == p
                       for j, p in enumerate(parts)) for i in range(len(tokens) - len(parts) + 1))
    return any(token.startswith(prefix) if not prefix[0].isdigit() else token == prefix for token in tokens)


DATE_PREPOSITIONS = ('on', 'by', 'before', 'until', 'after', 'for', 'from', 'of')
# A spoken self-correction between two dates: "by the 5th, sorry, I mean the
# 6th", "February 20th or rather February 24th", "Thursday no Friday".
CORRECTION_CUES = [('or', 'rather'), ('rather',), ('sorry',), ('i', 'mean'), ('no',), ('actually',), ('wait',),
                   ('make', 'that'), ('scratch', 'that'), ('correction',), ('instead',)]


def without_ordinal_suffixes(tokens):
    """"9th" reads as "9", "th"; the suffix is not a word."""
    return [t for i, t in enumerate(tokens) if not (t in ('st', 'nd', 'rd', 'th') and i > 0 and tokens[i - 1].isdigit())]


def date_spans(tokens):
    """(key, start, end) for weekdays, month days and bare ordinal days."""
    tokens = without_ordinal_suffixes(tokens)
    spans = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        day = lambda k: k < len(tokens) and tokens[k].isdigit() and 1 <= int(tokens[k]) <= 31
        month = lambda k: k < len(tokens) and tokens[k] in MONTHS
        if token in WEEKDAYS:
            # "the Friday rota" names a thing, not a date.
            if not (i > 0 and tokens[i - 1] in ('the', 'a', 'an', 'our', 'my', 'your', 'their', 'his', 'her')):
                spans.append((token, i, i + 1))
        elif month(i) and i + 2 < len(tokens) and tokens[i + 1] == 'the' and day(i + 2):
            # "October the 9th".
            spans.append((token + ' ' + tokens[i + 2], i, i + 3))
            i += 3
            continue
        elif month(i) and day(i + 1):
            spans.append((token + ' ' + tokens[i + 1], i, i + 2))
            i += 2
            continue
        elif day(i) and (i == 0 or tokens[i - 1] in ('the',) + DATE_PREPOSITIONS) and \
                (month(i + 1) or i + 2 < len(tokens) and tokens[i + 1] == 'of' and month(i + 2)):
            # "the 9th of October", "9 October".
            name = tokens[i + 1] if month(i + 1) else tokens[i + 2]
            end = i + 2 if month(i + 1) else i + 3
            spans.append((name + ' ' + token, i - (1 if i > 0 and tokens[i - 1] == 'the' else 0), end))
            i = end
            continue
        elif day(i) and i > 1 and tokens[i - 1] == 'the' and tokens[i - 2] in DATE_PREPOSITIONS + (
                'not', 'wait', 'sorry', 'mean', 'rather', 'actually', 'that', 'no', 'correction'):
            spans.append((token, i - 1, i + 1))
        i += 1
    return spans


def date_keys(tokens):
    """Weekdays, month days and bare ordinal days in a canonical token list,
    without dates the sentence rejects: "by Wednesday, not Monday" and a
    date replaced by a self-correction ("the 5th, sorry, I mean the 6th")."""
    tokens = without_ordinal_suffixes(tokens)
    spans = date_spans(tokens)
    keys = []
    for index, (key, start, end) in enumerate(spans):
        if start > 0 and tokens[start - 1] == 'not' or start > 1 and tokens[start - 2] == 'not' and \
                tokens[start - 1] == 'the':
            continue
        corrected = False
        for later in spans[index + 1:]:
            between = tokens[end:later[1]]
            if len(between) <= 4 and any(tuple(between[k:k + len(cue)]) == cue
                                         for cue in CORRECTION_CUES for k in range(len(between))):
                corrected = True
            break
        if not corrected:
            keys.append(key)
    return keys


# ---------------------------------------------------------------- fixtures and gold

def load_fixtures():
    return json.loads(FIXTURES.read_text())['meetings']


def canonical_terms(commitment):
    """Gold word prefixes as the scorer reads sentences: a number word
    ("second", "two") becomes its digits, as canon_tokens makes it."""
    def canon(term):
        tokens = canon_tokens(term)
        return tokens[0] if len(tokens) == 1 and tokens[0].isdigit() else term
    out = dict(commitment)
    for field in ('verb', 'object', 'condition'):
        if out.get(field):
            out[field] = [canon(term) for term in out[field]]
    return out


def load_gold():
    gold = json.loads(GOLD.read_text())
    by_fixture = {}
    for family, data in gold['families'].items():
        for fixture in data['fixtures']:
            commitments = [canonical_terms(c) for c in data['commitments'] if 'only' not in c or fixture in c['only']]
            by_fixture[fixture] = dict(data, family=family, commitments=commitments)
    return by_fixture


def group_rows(rows):
    """Production analysis grouping, mirrored for passage-level variants."""
    grouped, last_speaker, tracks = [], object(), {}
    for row in rows:
        speaker = row.get('speakerId')
        track = speaker if speaker in ('me', 'them') else None
        candidate = tracks.get(track) if track else (len(grouped) - 1 if grouped and last_speaker == speaker else None)
        current = grouped[candidate] if candidate is not None else None
        if current and row['startTime'] >= current['end'] and row['startTime'] - current['end'] <= 0.5 and \
                row['endTime'] - current['start'] <= 30.0 and len(current['text']) + 1 + len(row['text']) <= 800:
            current['text'] += ' ' + row['text']
            current['end'] = row['endTime']
        else:
            if track:
                tracks[track] = len(grouped)
            grouped.append({'start': row['startTime'], 'end': row['endTime'], 'text': row['text'], 'speaker': speaker})
        last_speaker = speaker
    return grouped


def base_rows(meeting):
    """Rows exactly as the existing native probe builds them."""
    if meeting.get('transcriptSegments'):
        return [dict(row) for row in meeting['transcriptSegments']]
    return [{'id': f's{i}', 'startTime': s['start'], 'endTime': s['end'], 'text': s['text'],
             'speakerId': f"voice_{s['speaker']}" if s.get('speaker') else None, 'confidence': 1.0}
            for i, s in enumerate(meeting['segments'])]


def speaker_names(meeting):
    return {f"voice_{s['speaker']}": s['speaker'] for s in meeting['segments'] if s.get('speaker')}


# ---------------------------------------------------------------- variant transforms

FILLERS = ['um', 'uh', 'um,', 'uh,', 'you know,', 'like,', 'so', 'okay so']
BACKCHANNELS = ['Mm-hmm.', 'Right.', 'Mm.']
MONTH_RE = '|'.join(m.capitalize() for m in MONTHS)
SUBJECT_AHEAD = r"(?=(?:[A-Z][\w]+|I|[Ww]e)(?:\s+will|'ll|\s+won't|\s+agreed|\s+must)\b)"
CONJ = re.compile(r",\s+and\s+" + SUBJECT_AHEAD)
LABEL = re.compile(r"^(?P<label>[A-Z][\w ]{2,40}?[,:]\s+)(?=(?:[Ww]e|I|[A-Z]\w+)(?:\s+will|'ll|\s+won't|\s+agreed|\s+must)\b)")
CONDITION_TAIL = re.compile(r"^(?P<main>.*?\b(?:will|'ll|won't|agreed to|must)\b.*?)(?:,)?\s+(?P<cond>(?:if|unless|until|after)\s+[^,]+?)(?P<end>[.!?])$")


def sentences(text):
    return [s for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s]


def lower_first(text):
    return text if re.match(r"^(?:I\b|I'|[A-Z]{2,}|[A-Z][a-z]+\s+will)", text) else text[:1].lower() + text[1:]


def upper_first(text):
    return text[:1].upper() + text[1:]


def number_forms(text, rng, style):
    """Rewrite dates and small counts in one spoken or written style."""
    def ordinal(match):
        the, number = match.group(1) or '', int(match.group(2))
        if style['ordinal'] == 'words':
            return the + ordinal_words(number)
        if style['ordinal'] == 'bare' and the:
            return the + str(number)
        return the + str(number) + ('th' if 11 <= number % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(number % 10, 'th'))

    def word_ordinal(match):
        number = WORD_ORDINALS[match.group(2).lower()]
        return ordinal(type('M', (), {'group': lambda self, i: [None, match.group(1), str(number)][i]})())

    text = re.sub(r'\b(the\s+)?(\d{1,2})(?:st|nd|rd|th)\b', ordinal, text)
    text = re.sub(r'\b(the\s+)(' + '|'.join(sorted(WORD_ORDINALS, key=len, reverse=True)) + r')\b', word_ordinal, text)

    def month_day(match):
        month, day = match.group(1), int(match.group(2))
        form = style['monthday']
        if form == 'ordinal':
            return f'{month} {day}' + ('th' if 11 <= day <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(day % 10, 'th'))
        if form == 'words':
            return f'{month} {ordinal_words(day)}'
        return f'{month} {day}'

    text = re.sub(r'\b(' + MONTH_RE + r')\s+(\d{1,2})(?:st|nd|rd|th)?\b', month_day, text)
    if style['cardinal'] == 'words':
        # Small standalone counts only: not money, decimals, dates or ranges.
        text = re.sub(r'(?<![\w$.,-])(\d{1,2})(?=\s+(?!seats?\b)[a-z])',
                      lambda m: cardinal_words(int(m.group(1))) if not re.search(
                          r'(' + MONTH_RE + r')\s*$', text[:m.start()]) else m.group(1), text)
    return text


def clause_order(sentence, rng):
    body, end = sentence[:-1], sentence[-1]
    if end not in '.!?':
        return [sentence]
    parts = CONJ.split(body)
    if len(parts) == 2 and rng.random() < 0.5:
        left, right = parts
        label = LABEL.match(left)
        prefix = label.group('label') if label else ''
        left = left[len(prefix):]
        if rng.random() < 0.5:
            return [prefix + right + ', and ' + lower_first(left) + end]
        return [prefix + left + end, ('And ' + right if rng.random() < 0.5 else upper_first(right)) + end]
    if len(parts) == 2:
        return [parts[0] + end, upper_first(parts[1]) + end]
    match = CONDITION_TAIL.match(sentence)
    # Fronting a trailing condition over two commitments ("I'll order the
    # tubes by Tuesday, but I won't pay until ...") would move it onto the
    # first one, so only a single commitment is fronted.
    modals = len(re.findall(r"\b(?:will|won't|must|agreed\s+to|decided\s+to)\b|'ll\b", match.group('main'))) if match else 0
    if match and modals == 1 and not re.search(r'\bonly\s*$', match.group('main')):
        main = match.group('main')
        label = LABEL.match(main)
        prefix = label.group('label') if label else ''
        main = main[len(prefix):]
        return [prefix + upper_first(match.group('cond')) + ', ' + lower_first(main) + match.group('end')]
    return [sentence]


def punctuation(text, rng, p):
    out = []
    for sentence in sentences(text):
        if rng.random() < p * 0.5:
            sentence = sentence.replace(', ', ' ')
        out.append(sentence)
    joined = ''
    for i, sentence in enumerate(out):
        if i == 0:
            joined = sentence
            continue
        roll = rng.random()
        # A bare or comma join would make a trailing or leading condition
        # ambiguous between two commitments. Keep a clause boundary there.
        ambiguous = re.match(r'(?i)(?:only\s+)?(?:if|unless|until|after|once)\b', sentence) or (
            re.search(r'(?i)\b(?:if|unless|until|after)\b[^,;]*[.!?]$', out[i - 1]) and
            re.match(r"(?i)(?:[a-z]+\s+)?(?:will|'ll|won't|agreed|must)\b|(?:we|i)\b", sentence))
        if ambiguous and roll < p * 0.75:
            roll = p * 0.8
        if roll < p * 0.5:
            joined = joined[:-1] + ' ' + lower_first(sentence)
        elif roll < p * 0.75:
            joined = joined[:-1] + ', ' + lower_first(sentence)
        elif roll < p:
            joined = joined[:-1] + ', and ' + lower_first(sentence)
        else:
            joined += ' ' + sentence
    if rng.random() < p * 0.3:
        # ASR often hears a comma as a sentence boundary.
        words = joined.split()
        commas = [at for at in range(1, len(words) - 1) if words[at - 1].endswith(',')]
        if commas:
            at = rng.choice(commas)
            words[at - 1] = words[at - 1][:-1] + '.'
            words[at] = upper_first(words[at])
            joined = ' '.join(words)
    return joined


def casing(text, rng, style, names):
    if style == 'none':
        return text
    keep = {n.lower() for n in names} | {'i', "i'll", "i'm", "i've"}

    def lower_word(word):
        bare = re.sub(r'[^\w\']', '', word)
        return word if bare.lower() in keep or len(bare) > 1 and bare.isupper() else word.lower()
    if style == 'all':
        return ' '.join(lower_word(w) for w in text.split())
    words = text.split()
    for i, word in enumerate(words):
        if (i == 0 or re.search(r'[.!?]$', words[i - 1])) and rng.random() < 0.6:
            words[i] = lower_word(word)
    return ' '.join(words)


def protected_gap(words, i):
    """Never split a number, a date or "only if"."""
    left, right = words[i - 1].lower(), words[i].lower()
    return bool(re.search(r'\d', left + right)) or left.strip(',.') in MONTHS or \
        (left == 'only' and right.startswith('if')) or right.strip(',.') in WEEKDAYS


def fillers_and_repeats(text, rng, p_filler, p_repeat):
    words = text.split()
    out = []
    for i, word in enumerate(words):
        if i and rng.random() < p_filler and not protected_gap(words, i):
            out.append(rng.choice(FILLERS))
        if i and rng.random() < p_repeat and not protected_gap(words, i):
            # A stutter repeats words of the same sentence only.
            span = words[max(0, i - rng.randint(1, 3)):i]
            if not any(re.search(r'[.!?;:]$', w) for w in span):
                out.extend(span)
        out.append(word)
    return ' '.join(out)


def make_variant(meeting, index, seed):
    if index == 0:
        return {'rows': base_rows(meeting), 'transforms': ['exact']}
    rng = random.Random(f'{seed}:{meeting["id"]}:{index}')
    names = meeting['names']
    passages = group_rows(base_rows(meeting))
    other_speakers = sorted({p['speaker'] for p in passages if p['speaker']}) or ['S2']
    style = {
        'ordinal': rng.choice(['digits', 'words', 'bare']),
        'monthday': rng.choice(['plain', 'ordinal', 'words']),
        'cardinal': rng.choice(['digits', 'digits', 'words']),
    }
    p_punct = rng.choice([0.0, 0.3, 0.6])
    p_filler = rng.choice([0.0, 0.04, 0.1])
    p_repeat = rng.choice([0.0, 0.02, 0.06])
    p_clause = rng.choice([0.0, 0.4, 0.8])
    case_style = rng.choice(['none', 'none', 'starts', 'all'])
    p_split = rng.choice([0.0, 0.2, 0.4])
    p_fragment = rng.choice([0.0, 0.15])
    p_backchannel = rng.choice([0.0, 0.2])
    granularity = rng.choice(['word', 'word', 'word', 'phrase', 'sentence'])
    transforms = [f'numbers={style}', f'punctuation={p_punct}', f'fillers={p_filler}', f'repeats={p_repeat}',
                  f'clauseOrder={p_clause}', f'casing={case_style}', f'split={p_split}',
                  f'fragments={p_fragment}', f'backchannels={p_backchannel}', f'rows={granularity}']
    out = []
    for passage in passages:
        text = number_forms(passage['text'], rng, style)
        text = ' '.join(s for sentence in sentences(text)
                        for s in (clause_order(sentence, rng) if rng.random() < p_clause else [sentence]))
        text = punctuation(text, rng, p_punct)
        text = fillers_and_repeats(text, rng, p_filler, p_repeat)
        text = casing(text, rng, case_style, names)
        start, end = passage['start'], max(passage['end'], passage['start'] + 0.5)
        pieces = [text]
        if rng.random() < p_fragment:
            words = text.split()
            if len(words) > 6:
                pieces = [' '.join(words[:rng.randint(len(words) * 2 // 5, len(words) * 4 // 5)])] + pieces
        if rng.random() < p_split:
            words = pieces[-1].split()
            if len(words) > 6:
                at = rng.randint(3, len(words) - 3)
                pieces[-1:] = [' '.join(words[:at]), ' '.join(words[at:])]
        backchannel_after = rng.randrange(len(pieces)) if len(pieces) > 1 and rng.random() < p_backchannel else None
        span = (end - start) / len(pieces)
        for k, piece in enumerate(pieces):
            p_start = start + k * span + (0.6 if k else 0.0)
            p_end = max(p_start + 0.3, start + (k + 1) * span)
            out.append({'start': p_start, 'end': p_end, 'speaker': passage['speaker'], 'text': piece})
            if backchannel_after == k:
                others = [s for s in other_speakers if s != passage['speaker']] or ['S2']
                mid = p_end + 0.05
                out.append({'start': mid, 'end': mid + 0.4, 'speaker': rng.choice(others),
                            'text': rng.choice(BACKCHANNELS)})
    rows = []
    for p_index, passage in enumerate(out):
        words = passage['text'].split()
        if not words:
            continue
        if granularity == 'word':
            chunks = [[w] for w in words]
        elif granularity == 'phrase':
            chunks, at = [], 0
            while at < len(words):
                size = rng.randint(3, 8)
                chunks.append(words[at:at + size])
                at += size
        else:
            chunks = [words]
        duration = (passage['end'] - passage['start']) / len(words)
        at = 0
        for c_index, chunk in enumerate(chunks):
            rows.append({'confidence': 0.88, 'id': f'{meeting["id"]}-v{index}-p{p_index}-c{c_index}',
                         'speakerId': passage['speaker'], 'startTime': round(passage['start'] + at * duration, 3),
                         'endTime': round(passage['start'] + (at + len(chunk)) * duration, 3),
                         'text': ' '.join(chunk)})
            at += len(chunk)
    rows.sort(key=lambda row: (row['startTime'], row['speakerId'] or ''))
    return {'rows': rows, 'transforms': transforms}


def generate(count, seed, only=None):
    variants = []
    for meeting in load_fixtures():
        if only and meeting['id'] not in only:
            continue
        for index in range(count):
            variant = make_variant(meeting, index, seed)
            variants.append({'id': f'{meeting["id"]}--v{index:02d}', 'fixture': meeting['id'], 'index': index,
                             'transforms': variant['transforms'], 'speakerNames': speaker_names(meeting),
                             'transcriptSegments': variant['rows']})
    return variants


# ---------------------------------------------------------------- scoring

CUES = re.compile(r"\b(?:only\s+if|if|unless|until|provided|once|after|(?:as|so)\s+long\s+as|conditional|contingent|"
                  r"dependent|depends?|depending|hinges?|subject\s+to|determines?|determined|pending|relies|rely|"
                  r"requires?|tied\s+to|linked\s+to|prerequisite|condition)\b")
STRONG_CUES = re.compile(r"\b(?:if|unless|until|provided|conditional|contingent|dependent|depends?|depending|"
                         r"hinges?|subject\s+to|determines?|determined|prerequisite|condition)\b")
STATUS = re.compile(r"\b(?:(?:is|are|was|were|has\s+been|have\s+been|remains?|stays?|got|has|have|had)\s+"
                    r"(?:already\s+|still\s+|now\s+|not\s+|yet\s+|been\s+)*"
                    r"(complete|completed|done|finished|pending|unresolved|resolved|approved|confirmed|scheduled|"
                    r"passed|failed|ready|blocked|ongoing|underway|cancell?ed|shipped|reviewed|sent|closed|open|"
                    r"tentative|finali[sz]ed|delayed|outstanding|unconfirmed|uncertain|in\s+progress|on\s+hold)|"
                    r"(pending|unresolved|outstanding|unconfirmed|tentative|in\s+progress|on\s+hold))\b")
PAST_EVENT = re.compile(r"\b(passed|approved|confirmed|completed|finished|shipped|reviewed|sent|failed|cleared|"
                        r"replaced|booked|notified|migrated|updated|renewed|expanded|increased)\b")
CLAUSE_SPLIT = re.compile(r";\s+|:\s+|,?\s+and\s+(?=after\b)|,\s+(?=[A-Z][a-z]+\s+(?:\w+\s+)?(?:will|'ll|won't|must)\b)|"
                          r",\s+(?=(?:(?:the|no|a|an|any)\s+)?[a-z]+\s+(?:must|needs\s+to)\b)|,?\s+and\s+(?=(?:only\s+)?(?:if|unless|until|once|provided|as\s+long\s+as)\b)|"
                          r",\s+so\s+(?=(?:[A-Z][a-z]+|I|we|they)\s+(?:\w+\s+){0,2}?(?:will|'ll|won't|must)\b)|"
                          r"(?<=[a-z0-9])\s+(?=(?:[A-Z][a-z]+|I)\s+(?:will|'ll|won't|must)\b)|,\s+(?=(?:we|I|they|he|she)\s+(?:\w+\s+)?(?:will|'ll|won't|have|has|haven't|hasn't|are|is|must|agreed)\b)|,\s+(?:and|but)\s+(?=(?:[\w']+\s+){1,5}(?:is|are|was|were|will|must|has|have)\b)|,?\s+(?:and|but|while|whereas)\s+(?:(?:so|then|also|um|uh|like),?\s+)*(?=(?:[A-Z][a-z]+|I|we|We|the\s+team|they|they)\b"
                          r"(?:'s)?\s+(?:\w+\s+){0,3}?(?:will|'ll|won't|must|is|are|agreed|decided|has|have|needs?)\b"
                          r"|(?:(?:the|no|a|an|any)\s+)?(?:[a-z]+\s+){1,2}(?:must|will|needs\s+to)\b)")


LEAD_CUE = r'(?:only\s+)?(?:if|unless|until|once|provided(?:\s+that)?|as\s+long\s+as|after)\b'
# Discourse words before a leading condition: "Yes, if Noah sends it, ...".
LEAD_DISCOURSE = r'(?:(?:yes|yeah|okay|ok|so|and|but|right|well|then|sure|now)[,]?\s+)*'
# Where an unpunctuated leading condition ends: the commitment's subject and modal.
LEAD_CLAUSE = re.compile(r"\s+(?=(?:I|we|We|you|he|she|they|[A-Z][a-z]+)(?:'ll|\s+will|\s+won't|\s+must|\s+agreed|\s+can)\b)")


def leading_clauses(sentence):
    """A leading condition applied to the clauses it leads, or None."""
    lead = re.match(r'^\s*' + LEAD_DISCOURSE + '(' + LEAD_CUE + r'[^,]*),\s*(.*)$', sentence, re.I)
    if not lead:
        # "If Sam approves the room plan I'll book the rooms": no comma.
        bare = re.match(r'^\s*' + LEAD_DISCOURSE + '(' + LEAD_CUE + r'.*)$', sentence, re.I)
        split = LEAD_CLAUSE.search(bare.group(1)) if bare else None
        if split:
            condition, rest = bare.group(1)[:split.start()], bare.group(1)[split.end():]
            if condition.strip() and rest.strip():
                return [(condition + ', ' + r, condition) for r in CLAUSE_SPLIT.split(rest)]
        return None
    rest = CLAUSE_SPLIT.split(lead.group(2))
    return [(lead.group(1) + ', ' + r, lead.group(1)) for r in rest]


def clauses(sentence):
    """Independent clauses, each with the leading condition that opens it.

    A leading condition opens the whole sentence or a clause after a split
    ("..., and unless the inspection slips, Aksel will drive ..."); a split
    part that is only a condition leads the next part."""
    whole = leading_clauses(sentence)
    if whole is not None:
        return whole
    out = []
    pending = None
    for part in CLAUSE_SPLIT.split(sentence):
        if pending is not None:
            part = pending + ', ' + part
            pending = None
        led = leading_clauses(part)
        if led is not None:
            out.extend(led)
        elif re.match(r'^\s*' + LEAD_DISCOURSE + LEAD_CUE, part, re.I) and not LEAD_CLAUSE.search(part):
            pending = part
        else:
            out.append((part, None))
    if pending is not None:
        out.append((pending, None))
    return out


def raw_condition_span(clause, leading):
    """(scope text, condition text, cue found). Leading conditions scope the whole sentence."""
    if leading:
        return clause[len(leading):], leading, True
    match = CUES.search(clause.lower())
    if not match:
        return clause, '', False
    before, after = clause[:match.start()], clause[match.end():]
    if re.match(r'determin', match.group(0)):
        # "C determines X": the condition precedes the cue.
        return after, before, True
    return before, after, True


def condition_span(clause, leading):
    scope, cond, cue = raw_condition_span(clause, leading)
    return canon_tokens(scope), canon_tokens(cond), cue


def names_in(tokens, gold_names, aliases):
    found = []
    for i, token in enumerate(tokens):
        token = aliases.get(token, token)
        if token in gold_names:
            found.append((i, token))
    return found


def mentions(commitment, scope):
    return any(has_prefix(scope, v) for v in commitment['verb']) and any(has_prefix(scope, o) for o in commitment['object'])


def negated_near_verb(commitment, scope):
    # "Thursday, not Tuesday, Maren will sign": a "not" before a date
    # rejects the date.
    dated = {start - 1 for _, start, _ in date_spans(scope) if start > 0}
    dated |= {start - 2 for _, start, _ in date_spans(scope) if start > 1 and scope[start - 1] == 'the'}
    scope = [t if not (t == 'not' and k in dated) else 'NOT_DATE' for k, t in enumerate(without_ordinal_suffixes(scope))]
    for i, token in enumerate(scope):
        if any(token.startswith(v) for v in commitment['verb']):
            window = scope[max(0, i - 4):i]
            if any(w in ('not', 'no', 'never', 'without') for w in window):
                return True
    return 'not' in scope and any(scope[i] == 'not' and i + 1 < len(scope) and
                                  any(scope[i + 1].startswith(v) for v in commitment['verb'])
                                  for i in range(len(scope)))


def subject_owner(raw_clause, commitment, scope, gold_names, aliases):
    """A person named as the subject or possessive actor of this commitment's verb."""
    tokens = canon_tokens(raw_clause)
    for at, name in names_in(tokens, gold_names, aliases):
        if at > 0 and tokens[at - 1] in ('to', 'by', 'from', 'with', 'for', 'if', 'until', 'unless', 'when', 'after'):
            continue
        for token in tokens[at + 1:at + 6]:
            if any(token.startswith(v) for v in commitment['verb']):
                return name
            # "Ravi mentioned that irrigation must ..." reports a requirement.
            if token in gold_names or token in ('and', 'but', 'while', 'said', 'says', 'mentioned', 'noted',
                                                 'explained', 'stated', 'reported', 'confirmed', 'that'):
                break
    return None


# Words that describe the source, the process or its quality rather than the
# meeting. A sentence may use one only when the source does.
COMMENTARY = re.compile(
    r"\b(?:transcripts?|transcription|recordings?|recorded|audio|sources?|passages?|excerpts?|lines|line\s+L?\d+|"
    r"phrases?|wording|mentions?|(?:is|are|was|were|been|be)\s+(?:\w+ly\s+)?(?:mentioned|stated|noted|referenced)|"
    r"referenc(?:e|es|ed)|repeat(?:s|ed|edly)|repetitions?|reiterat\w*|"
    r"restat\w*|emphasi[sz]\w*|highlight\w*|underscor\w*|indicat\w*|instances?|occurrences?|"
    r"versions\s+of\s+the|discuss(?:ed|es|ion|ions)|focus(?:ed|es)|conversation|covered|"
    r"consistent(?:ly)?|explicit(?:ly)?|implicit(?:ly)?|clearly|sole(?:ly)?|criteri(?:on|a)|resolution|"
    r"alternatives?|multiple|several|various|numerous|overall|well-defined|clearly\s+defined|"
    r"responsibilities|key\s+(?:dependency|decision|point|commitment)s?)\b", re.I)
QUOTED = re.compile(r"(?:^|[\s(])['‘\"“][^'’\"”]{2,}['’\"”](?=$|[\s.,;:!?)])")
GENERIC_CONDITION = {'if', 'only', 'unless', 'until', 'provided', 'once', 'after', 'as', 'long', 'so', 'the', 'a', 'an',
                     'is', 'are', 'was', 'be', 'been', 'being', 'its', 'it', 'of', 'on', 'upon', 'to', 'that', 'this',
                     'conditional', 'contingent', 'dependent', 'depends', 'depend', 'depending', 'subject', 'pending',
                     'requires', 'require', 'condition', 'hinges', 'tied', 'linked', 'outcome', 'result', 'met',
                     'successfully', 'whether', 'and', 'by', 'for', 'will', 'has', 'have', 'still'}
AUXILIARIES = {'will', 'would', 'shall', 'should', 'must', 'can', 'could', 'may', 'might', 'is', 'are', 'was', 'were',
               'am', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'never', 'also', 'still',
               'already', 'then', 'now', 'just', 'to', 'going', 'agreed', 'decided', 'committed', 'responsible', 'for',
               'in', 'charge', 'of', 'tasked', 'with', 'assigned', 'expected', 'scheduled', 'planned', 'plans',
               'personally', 'first', 'promised', 'offered'}
# Words that restate how a quantity is stated rather than what it counts.
NUMBER_FRAME_WORDS = ('cost', 'price', 'pric', 'charg', 'fee', 'rate', 'stay', 'remain', 'total', 'each', 'per')
# Title-cased function words are casing, not names.
FUNCTION_WORDS = {'will', 'the', 'a', 'an', 'after', 'before', 'by', 'on', 'if', 'and', 'or', 'of', 'to', 'for', 'with',
                  'until', 'once', 'only', 'not', 'is', 'are', 'be', 'in', 'at', 'from'}
# Copied fillers are transcript noise, not words of the claim.
FILLER_WORDS = {'um', 'umm', 'uh', 'like', 'so', 'okay', 'you', 'know', 'mm', 'hmm'}


SPEECH = ('say', 'said', 'state', 'mention', 'note', 'ask', 'provid', 'shar', 'gave', 'outlin', 'told', 'tell', 'suggest', 'propos', 'request', 'confirm', 'explain',
          'express', 'report', 'raise', 'recommend', 'point', 'clarif', 'warn', 'insist', 'offer', 'volunteer',
          'wonder', 'want', 'prefer', 'think', 'believ', 'argu', 'correct', 'admit', 'acknowledg', 'emphasi')


def same_stem(first, second):
    """Inflections of one word: "approval"/"approves", "passing"/"passes"."""
    shared = 0
    while shared < min(len(first), len(second)) and first[shared] == second[shared]:
        shared += 1
    return first == second or shared >= max(4, min(len(first), len(second)) - 3)


def spoken_by(meeting, name):
    words = set()
    for segment in meeting['segments']:
        if (segment.get('speaker') or '').lower() == name:
            words.update(canon_tokens(segment['text']))
    return words


def source_condition_words(meeting, commitment, aliases):
    """Words of every source condition span that states this commitment's condition."""
    words = set()
    for segment in meeting['segments']:
        for sentence in sentences(segment['text']):
            for clause, leading in clauses(sentence):
                _, cond, cue = condition_span(clause, leading)
                if cue and all(has_prefix(cond, t) for t in commitment['condition']):
                    words.update(cond)
                    if segment.get('speaker') and 'i' in cond:
                        words.add(segment['speaker'].lower())
    if commitment['owner']:
        words.add(commitment['owner'].lower())
    return {aliases.get(w, w) for w in words}


def label_only_words(meeting, gold):
    """Words that occur in the source only inside an annotated label."""
    segments = [s['text'] for s in meeting['segments']]
    inside = set()
    for label in gold.get('labels', []):
        inside.update(canon_tokens(label))
        # Only heading positions (a segment or sentence start): "Pricing:" is a
        # label, "the pricing page" is not.
        segments = [re.sub(r'(^|[.!?,:]\s+)' + re.escape(label) + r'\s*[,.:;]?', r'\1 ', text, flags=re.I)
                    for text in segments]
    outside = set(canon_tokens(' '.join(segments)))
    names = {n.lower() for n in gold['names']}
    return {w for w in inside if not any(same_stem(w, o) for o in outside if len(o) > 2)
            and w not in names and len(w) > 2}


def subject_verbs(sentence, gold_names, aliases):
    """(name, verb) for each named person who is a grammatical subject."""
    tokens = canon_tokens(sentence)
    out = []
    for at, name in names_in(tokens, gold_names, aliases):
        before = [t for t in tokens[:at] if t not in FILLER_WORDS]
        if before and before[-1] in ('to', 'by', 'from', 'with', 'for', 'of', 'than', 'about', 'at', 'on', 'in',
                                     'including', 'as', 'via'):
            continue
        # Possessives were dropped by canon_tokens; check this occurrence in
        # the raw text ("that's Lindiwe's file, so Lindiwe should ...").
        occurrence = sum(1 for k, other in names_in(tokens[:at], gold_names, aliases) if other == name)
        raw = list(re.finditer(r"(?i)\b" + re.escape(name) + r"\b(['’]s\b)?", sentence))
        if occurrence < len(raw) and raw[occurrence].group(1):
            continue
        passive = False
        for token in tokens[at + 1:at + 8]:
            if token in ('is', 'are', 'was', 'were', 'be', 'been', 'being'):
                passive = True
                continue
            if token in AUXILIARIES or token in FILLER_WORDS or token in gold_names or aliases.get(token) in gold_names \
                    or token.endswith('ly') or token == name:
                continue
            if token == 'i':
                break
            if passive and (token.endswith('ed') or token in ('sent', 'told', 'given', 'made', 'asked')):
                break
            if token in ('the', 'a', 'an', 'that', 'this', 'it', 'and', 'or', 'but', 'from', 'at', 'of', 'in', 'with',
                         'on') or token.isdigit():
                break
            out.append((name, token))
            break
    return out


def number_parts(sentence):
    """Clause parts for number attachment: commas, coordinators, cues and semicolons."""
    return [p for p in re.split(r"[,;:]\s*|\s+(?:and|but|while|with|plus|only\s+if|if|unless|until|after|as\s+long\s+as)\s+",
                                sentence, flags=re.I) if p.strip()]


def sentence_issues(sentence, gold, source_tokens, source_vocab, meeting=None, quoted=False):
    """Return detector hits for one delivered sentence or action claim."""
    issues = []
    source_text = ' '.join(s['text'] for s in meeting['segments']) if meeting is not None else ''
    if meeting is not None:
        lower_source = source_text.lower()
        for match in COMMENTARY.finditer(sentence):
            if match.group(0).lower() not in lower_source:
                issues.append(('source_commentary', match.group(0)))
                break
        if QUOTED.search(sentence):
            issues.append(('source_commentary', 'quoted phrase'))
        label_words = label_only_words(meeting, gold)
        labelled = sentence
        if quoted:
            # A spoken heading opening a quoted sentence is a heading, not a
            # claim about the sentence.
            for label in gold.get('labels', []):
                labelled = re.sub(r'^\s*' + re.escape(label) + r'\b[\s,.:;]*', '', labelled, flags=re.I)
        canon_sentence = canon_tokens(labelled)
        # Days of dates, stated or rejected, are not quantities.
        date_numbers = {key.split()[-1] for key, _, _ in date_spans(canon_tokens(sentence))}
        # "Not the 8th, the 15th.", "Fine, the 15th then.": a day after "the"
        # that no quantity word follows.
        quantity_words = {t for n in (gold.get('numbers') or []) for t in n['terms']}
        plain = without_ordinal_suffixes(canon_tokens(sentence))
        date_numbers |= {t for k, t in enumerate(plain[1:], 1) if plain[k - 1] == 'the' and t.isdigit()
                         and 1 <= int(t) <= 31 and not (k + 1 < len(plain) and
                                                        any(plain[k + 1].startswith(q) for q in quantity_words))}
        for word in canon_sentence:
            if word in label_words:
                issues.append(('label_entity', word))
                break
        actors = gold.get('actors')
        if actors is not None:
            gold_names = {n.lower() for n in gold['names']}
            allowed = {k.lower(): v for k, v in actors.items()}
            for name, verb in subject_verbs(sentence, gold_names, gold.get('aliases', {})):
                if verb.startswith(SPEECH):
                    # A reported statement needs content the person said.
                    said = spoken_by(meeting, name)
                    # "Rhea confirmed 24 stalls" may itself be reported in the source.
                    reported = re.search(r'(?i)\b' + re.escape(name) + r'\s+(?:' + re.escape(verb[:5]) +
                                         r'|told|said|says|mentioned|reported|confirmed)', source_text)
                    if reported:
                        said |= set(canon_tokens(source_text))
                    after = canon_tokens(sentence.split(re.search(r'(?i)\b' + re.escape(verb), sentence).group(0), 1)[-1]) \
                        if re.search(r'(?i)\b' + re.escape(verb), sentence) else []
                    content = [t for t in after if len(t) > 3 and t not in gold_names and not t.isdigit()
                               and t not in ('date', 'deadline', 'time', 'that', 'this', 'with', 'from')]
                    kept = [t for t in content if any(same_stem(t, w) for w in said)]
                    if content and (not kept or 2 * len(kept) < len(content)):
                        issues.append(('speaker_not_supported', f'{name}:{verb}'))
                elif not any(verb.startswith(v) for v in allowed.get(name, [])):
                    issues.append(('actor_not_supported', f'{name}:{verb}'))
        numbers = gold.get('numbers') or []
        # A number's own words: its annotated terms and the words of its own
        # source clause.
        own_words = {}
        for number in numbers:
            words = set(number['terms']) | set(number.get('restriction', []))
            for segment in meeting['segments']:
                for source_part in re.split(r'(?<=[.!?;])\s+|,\s+(?:and|but)\s+', segment['text']):
                    tokens_part = canon_tokens(source_part)
                    if number['value'] in tokens_part:
                        words |= set(tokens_part)
            own_words[number['value']] = words
        for part in number_parts(sentence):
            tokens = canon_tokens(part)
            for number in numbers:
                if number['value'] not in tokens:
                    continue
                if number['value'] in date_numbers:
                    continue
                others = {t for o in numbers if o is not number for t in o['terms']}
                others |= {t for c in gold['commitments'] for t in c['object'] + c['verb'] if len(t) > 3}
                for token in tokens:
                    if len(token) <= 3 or token.isdigit() or token.startswith(NUMBER_FRAME_WORDS):
                        continue
                    own = any(token.startswith(t) or same_stem(token, t) for t in own_words[number['value']] if len(t) > 2)
                    borrowed = any(token.startswith(t) for t in others)
                    if borrowed and not own:
                        issues.append(('number_relation', f"{number['value']}:{token}"))
                        break
            for number in numbers:
                # Two quantities with one value ("12 pounds for students",
                # "at least 12 singers"): check the one whose terms the part uses.
                same = [o for o in numbers if o['value'] == number['value']]
                if len(same) > 1 and max(same, key=lambda o: sum(any(t.startswith(w) for t in tokens)
                                                                 for w in o['terms'])) is not number:
                    continue
                restriction = [w for t in number.get('restriction', []) for w in canon_tokens(t)]
                kept = [t for t in restriction if any(same_stem(t, w) for w in canon_tokens(sentence))]
                if restriction and number['value'] in tokens and number['value'] not in date_numbers and \
                        2 * len(kept) < len(restriction):
                    issues.append(('restriction_dropped', number['value']))
    commitments = gold['commitments']
    aliases = gold.get('aliases', {})
    gold_names = {n.lower() for n in gold['names']}
    canon = canon_tokens(sentence)
    # Numbers and entities are checked over the whole sentence.
    pronoun_one = re.search(r"(?i)\b(?:no|any|some|every|each)\s?one\b|\bone\s+of\b", sentence)
    for token in canon:
        if token == '1' and pronoun_one:
            continue
        if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', token) and token not in source_tokens:
            issues.append(('number_changed', token))
    for word in re.findall(r"(?<![.!?]\s)(?<!^)\b[A-Z][a-zA-Z]+\b", sentence.strip()):
        if word.lower() in FUNCTION_WORDS:
            continue
        if word.lower() not in source_vocab and aliases.get(word.lower()) not in source_vocab:
            issues.append(('invented_entity', word))
    for clause, leading in clauses(sentence):
        scope, cond, cue = condition_span(clause, leading)
        clause_tokens = canon_tokens(clause)
        cond_matches = [c for c in commitments if c['condition'] and all(has_prefix(cond, t) for t in c['condition'])]
        strong = bool(STRONG_CUES.search(clause.lower())) or bool(leading)
        mentioned = [c for c in commitments if mentions(c, scope)]
        for c in mentioned:
            own = c['condition'] and all(has_prefix(cond, t) for t in c['condition'])
            # The claim's condition may only contain the source condition's own words.
            if own and meeting is not None:
                allowed = source_condition_words(meeting, c, aliases)
                # A spoken heading run into the condition ("until Hollis
                # has read it and market stall:") names nothing.
                label_tokens = {w for label in gold.get('labels', []) for w in canon_tokens(label)}
                extra = [t for t in cond if t not in GENERIC_CONDITION and t not in FILLER_WORDS and not t.isdigit()
                         and t not in label_tokens
                         and len(t) > 2
                         and not any(same_stem(t, a) for a in allowed if len(a) > 2)]
                if extra:
                    issues.append(('condition_added', f"{c['id']}:{extra[0]}"))
            if cue and not own and cond_matches:
                issues.append(('condition_scope_transfer', c['id'] + '<-' + cond_matches[0]['id']))
            elif cue and strong and not own and c['condition'] is None and len([t for t in cond if len(t) > 3]) >= 2:
                issues.append(('invented_condition', c['id']))
            elif c['condition'] and not own and not c['negated']:
                issues.append(('condition_dropped', c['id']))
            # "won't X until C" is "X only after C".
            deferred = c['negated'] and re.search(r'\b(?:only\s+(?:after|once|when)|not\s+before|before|until)\b',
                                                   clause.lower())
            if negated_near_verb(c, scope) != c['negated'] and not deferred:
                issues.append(('negation_flip', c['id']))
            owner = subject_owner(clause, c, scope, gold_names, aliases)
            expected = c['owner'].lower() if c['owner'] else None
            if owner and owner != expected:
                issues.append(('owner_changed', f"{c['id']}:{owner}"))
            allowed = set(c['dates']) | set(c.get('conditionDates', []))
            for key in date_keys(scope):
                if key not in allowed and not any(key in set(o['dates']) for o in mentioned if o is not c):
                    issues.append(('date_changed', f"{c['id']}:{key}"))
        raw_scope = raw_condition_span(clause, leading)[0].lower()
        # A future passive ("will be shipped") or a reported statement
        # ("confirmed that ...") asserts no current status.
        raw_scope = re.sub(r"\b(?:will|would|to|must|should|can|could|may|might)\s+(?:not\s+)?(?:be|have\s+been)\s+(?:\w+ed|sent|done|made|built|taken|given|written|shown|held|kept|run)\b", ' ', raw_scope)
        raw_scope = re.sub(r"\b(?:confirmed|said|stated|noted|agreed|explained|mentioned)\s+(?=(?:that|he|she|they|it|we|i|would|will)\b|(?:\w+\s+){1,5}(?:is|are|has|have|will|must)\b)", ' ', raw_scope)
        hits = [(m.group(0), m.group(1) or m.group(2)) for m in STATUS.finditer(raw_scope)]
        # A clause the source states word for word is not invented.
        clause_canon = canon_tokens(clause)
        source_canon = canon_tokens(source_text) if source_text else []
        verbatim = len(clause_canon) >= 3 and any(source_canon[i:i + len(clause_canon)] == clause_canon
                                                  for i in range(len(source_canon)))
        hits += [(m.group(0), m.group(1)) for m in PAST_EVENT.finditer(raw_scope)]
        for text, status_word in hits:
            word = canon_tokens(status_word)
            ok = any(any(word and word[0].startswith(s) for s in status['status']) and
                     all(has_prefix(clause_tokens, t) for t in status['subject']) and
                     not (status.get('conditionOnly') and not cue)
                     for status in gold['statuses'])
            # "has not approved" style statements are statuses too; a source
            # negation of the same subject keeps them supported.
            # "Dexter double-booked two crews": the source states this status
            # about a subject the clause also names.
            subject_words = [t for t in canon_tokens(raw_scope[:raw_scope.find(text)] if text in raw_scope else '')
                             if len(t) > 3]
            stated = any(status_word.lower() in sentence_source.lower() and
                         any(w in canon_tokens(sentence_source) for w in subject_words)
                         for sentence_source in re.split(r'(?<=[.!?])\s+', source_text))
            if not ok and not verbatim and not stated:
                issues.append(('invented_status', text))
    seen = set()
    return [i for i in issues if not (i in seen or seen.add(i))]


QUOTE_BULLET = re.compile(r'^- (?P<attr>.*?)“(?P<text>.*)”\s*$')
FIRST_PERSON = [(r"\bI'll\b", '{} will'), (r"\bI'm\b", '{} is'), (r"\bI've\b", '{} has'), (r"\bI'd\b", '{} would'),
                (r'\bI\b', '{}'), (r'\bme\b', '{}'), (r'\bmy\b', "{}'s"), (r'\bmyself\b', '{}')]


def extractive_sentences(response):
    """Claims of a quoted recap: each bullet's source sentence, with first-person
    singular words resolved to the attributed speaker, and the topics line.
    None when the response is not a quoted recap."""
    lines = [line.strip() for line in (response or '').splitlines() if line.strip()]
    bullets = [QUOTE_BULLET.match(line) for line in lines if line.startswith('- ')]
    if not bullets or not all(bullets):
        return None
    out = []
    for line in lines:
        if line.startswith('#'):
            continue
        if line.startswith('Topics: '):
            out.append(line[len('Topics: '):])
            continue
        match = QUOTE_BULLET.match(line)
        if not match:
            out.append(line)
            continue
        text = match.group('text')
        name = re.match(r'^([^():]+?) \(\d', match.group('attr'))
        if name:
            text = resolve_first_person(text, name.group(1))
        out.append(text)
    return out


def prose_sentences(response):
    if not response:
        return []
    quoted = extractive_sentences(response)
    if quoted is not None:
        return quoted
    prose = '\n'.join(line for line in response.splitlines()
                      if line.strip() and not line.lstrip().startswith(('#', '>')))
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', prose) if s.strip()]


def covers_key(sentence, commitment, gold):
    for clause, leading in clauses(sentence):
        scope, cond, cue = condition_span(clause, leading)
        if not mentions(commitment, scope):
            continue
        if commitment['condition'] and not (cue and all(has_prefix(cond, t) for t in commitment['condition'])):
            continue
        if commitment['dates'] and not set(date_keys(scope)) & set(commitment['dates']):
            continue
        if negated_near_verb(commitment, scope) != commitment['negated']:
            continue
        if commitment['owner']:
            owner = subject_owner(clause, commitment, scope, {n.lower() for n in gold['names']}, gold.get('aliases', {}))
            if owner != commitment['owner'].lower():
                continue
        return True
    return False


EVIDENCE_LINE = re.compile(r'^(?P<attr>.*?)“(?P<text>.*)”$')


def evidence_quotes(item):
    """(speaker or None, sentence) for each attributed evidence line, or None."""
    lines = [line.strip() for line in (item.get('evidence') or '').splitlines() if line.strip()]
    matches = [EVIDENCE_LINE.match(line) for line in lines]
    if not lines or not all(matches):
        return None
    out = []
    for match in matches:
        name = re.match(r'^([^():]+?) \(\d', match.group('attr'))
        out.append((name.group(1) if name else None, match.group('text')))
    return out


def verbatim_item(item):
    """An action item whose text is its quoted source sentences, each
    attributed in its evidence."""
    quotes = evidence_quotes(item)
    return bool(quotes) and ' '.join(text for _, text in quotes) == (item.get('task') or '').strip()


def resolve_first_person(text, name):
    # "I mean" is a discourse marker, not a statement about the speaker; a
    # stray "I" before a name ("sorry, I June, sorry") states nothing.
    text = re.sub(r'\bI mean\b', 'MEAN_MARKER', text)
    text = re.sub(r'\bI(?=\s+[A-Z][a-z])', 'STRAY_MARKER', text)
    for pattern, replacement in FIRST_PERSON:
        text = re.sub(pattern, replacement.format(name), text)
    return text.replace('MEAN_MARKER', 'I mean').replace('STRAY_MARKER', 'I')


def item_sentences(item):
    """A verbatim item's sentences, first-person words resolved to each
    sentence's own speaker, as the recap reads a quote."""
    return [resolve_first_person(text, speaker) if speaker else text for speaker, text in evidence_quotes(item)]


def stated_dates(sentence):
    """Dates a sentence states, reading a bare "the 28th" as a day too: a
    short correction ("Not the 21st, the 28th.") names the day that way."""
    tokens = without_ordinal_suffixes(canon_tokens(sentence))
    rejected = {k for i, k in enumerate(tokens[1:], 1) if tokens[i - 1] == 'not'} | \
               {k for i, k in enumerate(tokens[2:], 2) if tokens[i - 2] == 'not' and tokens[i - 1] == 'the'}
    dates = set(date_keys(tokens)) | {t for t in tokens if t in WEEKDAYS}
    dates |= {t for i, t in enumerate(tokens[1:], 1) if tokens[i - 1] == 'the' and t.isdigit() and 1 <= int(t) <= 31}
    return dates - rejected


def correction_tail(sentence):
    """The words after a sentence's last self-correction cue ("... Thursday,
    actually make that Friday ..."), or ''."""
    tokens = without_ordinal_suffixes(canon_tokens(sentence))
    ends = [k + len(cue) for cue in CORRECTION_CUES for k in range(len(tokens))
            if tuple(tokens[k:k + len(cue)]) == cue]
    return ' '.join(tokens[max(ends):]) if ends else ''


def correction_shown(flagged, sentence, earlier, later, gold):
    """Hits on a verbatim sentence that the item itself answers, in order:
    - a date change on a commitment whose own date a later sentence of the
      item, or the same sentence after a self-correction cue, states;
    - an owner change on a commitment that a later sentence of the item
      gives to its own owner ("so Lindiwe should upload it");
    - a dropped condition on a commitment that an earlier sentence of the
      item states with its condition (a correction restating it shortly)."""
    for kind, detail in flagged:
        commitment = next((c for c in gold['commitments'] if c['id'] == detail.split(':')[0]), None)
        if not commitment:
            return False
        if kind == 'date_changed':
            if not any(set(commitment['dates']) & stated_dates(s) for s in later + [correction_tail(sentence)]):
                return False
        elif kind == 'owner_changed':
            # "Cormac will upload the style guide." then "... so Lindiwe should
            # upload it." / "Fine, Lindiwe will upload it.": a later sentence
            # makes the commitment's own owner the subject of its verb.
            owner = (commitment['owner'] or '').lower()
            if not owner or not any(
                    any(tokens[k] == owner and any(t.startswith(v) for t in tokens[k + 1:k + 4]
                                                   for v in commitment['verb'])
                        for k in range(len(tokens)))
                    for tokens in (canon_tokens(s) for s in later)):
                return False
        elif kind == 'condition_dropped':
            if not any(mentions(commitment, canon_tokens(e)) and
                       all(has_prefix(canon_tokens(e), t) for t in commitment['condition']) for e in earlier):
                return False
        else:
            return False
    return True


def action_claim(item):
    owner = item.get('assignee') or 'We'
    text = (item.get('task') or '').strip().rstrip('.')
    text = re.sub(r'^(?:do\s+not|don\'t)\s+', 'not ', text, flags=re.I)
    deadline = item.get('deadline')
    claim = f'{owner} will {text}'
    if deadline and not set(deadline_keys(deadline)) & set(date_keys(canon_tokens(claim))):
        claim += f' by {deadline}'
    return claim + '.'


def deadline_keys(text):
    """Date keys of a deadline field such as "the 14th", "Friday" or "March 6"."""
    text = re.sub(r'(?i)^\s*(?:by|on|before)\s+', '', text or '')
    if not text:
        return []
    if not re.match(r'(?i)^(?:the|next|this|' + '|'.join(MONTHS + WEEKDAYS) + r')\b', text):
        text = 'the ' + text
    return date_keys(canon_tokens('on ' + text))


def action_matches(expected, item, gold):
    canon = canon_tokens(item.get('task') or '')
    if not all(has_prefix(canon, re.sub(r'(es|s|ed)$', '', t.lower()) if len(t) > 4 else t.lower())
               for t in [w for term in expected['task'] for w in canon_tokens(term)]):
        return None
    aliases = gold.get('aliases', {})
    owner = item.get('assignee')
    owner = aliases.get(owner.lower(), owner.lower()) if owner else None
    owner_ok = owner == (expected['owner'].lower() if expected['owner'] else None)
    due = item.get('deadline') or ''
    expected_dates = {k for d in expected['due'] for k in deadline_keys(d)}
    due_keys = set(deadline_keys(due))
    due_ok = bool(due_keys & expected_dates) if expected['due'] else not due
    return {'owner': owner_ok, 'due': due_ok, 'complete': owner_ok and due_ok}


def score_receipt(receipt, meeting, gold):
    source_text = ' '.join(s['text'] for s in meeting['segments'])
    source_tokens = set(canon_tokens(source_text))
    source_vocab = {w.lower() for w in re.findall(r'[A-Za-z]+', source_text)}
    source_vocab |= {s['speaker'].lower() for s in meeting['segments'] if s.get('speaker')}
    summary = receipt.get('summary', {})
    actions = receipt.get('actions', {})
    errors = [part for part, data in [('summary', summary), ('actions', actions)] if 'error' in data]
    response = summary.get('response', '')
    excerpt = response.lstrip().startswith('### Source details') or bool(
        re.search(r'^\s*>', response, re.M))
    sentences_out = [] if excerpt else prose_sentences(response)
    items = actions.get('items', [])
    quoted = extractive_sentences(response) is not None
    prose_issues = [{'text': s, 'issues': sentence_issues(s, gold, source_tokens, source_vocab, meeting, quoted=quoted)}
                    for s in sentences_out]
    action_issues = []
    for item in items:
        if not verbatim_item(item):
            claim = action_claim(item)
            action_issues.append({'text': claim, 'issues': sentence_issues(claim, gold, source_tokens, source_vocab,
                                                                           meeting), 'explained': False})
            continue
        # A quoted item: each sentence is one claim, read as the recap reads a
        # quote. A stale date counts as explained only when a later sentence
        # of the same item states the commitment's corrected date.
        claims = item_sentences(item)
        hits = [sentence_issues(c, gold, source_tokens, source_vocab, meeting, quoted=True) for c in claims]
        explained = any(hits) and all(not h or correction_shown(h, claims[at], claims[:at], claims[at + 1:], gold)
                                      for at, h in enumerate(hits))
        action_issues.append({'text': ' '.join(claims), 'issues': [h for hit in hits for h in hit],
                              'explained': explained})
    keys = [c for c in gold['commitments'] if c['key']]
    key_hits = {c['id']: any(covers_key(s, c, gold) for s in sentences_out) for c in keys}
    # A quoted recap may show a commitment and then the sentence that corrects
    # its date ("show both in order"): covered when one quote states the
    # commitment with its condition and one of the next two quotes states the
    # corrected date and not the commitment's superseded one.
    strict_key_hits = dict(key_hits)
    if extractive_sentences(response) is not None:
        for c in keys:
            if key_hits[c['id']] or not c['dates']:
                continue
            undated = dict(c, dates=[])
            for at, sentence in enumerate(sentences_out):
                if not covers_key(sentence, undated, gold):
                    continue
                for later in sentences_out[at + 1:at + 3]:
                    if stated_dates(later) & set(c['dates']):
                        key_hits[c['id']] = True
                        break
                if key_hits[c['id']]:
                    break
    expected_actions = meeting['actions']
    used, action_hits = set(), []
    for expected in expected_actions:
        best = None
        for at, item in enumerate(items):
            if at in used:
                continue
            match = action_matches(expected, item, gold)
            if match and (best is None or match['complete'] and not best[1]['complete']):
                best = (at, match)
        if best:
            used.add(best[0])
        action_hits.append({'task': expected['task'], 'found': best is not None,
                            'complete': bool(best and best[1]['complete'])})
    return {
        'variant': receipt.get('variant'), 'fixture': meeting['id'], 'model': receipt.get('model'),
        'errors': errors, 'excerptFallback': excerpt,
        'prose': prose_issues, 'actions': action_issues,
        'unsupportedProse': sum(bool(p['issues']) for p in prose_issues),
        'unsupportedActions': sum(bool(a['issues']) for a in action_issues),
        'unexplainedActions': sum(bool(a['issues']) and not a['explained'] for a in action_issues),
        # Items quoted as unclear: listed, but the meeting left their scope,
        # owner or date unclear.
        'unclearActions': sum(bool(item.get('unclear')) for item in items),
        'keyDecisions': {'covered': sum(key_hits.values()), 'total': len(key_hits), 'detail': key_hits,
                         'strictCovered': sum(strict_key_hits.values())},
        'actionCoverage': {'complete': sum(a['complete'] for a in action_hits), 'total': len(action_hits),
                           'detail': action_hits},
    }


def aggregate(scores, audit):
    by_model = {}
    for s in scores:
        m = by_model.setdefault(s['model'], {'cases': 0, 'errors': 0, 'excerptFallback': 0,
                                             'sentences': 0, 'actionItems': 0, 'unsupported': {},
                                             'unsupportedSentences': 0, 'unsupportedActionItems': 0,
                                             'unexplainedActionItems': 0, 'unclearActionItems': 0,
                                             'strictKey': 0,
                                             'auditUnsupported': 0, 'unaudited': set(),
                                             'key': [0, 0], 'action': [0, 0], 'byFixture': {}})
        f = m['byFixture'].setdefault(s['fixture'], {'cases': 0, 'unsupported': 0, 'key': [0, 0], 'action': [0, 0]})
        m['cases'] += 1
        f['cases'] += 1
        m['errors'] += bool(s['errors'])
        m['excerptFallback'] += s['excerptFallback']
        for kind, claims in [('prose', s['prose']), ('action', s['actions'])]:
            for claim in claims:
                m['sentences' if kind == 'prose' else 'actionItems'] += 1
                verdict = audit.get(claim['text'])
                bad = bool(claim['issues']) or verdict == 'unsupported'
                if claim['issues']:
                    for issue, _ in claim['issues']:
                        m['unsupported'][issue] = m['unsupported'].get(issue, 0) + 1
                elif verdict == 'unsupported':
                    m['auditUnsupported'] += 1
                elif verdict is None:
                    m['unaudited'].add(claim['text'])
                if bad:
                    m['unsupportedSentences' if kind == 'prose' else 'unsupportedActionItems'] += 1
                    f['unsupported'] += 1
                    if kind == 'action' and not claim.get('explained'):
                        m['unexplainedActionItems'] += 1
        m['unclearActionItems'] += s.get('unclearActions', 0)
        m['strictKey'] += s['keyDecisions']['strictCovered']
        for target, key in [(m['key'], 'keyDecisions'), (f['key'], 'keyDecisions'),
                            (m['action'], 'actionCoverage'), (f['action'], 'actionCoverage')]:
            data = s[key]
            target[0] += data['covered'] if key == 'keyDecisions' else data['complete']
            target[1] += data['total']
    for m in by_model.values():
        m['unaudited'] = sorted(m['unaudited'])
        m['keyCoverage'] = m['key'][0] / m['key'][1] if m['key'][1] else None
        m['actionCoverageRate'] = m['action'][0] / m['action'][1] if m['action'][1] else None
    return by_model


def score_dir(directory, audit_path):
    meetings = {m['id']: m for m in load_fixtures()}
    gold = load_gold()
    audit = {}
    if audit_path and audit_path.exists():
        for entry in json.loads(audit_path.read_text())['sentences']:
            audit[entry['text']] = 'supported' if entry['supported'] else 'unsupported'
    scores = []
    for path in sorted(directory.glob('*--*--v*.json')):
        receipt = json.loads(path.read_text())
        fixture = receipt['fixture']
        scores.append(score_receipt(receipt, meetings[fixture], dict(gold[fixture], names=meetings[fixture]['names'])))
    return scores, aggregate(scores, audit)


def audit_pack(directories, fixtures_and_gold):
    """Unique sentences no detector flagged, grouped by meeting with its source.

    The pack holds only source text and delivered claims, so a reviewer can
    judge each sentence blind: no pipeline reasons, no detector output.
    """
    global FIXTURES, GOLD
    meetings_out = {}
    for directory, (fixtures, gold_path) in zip(directories, fixtures_and_gold):
        FIXTURES, GOLD = fixtures, gold_path
        scores, _ = score_dir(directory, None)
        meetings = {m['id']: m for m in load_fixtures()}
        for score in scores:
            meeting = meetings[score['fixture']]
            entry = meetings_out.setdefault(score['fixture'], {
                'meeting': score['fixture'],
                'source': [f"{s.get('speaker') or 'Unnamed speaker'}: {s['text']}" for s in meeting['segments']],
                'sentences': []})
            for claim in score['prose'] + score['actions']:
                if not claim['issues'] and claim['text'] not in entry['sentences']:
                    entry['sentences'].append(claim['text'])
    for entry in meetings_out.values():
        entry['sentences'].sort()
    return sorted(meetings_out.values(), key=lambda entry: entry['meeting'])


# ---------------------------------------------------------------- native runner

def run(args):
    args.out.mkdir(parents=True, exist_ok=True)
    variants = generate(args.count, args.seed, set(args.fixture) if args.fixture else None)
    payload = json.dumps({'seed': args.seed, 'count': args.count, 'variants': variants}).encode()
    path = args.out / 'variants.json'
    if path.exists() and path.read_bytes() != payload:
        raise RuntimeError('Refusing to replace a different variants.json in ' + str(args.out))
    path.write_bytes(payload)
    if args.test_binary is None:
        with (args.out / 'probe-build.log').open('a') as log:
            subprocess.run(['nice', '-n', '10', 'env', 'CARGO_BUILD_JOBS=4', 'bun', 'scripts/cargo-sidecar.ts', 'test',
                            '--locked', '--lib', '--no-run'], cwd=APP, stdout=log, stderr=log, check=True)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=APP, text=True).strip()
    helper = APP / 'dist-native/plainsong-text-helper'
    manifest = {'sourceHead': head, 'variantsSha256': hashlib.sha256(payload).hexdigest(),
                'fixtureSha256': hashlib.sha256(FIXTURES.read_bytes()).hexdigest(),
                'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
                'dirty': subprocess.check_output(['git', 'status', '--porcelain'], cwd=APP, text=True),
                'testBinarySha256': hashlib.sha256(args.test_binary.read_bytes()).hexdigest() if args.test_binary else None}
    (args.out / f'manifest-{head[:12]}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for model, gb in MODELS:
        if args.model and model != args.model:
            continue
        host = subprocess.check_output(['memory_pressure'], text=True)
        (args.out / f'{model}.host-{time.time_ns()}.txt').write_text(host)
        env = dict(os.environ, NOTES_PROBE_MODELS=str(args.models), NOTES_PROBE_MODEL=model,
                   NOTES_PROBE_VARIANTS=str(path), NOTES_PROBE_OUT_DIR=str(args.out),
                   PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=gb)
        env.pop('PLAINSONG_SIMULATE_AVAILABLE_GB', None)
        env.pop('PLAINSONG_SIMULATE_AVAILABLE_BASELINE_BYTES', None)
        probe = ['llm::notes_probe::native_notes_variant_probe', '--ignored', '--exact', '--test-threads=1', '--nocapture']
        # A prebuilt test binary runs without cargo, so no build occurs and no
        # build slot is held while the model generates.
        command = (['nice', '-n', '10', str(args.test_binary)] + probe if args.test_binary else
                   ['nice', '-n', '10', 'env', 'CARGO_BUILD_JOBS=4', 'bun', 'scripts/cargo-sidecar.ts', 'test',
                    '--locked', '--lib'] + probe[:1] + ['--'] + probe[1:])
        with (args.out / f'{model}.log').open('a') as log:
            result = subprocess.run(command, cwd=APP / 'rust-sidecar' if args.test_binary else APP, env=env,
                                    stdout=log, stderr=log)
        if result.returncode:
            raise RuntimeError(f'Native variant probe failed for {model}; see {args.out / (model + ".log")}')
        for receipt_path in args.out.glob(f'{model}--*.json'):
            receipt = json.loads(receipt_path.read_text())
            if receipt.get('sourceHead') is None:
                receipt.update(sourceHead=head, variantsSha256=manifest['variantsSha256'],
                               helperSha256=manifest['helperSha256'])
                receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')


def markdown(aggregates):
    lines = ['| Model | Cases | Errors | Excerpt fallback | Sentences | Action items | Unsupported sentences | '
             'Unsupported action items (unexplained) | Key-decision coverage | Strict | Action coverage |',
             '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for model, m in sorted(aggregates.items()):
        strict = m['strictKey'] / m['key'][1] if m['key'][1] else 0
        lines.append(f"| {model} | {m['cases']} | {m['errors']} | {m['excerptFallback']} | {m['sentences']} | "
                     f"{m['actionItems']} | {m['unsupportedSentences']} | {m['unsupportedActionItems']} "
                     f"({m['unexplainedActionItems']}) | "
                     f"{m['key'][0]}/{m['key'][1]} ({100 * (m['keyCoverage'] or 0):.1f}%) | "
                     f"{m['strictKey']}/{m['key'][1]} ({100 * strict:.1f}%) | "
                     f"{m['action'][0]}/{m['action'][1]} ({100 * (m['actionCoverageRate'] or 0):.1f}%) |")
    return '\n'.join(lines)


def main():
    global FIXTURES, GOLD
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    gen = sub.add_parser('generate')
    gen.add_argument('--count', type=int, default=30)
    gen.add_argument('--seed', default='plainsong-notes-variants-v1')
    gen.add_argument('--fixture', action='append')
    gen.add_argument('--out', type=Path, required=True)
    runner = sub.add_parser('run')
    runner.add_argument('--count', type=int, default=30)
    runner.add_argument('--seed', default='plainsong-notes-variants-v1')
    runner.add_argument('--fixture', action='append')
    runner.add_argument('--model', choices=[m for m, _ in MODELS])
    runner.add_argument('--models', type=Path, required=True)
    runner.add_argument('--out', type=Path, required=True)
    runner.add_argument('--test-binary', type=Path,
                        help='Prebuilt lib test binary from `cargo-sidecar.ts test --locked --lib --no-run`')
    packer = sub.add_parser('audit-pack', help='Unflagged sentences with their meeting source, for a blind audit')
    packer.add_argument('--set', nargs=3, action='append', metavar=('RECEIPTS', 'FIXTURES', 'GOLD'), required=True,
                        type=Path)
    packer.add_argument('--out', type=Path, required=True)
    scorer = sub.add_parser('score')
    scorer.add_argument('receipts', type=Path)
    scorer.add_argument('--audit', type=Path)
    scorer.add_argument('--out', type=Path)
    for sub_parser in (gen, runner, scorer, packer):
        sub_parser.add_argument('--fixtures', type=Path, default=APP / 'docs/evals/notes-fidelity-fixtures.json',
                                help='Fixture file; the held-out set is docs/evals/notes-variants-holdout-fixtures.json')
        sub_parser.add_argument('--gold', type=Path, default=APP / 'docs/evals/notes-variants-gold.json',
                                help='Meaning annotations for --fixtures')
    args = parser.parse_args()
    FIXTURES, GOLD = args.fixtures.resolve(), args.gold.resolve()
    if args.command == 'generate':
        variants = generate(args.count, args.seed, set(args.fixture) if args.fixture else None)
        args.out.write_text(json.dumps({'seed': args.seed, 'count': args.count, 'variants': variants}))
        print(f'{len(variants)} variants')
    elif args.command == 'run':
        run(args)
    elif args.command == 'audit-pack':
        pack = audit_pack([entry[0] for entry in args.set], [(entry[1].resolve(), entry[2].resolve()) for entry in args.set])
        args.out.write_text(json.dumps({'meetings': pack}, indent=2) + '\n')
        print(sum(len(entry['sentences']) for entry in pack), 'sentences in', len(pack), 'meetings')
    else:
        scores, aggregates = score_dir(args.receipts, args.audit)
        result = {'aggregates': aggregates, 'scores': scores}
        if args.out:
            args.out.write_text(json.dumps(result, indent=2) + '\n')
        print(markdown(aggregates))
        for model, m in sorted(aggregates.items()):
            print(model, json.dumps(m['unsupported']), 'unclearItems', m['unclearActionItems'],
                  'auditUnsupported', m['auditUnsupported'],
                  'unaudited', len(m['unaudited']))


if __name__ == '__main__':
    main()
