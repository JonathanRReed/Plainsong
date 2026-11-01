# Hands-free editing on macOS

Enable spoken commands and use your configured prefix, which defaults to
`command`, and choose Insert at cursor. Clipboard only refuses edits.
A command must match the whole utterance.

With the Voice Edit shortcut, anything you say without the prefix is an
instruction for the selected text provider, except the fixed commands that
carry no words of their own. Say the prefix to run any command in the table
exactly as in ordinary command mode.

| With the Voice Edit shortcut | Prefix needed | Result |
| --- | --- | --- |
| `undo that`, `delete that`, `delete last sentence`, `move to start`, `move to end`, `new line`, `new paragraph`, `capitalise that`, `make that uppercase`, `delete selection` | No | Runs locally |
| `select approved plan` | No | Runs locally; refuses if the phrase is not found |
| `replace … with …`, `replace that with …`, `change … to …`, `change that to …`, `append …`, `prepend …`, `delete phrase …` | Yes | Runs locally with the prefix; without it, goes to the model |
| `make this more formal`, `rewrite this politely`, anything else | No | Goes to the model |

So "change the tone to formal" asks the model for a formal rewrite, while
"command change Smith to Smyth" swaps the name.

| Say | Result |
| --- | --- |
| `command select approved plan` | Select the unique matching phrase in the focused field. Matching ignores case and uses whole words, so `plan` never selects part of `planning`. |
| `command replace that with revised plan` | Replace the selection. |
| `command capitalise that` | Apply sentence case to the selection. |
| `command delete that` | Delete the selection, or the last verified Plainsong insertion when no text is selected. |
| `command delete last sentence` | Delete the last sentence within the last verified Plainsong insertion. |
| `command move to start` | Move to the start of the field. |
| `command move to end` | Move to the end of the field. |
| `command new line` | Insert one line break. |
| `command new paragraph` | Insert two line breaks. |
| `command undo that` | Reverse the last edit, selection, or cursor movement. |

These fixed commands use local rules and Accessibility. They do not call a text
model. Free-form Voice Edit instructions still use the selected text provider.
Ordinary dictation such as "I want to delete that file tomorrow" stays text.
Automatic cleanup never executes these commands.

With the Voice Edit shortcut, the prefix-free commands above are tried first.
An instruction that starts with "select", such as "select the intro and make
it formal", is a phrase selection. Selecting never changes text. If the phrase
is not in the field, Plainsong refuses and says so rather than sending it to
the model, because a misheard phrase must not become a rewrite of your
selected text. Start a rewrite with another word, such as "make" or "rewrite".

Plainsong refuses ambiguous or absent phrases, phrases found only inside a
longer word, and secure fields. Each command stays in the field fingerprinted
when capture starts. A field is the same field when its app, process,
Accessibility element, role, and identifier match; its size and position may
change, because message and email composers grow as you type. Deleting
retained text or undoing an edit also requires its original field and matching
text. Undo checks that the selection has not changed since the edit.

`delete last sentence` keeps titles, initials, and numbered references with
their sentence, so "Call Dr. Smith tomorrow." is one sentence, as are "U.S.
Army", "e.g.", and "No. 5". "a.m." and "p.m." followed by a capital end a
sentence. Case changes and phrase swaps of your own words never make those
words count as Plainsong's insertion. An edit across the edge of the insertion
retires it, so a later `delete that` refuses instead of guessing.

Commands in another field start a fresh history there. Undo and
`delete last sentence` still refer to the earlier field, and refuse while a
different field is focused. `delete that` deletes a selection in the new field;
with nothing selected, it refuses because Plainsong has not inserted anything
there.

After manual typing, a new editing command can use the current selection or
select a phrase. That starts a fresh history and discards stale insertion spans.
A retained-insertion deletion still refuses the changed text. Plainsong does
not activate another app to complete an edit. Unsupported fields are refused
rather than edited through keystrokes. Readable fields are limited to 65,536
UTF-16 units. Selection boundaries must contain whole characters, including
emoji sequences and combining marks.

The edit history stays in memory, holds at most 32 changes, and expires after
45 seconds without a command. A verified direct insertion supplies the retained
span for deletion. An insertion that cannot supply that proof cannot be deleted
by a later command. Undo checks the same field, text, and selection again before
restoring the change. If an editor cannot confirm a write, check its contents
before trying another edit.

Source tests cover command parsing, false positives, retained spans, Unicode
ranges, duplicate matches, and changed targets. The ignored Rust test
`textedit_voice_edit_commands` exercises the native path against a throwaway
TextEdit document. It records a refusal if its binary lacks Accessibility
permission and never changes that permission.
