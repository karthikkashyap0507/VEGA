# Compensator correctness

Generated 2026-09-27T10:36:14.986Z against the fake sandbox. 16/16 scenarios passed (100.0%; threshold 99%).

| Tool | Class | Compensator | Covered by | Scenarios |
|---|---|---|---|---|
| `gcal.create` | R1 | `gcal.event.delete` | this harness | 2 |
| `gcal.delete` | R1 | `gcal.event.recreate` | this harness | 1 |
| `gcal.update` | R1 | `gcal.event.restore` | this harness | 1 |
| `gdrive.share` | R1 | `gdrive.permission.revoke` | this harness | 2 |
| `gdrive.write` | R1 | `gdrive.revision.restore` | this harness | 1 |
| `gmail.draft` | R1 | `gmail.draft.delete` | this harness | 2 |
| `gmail.label` | R1 | `gmail.label.remove` | this harness | 1 |
| `gmail.send` | R2 | `gmail.send.recall` | the hold window (executor suite) | 0 |
| `outlook.draft` | R1 | `outlook.draft.delete` | this harness | 1 |
| `outlook.event_create` | R1 | `outlook.event.delete` | this harness | 1 |
| `outlook.send` | R2 | `outlook.send.recall` | the hold window (executor suite) | 0 |
| `sharepoint.share` | R1 | `sharepoint.permission.revoke` | this harness | 2 |
| `sharepoint.write` | R1 | `sharepoint.version.restore` | this harness | 1 |
| `slack.post` | R2 | `slack.message.delete` | this harness | 1 |

| Scenario | Tool | First | Second | Notified | Result |
|---|---|---|---|---|---|
| delete the draft it created | `gmail.draft` | restored | already_restored | 0 | pass |
| find and delete a draft whose creation was never recorded | `gmail.draft` | restored | not_needed | 0 | pass |
| remove only the labels it added | `gmail.label` | restored | already_restored | 0 | pass |
| delete a created event and cancel it for the attendees | `gcal.create` | restored | already_restored | 2 | pass |
| find and delete an event whose creation was never recorded (deterministic id) | `gcal.create` | restored | not_needed | 1 | pass |
| restore every field of an updated event, not just the changed ones | `gcal.update` | restored | already_restored | 2 | pass |
| recreate a cancelled event from its complete snapshot and re-invite | `gcal.delete` | restored | already_restored | 1 | pass |
| put the previous revision’s content back | `gdrive.write` | restored | already_restored | 0 | pass |
| revoke access it granted | `gdrive.share` | restored | already_restored | 0 | pass |
| restore the role of someone who already had access (never revoke it) | `gdrive.share` | restored | already_restored | 0 | pass |
| delete the draft it created | `outlook.draft` | restored | already_restored | 0 | pass |
| cancel the meeting it created | `outlook.event_create` | restored | already_restored | 1 | pass |
| restore the previous version with Graph’s restoreVersion | `sharepoint.write` | restored | already_restored | 0 | pass |
| remove access it granted | `sharepoint.share` | restored | already_restored | 0 | pass |
| restore the role of someone who already had access | `sharepoint.share` | restored | already_restored | 0 | pass |
| delete a released message | `slack.post` | restored | already_restored | 0 | pass |
