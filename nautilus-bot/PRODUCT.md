# Plainsong Product Context

register: product

## Purpose

Plainsong is a desktop speech app for people who want fast dictation, trustworthy insertion, and bot-free meeting capture without sending every workflow through hosted cloud infrastructure. Dictation is the hero surface. Meetings are the second surface, centered on capture, transcript review, summaries, action items, follow-up drafts, and retrieval.

## Users

Primary users are solo operators, builders, consultants, writers, and technical professionals who switch between messaging, notes, docs, IDEs, browsers, and meetings all day. They need the product to feel calm under pressure, quick to operate by keyboard, and honest about what is local and what is cloud-backed.

## Position

Plainsong should feel like a precise desktop instrument, not a generic SaaS dashboard. It competes with polished dictation products on speed, insertion confidence, modes, snippets, and correction workflows. It competes with meeting tools on bot-free capture, consent clarity, transcript-first review, and practical follow-through. Its strongest lane is hybrid local-first dictation plus meeting memory for macOS today, with Windows on the roadmap.

## Tone

Use plain, concrete language. Prefer "insert", "transcribe", "record", "meeting notes", "local-first", "cloud enabled", and "permission needed". Avoid implementation leaks such as route internals, fallback policy, sidecar wording, and broad capability claims the product can't back up in practice.

## Product Principles

- Electron is the chosen desktop shell, with the React renderer and Rust sidecar.
- Dictation stays first. Meetings deepen the product without taking over the app.
- The default path is local-first, with optional bring-your-own-key cloud providers.
- Every status should tell the user what is happening now and what they can do next.
- Power features must be discoverable without turning the app into an internal console.
- Public claims follow reality. Describe what the app actually does, not what it aspires to.
- Trust UX matters as much as raw model breadth.
- Meeting recaps quote what was said. A model may choose and group transcript sentences, but it never writes recap text; action items quote the source sentences of commitments the parser fully understands, ending with the latest correction, and show an owner or due date only when the final sentence states it.

## Dictation quality target

Typeless is the main dictation benchmark. Compare final text on the same
recordings and destination apps, including self-corrections, names, numbers,
negation, conditions, and longer thoughts. Measure manual corrections and
stop-to-insertion time. Feature coverage alone does not establish parity.

A short processing pause is acceptable when cleanup improves the result.
Preserve the speaker's meaning and voice. Distinguish conservative automatic
cleanup from an explicitly selected rewrite. Keep the original text available
when a model fails, times out, or cannot perform the requested operation.

Local models remain free and usable without an account or subscription.
Cloud providers are optional. ChatGPT plan access is a separate, text-only
desktop preview through the officially supported sign-in flow. Its source
integration is wired; real account and installed-app qualification remain open.

## Anti-References

- Marketing landing page patterns inside the product shell.
- Decorative analytics cards that do not help a user act.
- Dense provider jargon on primary workflows.
- Hidden failure states, silent fallbacks, and ambiguous recording or insertion status.
- Repeated identical cards that make important readiness signals look interchangeable.
