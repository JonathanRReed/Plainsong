# pyannote community-1 voiceprint calibration, 2026-10-21

Thresholds for remembered voices when pyannote community-1 separates
speakers (`COMMUNITY1_THRESHOLDS` in
`rust-sidecar/src/diarization/voiceprints.rs`).

## What is compared

A signature is one vector per community-1 speaker: the VBx
responsibility-weighted mean of that speaker's WeSpeaker ResNet34
embeddings (the centroid pyannote assigns windows with), length-normalized
(`community1/voiceprint.rs`, `SignatureSpace::Raw`). It costs no extra
inference. Speakers with fewer than 10 clean windows get none.

Signatures are stored under the model id `pyannote_community1`, so they are
never compared with ECAPA-TDNN or any other model's.

## Data and method

- `community1-eval` (release build with Core ML, branch `opus/pyannote-c1`)
  over AMI ES2004a-d, IS1009a-d, TS3003a-d and EN2002a-d (headset mix) and
  ES2004a, ES2004b, IS1009a, TS3003a, EN2002a (far-field Array1-01): 21
  recordings, 16 people.
- Each community-1 speaker is labelled with the AMI speaker holding most of
  its exclusive-turn time (median purity 0.83).
- Pairs only between different meetings (two microphones of one meeting
  never pair): 172 same-speaker, 3,254 different-speaker.
- Thresholds are 0.01 steps: the smallest with at most 1%, 0.1% and 0 false
  accepts. Identification enrolls one profile per person from the first
  headset meeting of each series and matches every speaker of the other
  meetings the way `match_cluster` does (best score at least `accept`, ahead
  of the runner-up by 0.05).
- Script and raw output:
  `artifacts/continuation-2026-10-20/opus-pyannote-c1/scripts/voiceprint_calibrate.py`,
  `.../opus-pyannote-c1/voiceprint/` (local evaluation folder).

## Result (speakers with at least 10 clean windows)

clusters: 86 (min windows 10, min purity 0.0); meetings 16, speakers 16, purity median 0.83
| space | within n | between n | within min / median | between max / p99 | EER | accept @<=1% FA (TA) | @<=0.1% FA (TA) | @0 FA (TA) |
|---|---|---|---|---|---|---|---|---|
| raw | 172 | 3254 | 0.218 / 0.894 | 0.532 / 0.426 | 4.2% @ 0.32 | 0.43 (91.9%) | 0.50 (90.1%) | 0.54 (89.5%) |
| unit | 172 | 3254 | 0.245 / 0.890 | 0.711 / 0.458 | 3.6% @ 0.35 | 0.47 (93.0%) | 0.61 (87.8%) | 0.72 (86.6%) |
| plda | 172 | 3254 | 0.215 / 0.899 | 0.650 / 0.552 | 6.2% @ 0.41 | 0.56 (90.7%) | 0.65 (87.8%) | 0.66 (87.2%) |
| pldaw | 172 | 3254 | 0.444 / 0.926 | 0.813 / 0.718 | 6.8% @ 0.60 | 0.72 (89.0%) | 0.81 (83.7%) | 0.82 (82.6%) |


Identification (profiles from each series' first headset meeting; match like match_cluster, margin 0.05)
| space | accept | right | wrong | no suggestion |
|---|---|---|---|---|
| raw | 0.43 (<= 1% FA) | 53/55 | 0/55 | 2/55 |
| raw | 0.50 (<= 0.1% FA) | 52/55 | 0/55 | 3/55 |
| raw | 0.54 (<= 0% FA) | 52/55 | 0/55 | 3/55 |
| unit | 0.47 (<= 1% FA) | 53/55 | 0/55 | 2/55 |
| unit | 0.61 (<= 0.1% FA) | 49/55 | 0/55 | 6/55 |
| unit | 0.72 (<= 0% FA) | 49/55 | 0/55 | 6/55 |
| plda | 0.56 (<= 1% FA) | 51/55 | 1/55 | 3/55 |
| plda | 0.65 (<= 0.1% FA) | 51/55 | 0/55 | 4/55 |
| plda | 0.66 (<= 0% FA) | 51/55 | 0/55 | 4/55 |
| pldaw | 0.72 (<= 1% FA) | 51/55 | 1/55 | 3/55 |
| pldaw | 0.81 (<= 0.1% FA) | 51/55 | 0/55 | 4/55 |
| pldaw | 0.82 (<= 0% FA) | 50/55 | 0/55 | 5/55 |

`raw` is the shipped space. Chosen thresholds:

| | value | different-speaker pairs at or above | same-speaker pairs kept |
|---|---|---|---|
| accept | 0.43 | 30 / 3,254 (0.9%) | 91.9% (cross-microphone 87.3%) |
| auto_apply | 0.54 | 0 / 3,254 | 89.5% (cross-microphone 85.7%) |
| margin | 0.05 | design rule shared with every model | |

## Limits

AMI is 16 people in four rooms, recorded with the same equipment. A
profile enrolled on one microphone and matched on another kept fewer
same-speaker pairs (87.3% against 91.9% at `accept`). The impure speakers
community-1 sometimes produces (a cluster holding two people) are included,
because the product meets them too.
