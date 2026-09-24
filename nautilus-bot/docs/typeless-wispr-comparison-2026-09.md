# Plainsong vs Typeless vs Wispr Flow (2026-09-24)

An honest scorecard for the question "are we better yet?", and what this
round changed because of it. Competitor facts come from their help centers
and press as indexed by search engines (their sites were not reachable from
the build machine), so treat them as research, not verification. Sources are
listed at the end.

## Short answer

On **what the product does**, Plainsong is now level with or ahead of both
on most rows: cleanup, voice edits, privacy, price, meetings. On **how it
feels**, it was behind on the things you notice in the first minute: no
sounds, a quick tap on the hotkey did nothing useful, dictating mid-sentence
pasted a capital letter with no space, the home screen showed file counts
instead of progress, and the app shell blinked and blanked while loading.
This round closes those. It still loses on reach: no Windows, no iPhone,
fewer languages on the local model, and no team features.

## Scorecard

Better = clearly ahead, Level = same class, Behind = a real gap.

| Area | Plainsong | Typeless | Wispr Flow | Verdict |
| --- | --- | --- | --- | --- |
| Works offline, audio stays on the Mac | Yes, by default | No (cloud, AWS) | No (cloud) | **Better** |
| Price | Free; optional Plus planned at $10 | $30/mo or $12/mo yearly; 8k words/week free | $15/mo or $12/mo yearly; 2k words/week free | **Better** |
| Accuracy, English | Local Parakeet; cloud BYOK routes up to Grok (2.3% AA-WER) | Cloud, strong | Cloud, strong | Level with a cloud route; local is a notch behind the best cloud models |
| Languages | 25 local (Parakeet), ~100 via Whisper or cloud | 100+ with auto-detect and mixed-language speech | 100+ with auto-detect | **Behind** on local; level with cloud routes |
| Filler removal, self-corrections, lists | On by default, on the Mac | Yes | Yes (Backtrack) | Level |
| Voice edit of a selection, "help me write" | Voice Edit style | Ask anything | Command Mode (Pro only) | Level; free here |
| Dictionary | Manual, snippets, opt-in learning from corrections | Auto-adds corrected words | Auto-learn, starred terms, team dictionary | Level; learning is opt-in here by design |
| Per-app tone | Per-app styles | App-aware | Four app categories | Level |
| Meetings | Local capture, diarization, notes | None | Notetaker | **Better** |
| HUD | Pill with live trace, finishing bar, honest errors, "Still working" on slow runs, four sizes, docks upright to a screen edge | Voice bar | Flow Bar: draggable, size presets, hover actions | Level; no hover actions yet |
| Hotkey gestures | Toggle, hold, hands-free (voice start); now hold or tap to lock | Press to start, press to finish | Hold, double-tap to lock, Fn+Space | Level after this round |
| Sounds | Start, finish, failure; optional mute of other audio while dictating | Start and finish, mute when dictating | Start and finish, optional music mute | Level |
| Casing and spacing to fit the sentence | Now, on macOS | Not documented | Yes | Level after this round |
| Paste fallback | Copies, says "Not inserted", history keeps it | Unknown | Auto-copies, Paste button for 5 s | Level |
| Stats and motivation | Now: words, pace, time saved, streak, on Home and Dictation | Words, WPM, time saved | WPM gauge, words, streak heatmap, sharing | Level; no heatmap or share card |
| History | Now: grouped by day, the words and the app on each row, copy on hover, show more | On-device history | Date-grouped, click to copy, retry failed | Level; no retry of a failed dictation from saved audio |
| Onboarding | Model, live mic check with picker and named errors, practice dictation, hotkey and mode choice, meetings, a Ready summary | Permissions, mic test, first dictation | Sign-in, permissions, mic test, mode choice, practice | Level |
| Platforms | macOS | Mac, Windows, iOS, Android | Mac, Windows, iOS, Android | **Behind** |
| Teams, SSO, compliance | None | Team billing | Shared dictionary, SSO, SOC 2, HIPAA | **Behind** (not a goal yet) |
| Resource use | Native Rust sidecar; local models cost RAM while loaded | Light client, cloud work | Electron; users report ~800 MB | Level to better for dictation-only use |

## What changed this round because of it

- **Dictation sounds**: soft tick when the mic goes live, pop when the words
  land, low tone on failure. On by default, a switch in Settings.
- **Hold to talk, tap to lock**: a quick tap on the hold key keeps listening
  until the next press, instead of producing "No speech".
- **Fit to the sentence**: dictating mid-sentence adds the space, keeps
  lowercase and drops a stray full stop. Names, acronyms and "I" keep their
  casing. The characters around the caret are read at insert time and never
  stored.
- **Headline stats**: words, speaking pace, time saved against typing at
  40 WPM, and a day streak, above dictation history and on Home.
- **"Still working"** on the dictation pill when a stage runs past twice its
  usual time (Wispr's "taking longer than usual").
- **UI fluidity pass** from a screenshot audit of every view (84 captures):
  - Shell: no dark flash for light-theme users, no setup splash on launch
    once onboarding is done, views preload and fade in instead of blanking,
    each view keeps its scroll, the sidebar collapses under 1000 px, and
    hotkeys show as macOS glyphs (⌥ Space).
  - Home: stats, then recent history grouped by day, opening the right
    meeting; a first-dictation invite with your hotkey when empty.
  - Dictation: history grouped by day with the words and the app on each
    row (the sidecar now sends a preview), hover actions, "Show more", a
    skeleton while loading, gold instead of error-rust for the active
    profile, one select style, and a calm "Checking…" state.
  - Settings: a one-row section bar instead of a 350 px card grid, no
    crash on a reply without shortcut conflicts, plain messages instead of
    raw JavaScript errors, and one select style.
  - Onboarding: fixed header and footer so Continue is always on screen,
    plain-language model choice, one progress indicator, step transitions.
  - Meetings: no clipped toolbar, m:ss totals, the bulk-move banner only
    when a row looks misfiled, no layout shift as banners load.
  - Performance: the recording clock no longer re-renders the whole app
    every second, and a transcript re-renders one or two rows per playback
    tick instead of all of them.
- **Plus billing** now works with Stripe or Polar (`infra/plus-worker`).

## Still behind, in order of impact

1. **Local languages.** Typeless's mixed-language dictation is a real edge.
   The local fix is Qwen3-ASR 1.7B or Granite 5 once their weights can be
   pinned; until then Whisper and the cloud routes cover the rest.
2. **Windows and iPhone.** The biggest reach gap. The Rust side already
   builds off macOS; the renderer is Electron. Worth a plan once Mac is
   launched.
3. **Streak heatmap and a share card** for stats.

Closed in the final pass: pill size presets and edge docking, muting other
audio while dictating, a live mic-level step in onboarding, and a
menu-bar item that shows a running clock and controls dictation and
meetings.

## Sources

- Wispr Flow help center: hands-free, hotkeys, Flow Bar move and dock,
  "taking longer than usual", paste fallback, retry, setup guide, usage
  stats, dictionary, snippets, Backtrack, Command Mode, styles, privacy
  mode (docs.wisprflow.ai).
- Typeless help center and site: first dictation, settings, key features,
  translation mode, FAQs, data controls, pricing (typeless.com).
- Secondhand: Digital Trends on the Flow Bar feedback thread; Podfeet
  (March 2026); getvoibe, spokenly and usevoicy reviews; Product Hunt
  reviews.
