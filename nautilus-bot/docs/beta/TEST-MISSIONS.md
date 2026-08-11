# Beta test missions

Complete at least one Dictation mission and one Meetings mission. Use ordinary,
non-sensitive words. Never create a test recording from a real confidential
conversation.

## Mission 1: Fast Dictation

1. Open TextEdit or Notes and place the cursor in an empty document.
2. Use the displayed Dictation shortcut.
3. Say two natural sentences, including punctuation.
4. Stop Dictation and observe the preparation, transcription, and insertion
   states.
5. Confirm the complete text reached the target app exactly once.
6. Repeat after leaving Plainsong in the background for five minutes.

Report the target app, model, whether this was the first run after launch, and
any noticeable pause between Stop and visible text.

## Mission 2: Dictation recovery

1. Revoke Accessibility while Plainsong is open.
2. Try to start Dictation.
3. Confirm Start is unavailable with one cause and one repair action.
4. Restore Accessibility and use the repair action.
5. Dictate again and confirm the recovered result is preserved even if target
   insertion fails.

## Mission 3: Mic-only Meeting

1. Start a new Meeting with microphone only and acknowledge consent.
2. Speak for at least 60 seconds with natural pauses.
3. Press Stop once, then press it again while processing.
4. Confirm one Meeting record survives and reaches Ready.
5. Review the transcript, edit notes, add an action item, create a follow-up,
   export it, and reopen the Meeting after relaunch.

## Mission 4: Me + Them Meeting

1. From Setup, run Test system audio and wait for verified non-silent capture.
2. Start Me + Them capture with a permitted test call or public audio source.
3. Speak from the microphone while the other source is audible.
4. Stop and confirm both sides appear in the transcript.
5. Verify notes, action items, follow-up, export, retention, and deletion.

On macOS below 14.7, use mic-only capture unless you already understand and
have configured a virtual loopback route.

## Mission 5: Recovery under interruption

Use a disposable test Meeting. Exercise one case: quit during capture, quit
during processing, sleep and wake, disconnect the input device, or relaunch
after a forced sidecar exit. Report the last phase shown, the stable Meeting
identity, and whether Plainsong offered a direct recovery action.

## Accessibility and visual pass

Use keyboard navigation through onboarding and both main pillars. Check visible
focus, light and dark themes, reduced motion, loading, empty, disabled, error,
and recovery states. Report any control whose label or next action is unclear.
