# Capture: Meeting Soak Preflight

Status: PASS
Owner: qa-macos
Generated: 2026-05-03T04:49:26.399Z

## Command

`node scripts/capture-packaged-macos-meeting-soak.mjs --record-ms 1200000 --min-record-ms 1200000`

## Result

- Record duration requested: 1200000 ms
- Minimum required duration: 1200000 ms
- System audio requested: yes
- Recording ID returned: 6d0cc342-b6de-4b4c-8cdf-063a3b30596f
- Recording status: completed
- Transcript characters: 21
- Transcript wait timed out: no
- Terminal empty transcript: no
- Audio file bytes: 325612702

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

