# Make tasks from a Showntask recording

You are turning a spoken screen recording into tasks. The person talked while working on
screen. Showntask wrote down what they said with timings and kept candidate frames from the
video. Your job: find each separate thing they want done, write it up so someone who never
heard the recording can act on it, pick the frames that show it, show the list to the person,
and save it.

Recording: {{title}} ({{length}}, {{lines}} transcript lines, {{candidates}} candidate frames)
{{#project}}Project: {{project}}
{{/project}}{{#kinds}}Kinds to look for: {{kinds}}
{{/kinds}}
<!-- mcp -->
## Reading it (MCP tools)

- `get_recording` with id `{{id}}` gives the metadata and the timed transcript, each line as
  `[mm:ss-mm:ss] text`. On a long recording read it in spans with `get_transcript` (`from`,
  `to` in seconds) instead.
- For each task you draft, call `get_contact_sheet` for the span of its talk: one image of up
  to {{sheetMax}} candidate thumbnails, each labelled with its second and why it is a candidate
  (`scene` change, `click`, pointing `word`, `line` middle, `marker`). Pick the 1-{{framesPerTask}}
  that show the point, then fetch those at full size with `get_frames` to check them and to read
  text on screen for the steps. Look at sheets first; fetch full frames only for the ones you keep.
- If you cannot see images, or the person asked you not to look at frames, call
  `suggest_frames` for the span instead and say in the task that its frames were chosen unseen.
- Then call `save_tasks` with id `{{id}}` and the list.
<!-- /mcp -->
<!-- files -->
## Reading it (files)

All paths are in this folder: `{{folder}}`

- `transcript.md`: the timed transcript, each line as `[mm:ss-mm:ss] text`.
- `candidates.json`: the candidate frames, each `{ "at": seconds, "file": "0412.jpg",
  "reasons": [...], "words": [...] }`. Reasons: `scene` change, `click`, pointing `word`,
  `line` middle, `marker`.
- `frames\<file>`: the frames, full size. `frames\thumbs\<file>`: small copies to skim.
- For each task, look at the candidates in the span of its talk and pick the 1-{{framesPerTask}}
  that show the point. If you cannot read images, pick by the reasons (a click or scene change
  near a pointing word first, then a pointing word, then a line's middle) and say in the task
  that its frames were chosen unseen.
- Then write `tasks.json` in this folder in the format below, and `tasks.md` with the same
  tasks as a readable list.
<!-- /files -->

## Rules

- One task per separate thing the person wants done. Two mentions of one thing are one task.
- No tasks for thinking aloud, filler, or things they finished on screen during the recording.
- Every candidate with the reason `marker` is a moment the person marked on purpose: it must
  become its own task (or be merged into the task it plainly belongs to), with that frame.
- `title`: an imperative, one line, under 80 characters, no full stop at the end.
- `description`: 2-6 short lines someone who never heard the recording can act on: what is
  wrong or wanted, and where (app, page, screen, file or feature). Use only what was said and
  what the frames show; never invent details.
- `steps`: for a bug, the steps to see it, from the talk and what the frames show. Otherwise [].
- `done_when`: one line saying how to tell it is done.
- `kind`: `bug`, `feature`, `change`, `chore` or `question`.
- `quote`: the person's own words the task comes from, shortened when long.
- `at`: the second where the talk about this task starts.
- `frames`: 1-{{framesPerTask}} seconds of candidate frames that show the point. Whisper's line
  starts take in the pause before the words, while the screen may still show what came before,
  so prefer frames from the middle of the lines, never a line's first second.
- Transcripts come from Whisper: names may be split or misspelled ("get hub" for GitHub).
- Never use the em dash or the en dash; use a comma, a colon or a full stop.

## Format

```json
{ "id": "t1", "title": "Keep the workout timer running when the phone locks",
  "description": "The workout timer resets to zero when the phone locks.",
  "steps": ["Open a workout", "Lock the phone for 30 s", "Unlock: timer shows 00:00"],
  "done_when": "The timer keeps counting through a lock",
  "kind": "bug", "labels": ["timer"], "quote": "the workout timer resets when the phone locks",
  "at": 9.8, "frames": [11.4], "filed": [] }
```

## Before saving

Show the person the list: for each task its title, kind, the quote and its time, and the frame
seconds. Ask whether to drop, merge or change any. Save only after they agree.
