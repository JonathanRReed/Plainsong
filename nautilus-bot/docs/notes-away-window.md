# Meeting notes while away

On Light-tier Macs, automatic notes can use a 512 MiB reserve after 180
seconds without keyboard or pointer activity. The model's memory claim does
not change. Pressure must be normal. AC power qualifies; battery power needs
at least 50% charge and Low Power Mode off. Unknown counters do not qualify.

The sidecar reads IOKit's HIDIdleTime and power-source counters. It checks
power every 10 seconds, HID activity and the pressure-event counter every
250 milliseconds during a request. Returning or losing safe power conditions
cancels at the next token boundary. Warning pressure stops Light-tier notes;
critical pressure stops background notes on every tier. The existing helper
cancellation timeout ends a helper that stops answering.

The Light-tier notes job keeps its helper and memory claim across the summary
and action-item stages. Finishing or cancelling the job releases the helper.

Finished transcript chunks stay in memory for the same automatic-notes job's
retry. The interrupted chunk runs again. A changed transcript, speaker map,
model or instruction cannot reuse an old checkpoint. Cancellation, a newer
job and process exit discard checkpoints. Saved summaries and action items
remain in the database, and the original transcript remains available.

Light-tier memory waits retry every 10 seconds. Other tiers keep their
existing backoff and admission reserve. Foreground text work keeps its
existing reserve. When the normal reserve fits, notes can still run without
an away window. Speech preemption keeps its immediate-stop path.

Recovery transcription and notes share the post-call coordinator, so their
heavy passes cannot overlap. All native memory claims, including resident
speech, still count. Keeping speech resident can therefore prevent notes
from fitting at 2.5 GiB; notes do not evict speech to make room.

A smaller reserve can cause macOS to compress other apps' memory while the
person is away. Pressure cancellation limits this risk but does not prove
that a physical 8 GB Mac will avoid compression or swap.
