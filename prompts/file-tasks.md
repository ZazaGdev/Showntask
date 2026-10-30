# File Showntask tasks on a board

Recording: {{title}} (id `{{id}}`), {{count}} tasks, {{unfiled}} not filed yet.
Board: {{board}}

Read the tasks with `get_tasks` (or `tasks.json` in `{{folder}}`). File each task that has no
entry for this board in its `filed` list, using the connector for the board you already have.
Showntask itself never talks to a board.

- If no connector for {{board}} is installed, stop and tell the person which one they need. Do
  not guess another way to reach the board.
- If you do not know the project, list, repository or area path, ask once and use the answer for
  every task.

## Mapping

| Field | GitHub Issues | Linear | Jira | Trello | Asana | Azure DevOps |
|---|---|---|---|---|---|---|
| title | title | title | summary | card name | task name | Title |
| description + steps + done_when | body (Markdown) | description | description | card description | notes | Description / Repro Steps (Bug), Acceptance Criteria |
| kind | label | label or type | issue type | label | tag | work item type (Bug, Task, User Story) |
| quote + at | body footer "Said at 12:04: ..." | same | same | same | same | Discussion or description footer |
| frames | image uploaded or linked in body | attachment | attachment | attachment | attachment | attachment |

Write the description as: the description lines, then "Steps:" with the steps numbered (when
there are any), then "Done when: ...", then the footer `Said at mm:ss: "quote"`.

## Frames

Frames are local files (`get_frame` gives each one's path). Attach them when the connector can
upload a file. When it cannot, write each frame's local path and second at the end of the
description and tell the person afterwards which files to drag in, item by item.

## After each one

Call `mark_filed` with the recording id, the task id, the board and the new item's URL, so a
second run does not file it twice. At the end, list what was filed with the URLs.
