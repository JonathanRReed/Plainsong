# Capture: Meeting Soak Preflight

Status: FAIL
Owner: qa-macos
Generated: 2026-05-03T03:50:20.810Z

## Command

`node scripts/capture-packaged-macos-meeting-soak.mjs --record-ms 1200000 --min-record-ms 1200000`

## Result

- Record duration requested: 1200000 ms
- Minimum required duration: 1200000 ms
- System audio requested: yes
- Recording ID returned: daf78a12-87c6-484e-abb8-ed24770c5848
- Recording status: processing
- Transcript characters: 0
- Transcript wait timed out: yes
- Terminal empty transcript: no
- Audio file bytes: 340645636

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
- recordingCompleted: FAIL
- transcriptWaitCompleted: FAIL
- transcriptNotTerminalEmpty: PASS
- transcriptCreated: FAIL
- transcriptHasText: FAIL
- audioPathPersisted: PASS
- audioFileExists: PASS
- audioFileHasData: PASS
- sidecarAudioFilesMatchMode: PASS
- startEventEmitted: PASS
- processingEventEmitted: PASS
- completedEventEmitted: FAIL
- staleMeetingRouteErrorsAbsent: PASS
- audioFilesCleaned: PASS
- dbRestored: PASS
- settingsRestored: PASS

