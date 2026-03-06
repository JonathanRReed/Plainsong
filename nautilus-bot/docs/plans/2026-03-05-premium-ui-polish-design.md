# Premium UI Polish Pass

Date: 2026-03-05

## Goal

Make Nautilus feel premium, legible, and confident for normal users while still giving technical users enough control to tune the product without hunting through obscure or duplicated settings.

## Product Direction

The product should feel:

- polished rather than utilitarian
- guided rather than overloaded
- local-first and trustworthy
- powerful without reading like an internal control panel

This pass is not only visual. It also removes stale copy, dead UI paths, duplicated settings, and terminology that leaks implementation details.

## Information Architecture

### Primary Navigation

Keep the main navigation centered on user jobs:

- Dashboard
- Projects
- Meetings
- Dictation
- Exports
- Settings

Navigation labels should reflect the user’s mental model, not internal data structures.

### Settings Structure

Settings should move toward:

- General
- Transcription
- AI & Keys
- Privacy & Security
- Storage
- Updates
- License

Per-tab advanced toggles should be retired. Instead, settings should use explicit sections:

- Recommended
- Compatibility
- Power user
- Danger zone

The default view should reveal high-value controls without forcing the user into an “Advanced” hunt.

## Dictation Experience

Dictation should be simplified around the actual user workflow:

### Capture

- hotkey
- hold vs toggle behavior
- insertion mode
- save/copy behavior

### Results

- last transcription
- paste/copy status
- useful metadata only when it adds trust

### Automation

- command mode
- snippets
- presets

Remove any remaining live-preview language or UI. The current supported behavior is insert-on-release, and the product should describe exactly that.

Insertion mode labels should use plain language:

- Auto
- Paste at cursor
- Insert on release
- Clipboard only

## Transcription and Native Setup

Apple Native Speech and Windows Native Speech should remain first-class choices in the main transcription selector. Native setup should be described as readiness, not routing internals.

Show:

- ready
- needs permission
- unsupported here

Avoid:

- exclusive route
- runtime override
- sidecar
- artifact
- fallback policy

unless a technical explanation is genuinely required.

## Copy and Tone

Preferred language:

- transcription
- insert
- save
- meeting notes
- local only
- cloud enabled
- permission needed

Avoid overly technical or stale phrases:

- provider fallback will be attempted
- runtime setup required
- managed by macOS
- live preview
- verifiable memory layer

## Scope of This Pass

This polish pass focuses on:

1. primary navigation and branding copy
2. Dictation page cleanup
3. Settings tab naming and structure cleanup
4. reducing hidden “advanced” dependence
5. removing stale or broken user-facing copy

## Implementation Rules

- Prefer clarity over feature density.
- Keep existing core functionality unless the surface is broken, dead, or duplicative.
- Promote high-value controls out of hidden advanced affordances.
- Keep dangerous or destructive controls visually separated.
- Preserve accessibility and keyboard usability.
- Preserve the existing visual language of the app while making the hierarchy more intentional.

## Expected Outcome

After this pass, a normal user should be able to:

- understand what each tab is for immediately
- configure dictation without reading technical copy
- choose a transcription route without learning internal architecture
- find important settings without opening “advanced” drawers

And a power user should still be able to:

- configure native speech
- tune audio/transcription behavior
- manage providers, keys, models, storage, and privacy settings

without the product feeling cluttered or unstable.

## Competitive Parity Follow-up

The next phase should close the product gap with Superwhisper on daily dictation while keeping Nautilus ahead on meetings, memory, and local-first trust.

### Priority 1: Dictation Modes

Dictation should become mode-driven rather than settings-driven.

Initial presets:

- Voice
- Messages
- Email
- Notes
- Meeting Follow-up
- Custom

Each mode should carry recommended defaults for:

- dictation profile
- insertion mode
- save to Inbox
- copy to clipboard
- command mode

This reduces setup complexity for normal users while preserving full control for technical users.

### Priority 2: Context-Aware Dictation

Dictation should understand more than raw microphone audio. Add support for:

- selected text transforms
- clipboard-aware rewrite flows
- active app context where reliable

The product should be able to answer user jobs like:

- rewrite this selection
- turn this into bullets
- draft a follow-up from what I just copied

instead of only inserting plain dictated text.

### Priority 3: Dictation History and Reprocess

History should become a productivity surface, not only a log.

Add:

- raw transcript vs final inserted text
- rerun with another mode
- clearer timing and insertion status
- easier inspection of snippets, commands, and fallback behavior

### Priority 4: Meetings Advantage

Once dictation parity is in place, Nautilus should widen the gap on meetings with:

- better speaker editing and alias handling
- cleaner summary and action item presentation
- stronger cross-meeting ask/search surfaces
- better export and follow-up flows

## Phase 1 Implementation Sequence

1. Add mode presets to settings and Dictation UI.
2. Promote mode-driven defaults before power-user controls.
3. Surface clear dictation timing and insertion feedback.
4. Add context-aware dictation inputs.
5. Add reprocess-friendly dictation history.

## Shipping Standard

Do not treat this initiative as complete until:

- dictation setup is faster and clearer than manual provider tuning
- stop-to-insert latency is legible and consistent
- daily writing workflows feel competitive with top macOS dictation apps
- meetings remain a clear Nautilus strength
