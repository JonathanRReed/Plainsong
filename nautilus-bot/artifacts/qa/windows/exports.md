# Windows Export QA

Status: BLOCKED

The Windows packaged export row requires a Windows release host with the packaged installer flow available. The macOS packaged export gate now passes, but Windows still needs the same evidence:

- Standard Markdown, JSON, and text exports from a completed packaged recording.
- Signed evidence bundle export plus bundle verification.
- Built-in template rendering for meeting, journal, medical, interview, quick, podcast, and research templates.
- Database snapshot restoration or equivalent proof that QA fixtures do not leave user data behind.

Run the equivalent Windows packaged export harness after Windows packaging and signing material are available.
