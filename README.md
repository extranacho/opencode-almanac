# opencode-almanac

An OpenCode plugin that runs an agent session on a calendar schedule: monthly,
weekly, daily or hourly, at a set time, optionally in a timezone of its own. A run
missed while OpenCode was closed still fires when it opens, within a window you
choose. A desktop panel shows what is scheduled and lets you pause or trigger it.

OpenCode's own `/loop` schedules by duration (`every 5m`, `after 5m`), which cannot
say "the 1st at 08:00" or "Mondays at 09:00". This can.

## Install

```bash
opencode plugin add "github:extranacho/opencode-almanac#v0.4.0"
```

Then point it at your project and schedule in your **global**
`~/.config/opencode/opencode.jsonc`, which is what makes the panel appear in every
window:

```jsonc
{
  "plugins": [
    {
      "package": "github:extranacho/opencode-almanac#v0.4.0",
      "options": {
        "repo": "/absolute/path/to/your/project",
        "jobsFile": ".opencode/almanac/jobs.json"
      }
    }
  ]
}
```

| Option | Meaning |
| --- | --- |
| `repo` | The project the jobs run in. Defaults to wherever OpenCode is running. |
| `jobsFile` | Your schedule, relative to `repo`. **Set it**: without it the plugin reads the empty schedule it ships with, and nothing runs. |

The plugin keeps its state in `.run/` inside `repo`. Add it to that repo's
`.gitignore`:

```text
.run/
```

## A first job

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "standup-notes",
      "every": "week",
      "weekday": "mon",
      "hour": 9,
      "prompt": "Summarise last week's merged PRs into NOTES.md."
    }
  ]
}
```

Save that as `.opencode/almanac/jobs.json` in your project. The file is re-read
every minute, so a change is live within a minute, with no reload. Or skip the JSON
and [ask an agent](#letting-an-agent-schedule-work). `jobs.example.json` has one job
of each frequency.

## Fields

| Field | Used by | Meaning |
| --- | --- | --- |
| `id` | all | Lower-case letters, digits and dashes. Names the job's files. |
| `every` | all | `"month"` (the default), `"week"`, `"day"` or `"hour"`. |
| `day` | month | 1–31. 29–31 mean the last day of a shorter month: `31` runs on 30 April and 28 February. |
| `weekday` | week | `mon` … `sun`. Full names work too. |
| `hour` | month, week, day | 0–23. |
| `minute` | all | 0–59, default 0. A job at 09:30 does not run at 09:00. An hourly job runs at this minute past every hour. |
| `timezone` | all | An IANA name such as `Europe/Lisbon`. Without it the job follows this machine's clock, so it moves when you travel. |
| `catchUp` | all | How late a missed run may still start: `"30m"`, `"6h"`, `"2d"`. See below. |
| `prompt` or `promptFile` | all | The message the session gets. `promptFile` is relative to `jobs.json`. |
| `agent` | all | Optional. The agent the session runs as. |
| `label` | all | Optional. The name shown in the panel. |

A field the frequency does not use is refused rather than ignored, so a weekly job
with `day: 15` is an error, not a job that quietly runs on Mondays. A job written
by hand that breaks a rule is skipped, and the log says why.

### Catching up

The schedule only ticks while OpenCode is open. If the laptop is shut at 09:00, the
run fires the next time OpenCode is open, provided that is inside `catchUp`. After
that, the run is skipped. It is never backfilled.

- `"0d"`, the default, means the rest of that day. For hourly jobs the default is
  `"0h"`, the rest of that hour.
- Days and hours count to the end of that day or hour, so a daily 23:00 job with
  `"3h"` can still start at 02:59. Minutes are exact.
- The window must be shorter than the gap between runs: under an hour for hourly
  jobs, under a day for daily ones, up to `"6d"` weekly and `"31d"` monthly.
- A late run can cross into the next day or month. It still counts as the run it
  was late for, so the next scheduled run fires as normal.
- A job added inside its window runs right away. An hourly job at `:00` added at
  10:40 runs at 10:40, then at 11:00.

Each run is a new OpenCode session, so an hourly job makes 24 a day.

## Letting an agent schedule work

The plugin gives agents a tool, `almanac_schedule`, to add, remove and list jobs.
It applies the same rules as the file and refuses a bad request with the reason. It
also tells the agent to ask you which timezone to use rather than assume one.

> Every Friday at 17:30, have the `build` agent update CHANGELOG.md since the last
> tag. Put the prompt in its own file.

## The panel

A **titlebar pill** shows the next run, or `paused`. Click it, or run `/almanac`,
for the panel. It is also in the side region's **New tab** list. Each job shows its
schedule, next run and last run, with **Pause/Resume**, **Run now** and its past
sessions. Clicking a session opens it.

**Run now** is picked up within a minute. It is an extra run and does not use up
the next scheduled one.

`/almanac-status` prints the same information into the current session.

## When a job did not run

Read `.run/almanac.log` in your project. It records startup, each dispatch, each
skipped job and why, and a jobs file that is not valid JSON. A broken file stops
every job until it is fixed, and that log is the only place that says so.

## How it works

- **The timer runs inside the OpenCode server**, once a minute. There is no
  launchd job and no system cron, which is why nothing runs while OpenCode is closed.
- **Every scheduled time is claimed once.** The claim is a file in `.run/almanac/`,
  created with `O_EXCL`, because the plugin's `setup` can run more than once for a
  location and only a file is atomic across those instances. Each job keeps its
  last 10 claims.
- **Times are read on the job's clock**, either the machine's or its `timezone`.
  No UTC offset is stored: `Intl` answers for the zone at each moment, so 08:00
  stays 08:00 across a daylight-saving change.
- **Runs are logged** to `.run/almanac/history.jsonl`, which the panel reads. It
  is trimmed to the newest 1,000 runs once it passes 2,000.
- **Pause** is `.run/almanac/paused.json`, and **Run now** is a marker file the
  timer picks up on its next tick. One place dispatches, so one place claims.

## RPC

The same operations are available over HTTP:

```bash
opencode api post /api/rpc/almanac/list --data '{"input":{}}'
```

`list` returns every job with its state and runs. `pause`, `resume`, `runNow` and
`removeJob` take `{ id }`, and `addJob` takes a job. A `changed` event fires
whenever the schedule or a run changes.

## Requirements

- OpenCode with the GUI plugin API (`@opencode/plugin/gui`). Built and tested against
  the desktop app on server 2.3.2 / OCLI 2.2.6. **The GUI plugin API is
  experimental** and may change between releases, so pin a tag rather than `#main`.
- The pill, panel and session links are desktop-only. There is no terminal UI part.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and the committed bundle.
Bugs go through the issue form.

## Licence

MIT.
