# Capture: 3h+ Meeting Soak

Status: PASS
Owner: qa-macos
Generated: 2026-05-03T08:36:19.203Z

## Command

`bun run qa:packaged:macos:meeting:soak`

## Result

- Record duration requested: 10800000 ms
- Minimum required duration: 10800000 ms
- System audio requested: yes
- Recording ID returned: c477bda7-d20d-43e9-b5f6-fd998906b761
- Recording status: completed
- Transcript characters: 1348
- Transcript wait timed out: no
- Terminal empty transcript: no
- Audio file bytes: 2815368154

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

