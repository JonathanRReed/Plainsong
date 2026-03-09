# Best Ideas Product Hardening Design

Date: 2026-03-09

## Goal

Push Nautilus closer to the best parts of Superwhisper, Granola, and the strongest open-source alternatives without destabilizing the current release candidate.

This pass focuses on:
- permanent, obvious setup and repair entry points
- stronger provider/model readiness checks
- better separation between dictation-grade and meeting-grade routes
- clearer first-run and recovery states for users

It does not attempt a brand-new meeting audio architecture in the same pass.

## Product Direction

### Dictation

Dictation should optimize for:
- speed
- confidence
- insertion reliability
- low-friction recovery

Superwhisper is the reference point here: the app should feel ready quickly, the delivery path should be obvious, and the user should always know how to repair setup issues.

### Meetings

Meetings should optimize for:
- reliability
- route correctness
- transcript trustworthiness
- explicit setup requirements

Granola and Buzz are the reference points here: weaker or native-live engines should not be treated as meeting-capable, and meeting setup needs a clear, guided path.

## Recommended Approach

Adopt the strongest immediately-transferable ideas:

1. Permanent `Setup` workspace
   - canonical home for onboarding, repair, model/runtime checks, and meeting guidance

2. Provider/model doctor
   - tell the user whether a route is:
     - ready for dictation
     - ready for meetings
     - missing files
     - missing runtime
     - incompatible for meetings

3. Stronger meeting-grade enforcement
   - native dictation routes and weak local models remain dictation-only
   - meetings require a meeting-capable provider/model pair

4. Better startup and recovery polish
   - stable dictation popup timing
   - less confusing first-run readiness messaging
   - clearer re-entry points for fixing permissions and meetings later

## Concrete Changes

### Setup Surface

- Add a first-class `Setup` destination in app navigation.
- Add a smaller setup summary card on the dashboard.
- Keep onboarding modular:
  - full onboarding
  - fix dictation
  - set up meetings

### Provider/Model Readiness

- Refresh runtime probes after downloads complete.
- Surface missing files and setup actions directly in Setup.
- Distinguish provider eligibility from model eligibility.
- Mark meeting-ineligible models explicitly instead of treating “exists in options” as sufficient.

### Dictation Polish

- Make popup timer/session state sticky within a session and reset cleanly between sessions.
- Ensure overlay visibility recovers when a non-idle phase is active.
- Reduce misleading “downloaded but not actually usable” states by rechecking runtime immediately.

## Validation

This pass is considered complete when:
- setup is easy to find from both the sidebar and dashboard
- provider downloads immediately refresh readiness status
- dictation popup timing behaves consistently across sessions
- tests and packaged builds pass cleanly

## Deferred Work

Not included in this pass:
- full dual-track meeting transcription architecture
- post-call separation/diarization rewrite
- Apple paid signing/notarization
