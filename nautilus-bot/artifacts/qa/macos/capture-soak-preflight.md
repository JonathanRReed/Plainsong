# Capture: Meeting Soak Preflight

Status: PASS
Owner: qa-macos
Generated: 2026-05-03T00:09:59.301Z

## Command

`node scripts/capture-packaged-macos-meeting-soak.mjs --record-ms 30000 --min-record-ms 30000`

## Result

- Record duration requested: 30000 ms
- Minimum required duration: 30000 ms
- System audio requested: yes
- Recording ID returned: 7525713c-3a40-4ad0-bb56-ff3627d9c417
- Recording status: completed
- Transcript characters: 21
- Transcript wait timed out: no
- Terminal empty transcript: no
- Audio file bytes: 8736374

## Checks

- meetingSetupReady: PASS
- minimumDurationRequested: PASS
- recordingIdReturned: PASS
- overlayEnteredRecording: PASS
- overlayEnteredTranscribing: PASS
- recordingRowPreserved: PASS
- recordingSourceMeeting: PASS
- captureModeMatches: PASS
- systemAudioFlagMatches: PASS
- speechFixtureRan: PASS
- recordingCompleted: PASS
- transcriptWaitCompleted: PASS
- transcriptNotTerminalEmpty: PASS
- transcriptCreated: PASS
- transcriptHasText: PASS
- audioPathPersisted: PASS
- audioFileExists: PASS
- audioFileHasData: PASS
- sidecarAudioFilesMatchMode: PASS
- startEventEmitted: PASS
- processingEventEmitted: PASS
- completedEventEmitted: PASS
- staleMeetingRouteErrorsAbsent: PASS
- audioFilesCleaned: PASS
- dbRestored: PASS
- settingsRestored: PASS
