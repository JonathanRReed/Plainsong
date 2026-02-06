Nautilus Design Doc v1.0

Goal: “Super Whisper + Granola,” meaning fast, global dictation capture plus meeting-grade recording, transcription, organization, and export, with forensic clarity.

⸻

1) Product definition

Core identity

Nautilus is the verifiable memory layer. It captures reality, timestamps it, secures it, and makes it queryable.

Non-goals
	•	Not a chat personality.
	•	Not an autonomous agent.
	•	Not a note-taking toy.

Primary promise

Verifiable, encrypted, time-stamped capture with predictable outputs.

Brand keywords

Verifiable, immutable, time-stamped, encrypted, diarized, offline.

⸻

2) User goals and use cases

Primary use cases
	1.	Dictation capture

	•	Global hotkey, speak, text appears where the cursor is.
	•	Near-zero UI. No “assistant chat.”

	2.	Meeting capture

	•	Mic-only or mic + system audio.
	•	Clear consent indicators.
	•	High quality transcription and diarization.

	3.	Post-meeting outputs

	•	Summary bullets.
	•	Action items.
	•	Decisions.
	•	Dates and commitments.
	•	Export to Slack or PDF.

Secondary use cases
	•	Search across your recordings.
	•	Build project timelines.
	•	Compliance-friendly retention and audit exports.

⸻

3) Brand and UX principles

Vibe

Forensic clarity. Nautilus is an impartial observer.

UX principles
	•	Cold storage first: file explorer, not chat.
	•	Strong state signaling: blue idle and review; orange capture and high-intent actions.
	•	High data density: professional tools, not spacious consumer UI.
	•	Verifiability: timestamps, source audio references, and logs.

⸻

4) Visual language

Control palette

Blue (Trusted, Passive)
	•	App idle.
	•	Reviewing stored transcripts.
	•	Progress indicators for safe background work.

Orange (Consent, Active, High-intent)
	•	Recording active.
	•	Processing that changes state (analysis, export).
	•	Unlocking edits.

Typography

Inter or Geist. No stylized “hacker” fonts.

UI density

Compact spacing by default with a “Comfort” toggle.

⸻

5) Information architecture

Top-level navigation
	•	Dashboard
	•	Projects
	•	Recordings
	•	Exports
	•	Settings

Dashboard (“Cold Storage”)
	•	Left: Projects tree
	•	Center: Timeline + Recording list + Transcript viewer
	•	Right: Context panel (attendees, summary, queries)

⸻

6) Functional architecture

A) Input: Capture Engine

Dictation mode
	•	Global hotkey press-and-hold.
	•	UI: small orange pill overlay (top-right).
	•	Behavior:
	•	Hold to record.
	•	Release to stop.
	•	Transcribe and inject text at cursor.
	•	Requirements:
	•	Very low latency.
	•	No permanent artifact unless user enables “Save dictations.”

Meeting mode
	•	Modes:
	•	Mic only.
	•	Mic + system audio.
	•	Consent signaling:
	•	Orange border around window when recording.
	•	Badge: “System Audio Active” when enabled.
	•	Optional audible chime on start/stop.
	•	Capture details:
	•	Store raw audio.
	•	Store timestamps.
	•	Store device metadata.

B) Processing: Local Stack

Transcription (STT)
	•	Two profiles:
	•	Speed: Whisper Turbo.
	•	Accuracy: Whisper Large.
	•	UI:
	•	Blue progress bar.
	•	Estimated time.
	•	Queue visibility.

Speaker diarization
	•	On by default for meetings.
	•	Output:
	•	Speaker labels (S1, S2) with optional rename.
	•	Confidence indicator per segment.

Analysis (LLM)
	•	Name: “Analysis.”
	•	Interaction model: Query, not chat.
	•	Examples:
	•	“List key dates mentioned.”
	•	“Extract decisions.”
	•	“Find open questions.”
	•	“Generate meeting minutes in template X.”
	•	Output rules:
	•	Must cite transcript spans (time ranges) for claims.
	•	If uncertain, label as uncertain.

C) Organization: Vault

Projects
	•	Standard tree: Client A, Internal, Personal.
	•	Recordings are items with:
	•	Title
	•	Time
	•	Participants
	•	Tags
	•	Source type (dictation or meeting)

Security
	•	Encrypted SQLite.
	•	Optional per-project passphrase.
	•	Read-only default on finalized transcripts.
	•	Orange “Unlock” to edit transcript text.

Audit log
	•	Local append-only text log.
	•	Events:
	•	Recording start/stop
	•	System audio enabled
	•	Transcription started/finished
	•	Analysis started/finished
	•	Export target + result
	•	Enterprise feature: signed log and export bundle.

⸻

7) UX flows

Flow 1: Dictation
	1.	User holds hotkey
	2.	Orange pill appears
	3.	Audio captured
	4.	Release stops capture
	5.	STT runs
	6.	Text inserted at cursor
	7.	Optional: dictation saved to project inbox

Flow 2: Meeting capture
	1.	User clicks “Record”
	2.	Consent moment: choose Mic and optional System Audio
	3.	Orange border + badges appear
	4.	Waveform runs in real time
	5.	Stop recording
	6.	Audio saved
	7.	STT begins (blue progress)
	8.	Transcript appears with timestamps
	9.	User clicks Analyze (orange)
	10.	Summary and action items populate

Flow 3: Export to Mantisbot and Slack
	1.	User selects Export
	2.	Consent moment: target workspace/channel, format, redaction level
	3.	Preview payload
	4.	Confirm (orange)
	5.	Log written
	6.	Export executed

⸻

8) Output formats

Exports
	•	Markdown minutes
	•	PDF minutes
	•	JSON bundle (audio hash, transcript, diarization, metadata, logs)
	•	Slack message template

Templates
	•	“Standup summary”
	•	“Client meeting minutes”
	•	“Sales call recap”
	•	“Incident review”

⸻

9) Integrations

Mantisbot

Primary enterprise bridge.
	•	Nautilus exports structured artifacts to Mantisbot for action in Slack.
	•	Include:
	•	Summary
	•	Action items
	•	Decisions
	•	Dates
	•	Source references (time ranges)

Krillbot

Personal bridge.
	•	Export to clipboard or local notes.
	•	Optional: add to personal memory store.

Slack (direct)

Optional direct export path.
	•	Admin-gated in enterprise mode.
	•	Preview and logging required.

⸻

10) Technical design

Frontend
	•	React + Tailwind + shadcn/ui
	•	Compact data-dense components
	•	Keyboard-first navigation

Desktop runtime
	•	Tauri v2 (Rust)
	•	OS permissions: mic, system audio capture

AI sidecar
	•	Python managed by Tauri
	•	Components:
	•	STT worker
	•	Diarization worker
	•	LLM analysis worker
	•	Queue manager

Storage
	•	Encrypted SQLite
	•	File storage for audio blobs with content hashing

Performance targets (initial)
	•	Dictation: text appears within 1–3 seconds after release for short utterances
	•	Meeting transcription: begins immediately after stop; incremental rendering preferred

⸻

11) Compliance and privacy posture

Defaults
	•	Local-only storage.
	•	No cloud upload unless explicitly enabled.
	•	Visible indicators for mic and system audio capture.

Controls
	•	Retention policy per project
	•	Export bundles for audit
	•	Redaction mode for shared outputs

⸻

12) Decisions locked for v1

Incremental transcription

We will support incremental transcription during recording (streaming/rolling buffer) with a finalization pass after stop.
	•	During recording: fast, low-latency partial text so the user can see it live.
	•	After stop: the “authoritative” transcript is generated with the user’s chosen STT profile (Speed or Accuracy) and diarization.

Speaker diarization strategy
	•	Diarization runs post-recording for best quality and stable speaker segments.
	•	Optional advanced mode: near-real-time diarization if performance allows, but the final pass remains the source of truth.
	•	Speaker naming:
	•	Default: Speaker 1, Speaker 2, etc.
	•	User can rename speakers.
	•	Optional: “suggest names” from calendar invite metadata or Slack participant list when available (never guessed from voice alone unless user enables it).

Dictation artifacts

Dictation mode creates a saved artifact by default.
	•	Default destination: an “Inbox” project or user-selected default project.
	•	Metadata stored: timestamp, app context (optional), device/mic, model profile.
	•	User can enable an “Ephemeral dictation” mode as an opt-out.

System audio capture

System audio capture is available day one on macOS and Windows.
	•	Consent is explicit every session.
	•	UI always shows: orange border + “System Audio Active” badge.
	•	Optional: audible chime on start/stop.

LLM support model (local-first, optional remote)

Nautilus supports both local and remote models via a provider abstraction.

Local (primary)
	•	Ollama (local)
	•	LM Studio (local OpenAI-compatible endpoint)

Remote (optional)
	•	Ollama Cloud
	•	OpenAI
	•	Anthropic
	•	Google Gemini
	•	OpenRouter

Rules
	•	Local is the default recommendation.
	•	Remote providers require an explicit toggle and clear disclosure of what content is sent.
	•	Per-project policy: choose model provider, retention setting, and redaction level.

Staged risks and fallbacks
	•	If streaming STT is unstable on a machine, Nautilus falls back to post-stop transcription while keeping capture reliable.
	•	If diarization is too slow, Nautilus ships with diarization as “recommended” but allows disabling per project.

13) Next implementation steps
	1.	Implement streaming capture pipeline (mic and system audio) with session metadata.
	2.	Implement incremental STT (fast mode) + finalization STT (authoritative pass).
	3.	Implement diarization post-pass + speaker rename UX.
	4.	Implement provider abstraction for LLMs (local + remote) with per-project policies.
	5.	Implement export bundles (Markdown, PDF, JSON evidence bundle) and audit log.