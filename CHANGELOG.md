# Changelog

## 0.1.1 (2026-10-30)

- New logo: screen-capture corners around a check, with a red record dot. Used for the app,
  the installer, the taskbar and the sidebar.

## 0.1.0 (2026-10-30)

First version, Windows.

- Record an area of any screen with your voice: 3 s countdown, pause and resume, mute, a
  "Mark this" key, drawing (pen, highlighter, rectangle, circle, arrow), a ring at each click and
  a soft spot under the cursor. Every shortcut can be changed in Settings.
- Import an existing video: MP4, MOV, WebM or MKV (OBS), read directly, no conversion.
- Transcription on the PC with whisper.cpp, downloaded once and checked by SHA-256; model and
  language picker. Long recordings are cut at pauses into pieces of up to 30 s.
- Candidate frames picked without AI: scene changes, clicks, marks, pointing words and the middle
  of each transcript line. No ffmpeg.
- Built-in MCP server (`Showntask.exe --mcp`) with tools, prompts (make-tasks, file-tasks,
  summarise-recording) and resources. Contact sheets let the agent see a span's candidates in
  one image.
- MAKE-TASKS.md in every recording's folder for agents without MCP, and "Export for chat" for
  browser chats.
- Recordings library with search, rename, delete, task editing, frame and span deletion, and
  auto-delete after a set time.
- Crash-safe recording and resumable processing.
