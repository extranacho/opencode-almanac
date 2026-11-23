# opencode-almanac

An OpenCode plugin that runs an agent session on a **day and time** — the 1st at
08:00, say, optionally in a timezone of its own — with a catch-up window, and gives
you a panel to see, pause and trigger it.

## Why

OpenCode's own `/loop` schedules by duration: `idle`, `every 5m`, `after 5m`. That
cannot express "the first of the month". `almanac` holds a calendar instead: a day,
a time of day and a number of days it may still run late.

## Install

From git — no npm account needed:

```bash
opencode plugin add "github:extranacho/opencode-almanac#v0.4.0"
```

Or add it by hand to your **global** `~/.config/opencode/opencode.jsonc`, which is
what makes the desktop UI available in every window:

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
| `repo` | The project the jobs act on. Defaults to wherever OpenCode is running. |
| `jobsFile` | Your schedule, **relative to `repo`**. Defaults to `jobs.json` beside the plugin. |

The plugin ships an **empty** schedule. Bring your own.

## Your schedule

Keep it in the repo it acts on, so it is versioned with the work:

```text
your-project/
└── .opencode/
    └── almanac/
        ├── jobs.json
        └── prompts/
            └── monthly.md
```

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "monthly-report",
      "label": "Monthly report",
      "day": 1,
      "hour": 8,
      "minute": 0,
      "catchUpDays": 30,
      "agent": "build",
      "promptFile": "prompts/monthly.md"
    },
    {
      "id": "monday-standup",
      "label": "Monday notes for the SF team",
      "day": 1,
      "hour": 17,
      "minute": 30,
      "timezone": "America/Los_Angeles",
      "catchUpDays": 1,
      "prompt": "Summarise last week's platform work."
    }
  ]
}
```

- `day` is 1–31, `hour` 0–23 and `minute` 0–59. The job fires at exactly
  `hour:minute` — a job at 09:30 does not run at 09:00.
- **Times are local to the machine unless the job names a `timezone`.** With no
  `timezone`, the job follows whatever clock the laptop is on, so it moves if you
  travel. With an IANA name, the day and time are read in that zone and stay put:

  | Field | Fires when |
  | --- | --- |
  | *(omitted)* | this machine's clock reads `hour:minute` on `day` |
  | `"timezone": "Europe/Lisbon"` | Lisbon's clock does, wherever you are |
  | `"timezone": "Asia/Tokyo"` | Tokyo's clock does — a day ahead of Lisbon for part of every day |

  Daylight saving is whatever the zone says it is; no offset is stored. A name
  `Intl` does not recognise is refused when the job is added, because a typo
  would otherwise schedule a job that silently never fires.
- **29, 30 and 31 mean the last day of a shorter month.** The job still runs every
  month; only the date moves:

  | Month | `day: 31` fires on | `day: 30` fires on |
  | --- | --- | --- |
  | 31 days | the 31st | the 30th |
  | 30 days | the 30th | the 30th |
  | 28 days (February) | the 28th | the 28th |
  | 29 days (leap February) | the 29th | the 29th |

  Days 1–28 are never moved. Nothing is skipped and nothing rolls into the next
  month — a naive `new Date(y, 1, 31)` becomes 3 March, which is why the date is
  clamped before it is built.
- A clamped run still counts as that month's run, and the log says so:
  `waiting for day 28 (day 31 clamped to 28)`.
- Two jobs can land on the same date: `day: 28` and `day: 31` both fire on
  28 February. Jobs are independent, each with its own monthly claim.
- `catchUpDays` is how many days late a missed run may still fire. `0` means
  strictly that day.
- `promptFile` is relative to `jobs.json`; a `prompt` string works too.
- `agent` is optional — it names the agent the session runs as.
- `jobs.example.json` shows the same shape.

The file is re-read on every tick, so an edit is live within a minute — no reload,
no restart. Changes appear in the panel on its next refresh.

## Letting an agent schedule work

The plugin registers a tool, `almanac_schedule`, so an agent can add, remove or list
jobs from inside a session instead of hand-editing JSON. It validates rather than
trusting the request — a day no month is guaranteed to have, a missing `promptFile`
or a duplicate id are all refused with a reason.

The tool's own instructions tell the agent to **ask which timezone the job should
run in** before adding it, rather than assuming the machine's local clock. Answer
"local" and the field stays out of the file; name a zone and it is written as
`timezone`.

Ask for it in plain language:

> Schedule a job called "changelog refresh" on the 15th at 09:00, using the `build`
> agent, that updates CHANGELOG.md since the last tag. Put the prompt in its own
> file.

The agent then calls:

```jsonc
almanac_schedule({
  action: "add",
  id: "changelog-refresh",
  label: "Changelog refresh",
  day: 15,
  hour: 9,
  minute: 0,
  timezone: "Europe/Lisbon",   // omit for this machine's local time
  catchUpDays: 2,
  agent: "build",
  promptFile: "prompts/changelog.md"
})
```

`action: "list"` returns the current schedule, `action: "remove"` with an `id` drops
one. Writes are atomic (temp file plus rename), so a crash mid-write cannot leave a
schedule that fails to parse — which would read as "no jobs" and silently stop the
ticker.

## RPC

The same operations are available over HTTP for anything outside OpenCode:

| Method | Input | Does |
| --- | --- | --- |
| `list` | — | every job with its state and run history |
| `pause` / `resume` | `{ id }` | one job |
| `runNow` | `{ id }` | queues a dispatch, picked up within a minute |
| `addJob` | `{ id, day, hour, ... }` | validated add |
| `removeJob` | `{ id }` | removes one |

```bash
opencode api post /api/rpc/almanac/list --data '{"input":{}}'
```

There is also a `changed` event, emitted whenever the schedule or a run changes.

## The UI

A **titlebar pill** shows the next run, or `paused`. Clicking it opens the panel,
which also appears in the side region's **New tab** list.

Each job row shows its schedule, state, when it last ran and under which session,
with **Pause/Resume** and **Run now**, and a collapsible **Sessions (n)** list.
Clicking a session opens it as a tab in the main window.

`/almanac` (and the command palette) toggles the panel.

## How it works

- **The ticker lives in the OpenCode server.** No OpenCode, no tick. That is the
  trade for having no launchd job or system cron: a job that did not fire on its
  day runs the next time OpenCode is open, within `catchUpDays`.
- **Every time it compares is read on the job's clock** — the machine's, or the
  job's `timezone` when it has one — including the month the claim file is named
  after, so a job in another zone cannot claim two months for one run. Nothing
  stores a UTC offset: `Intl` answers for the zone at that instant, which is what
  keeps a job at 08:00 at 08:00 across a daylight-saving change.
- **The month claim is a file** — `.run/almanac/<job>-YYYY-MM.json`, created with
  `O_EXCL`. Not in-memory and not plugin storage: `setup` can run more than once for
  a location, and only a file is atomic across those instances.
- **Every dispatch appends to** `.run/almanac/history.jsonl`, which is what the
  panel's session list reads.
- **Pause is a file too** — `.run/almanac/paused.json` — because the ticker runs in
  the server and has to see it.
- **Run now** writes a marker the server picks up on its next tick, within a minute.
  One dispatcher is worth the wait: two would mean two places writing the claim.

All state lives in the target repo under `.run/almanac/`, never in the plugin.

## Requirements

- OpenCode with the GUI plugin API (`@opencode/plugin/gui`). Built and tested against
  the desktop app on server 2.3.2 / OCLI 2.2.6. **The GUI plugin API is marked
  experimental** and may change between releases, so pin a tag rather than `#main`.
- The titlebar pill, panel and session opening are desktop-only. There is no TUI
  part: `ui.slot` is a terminal-only API and the desktop app never loads one.

## Development

```bash
npm install
npm test                  # vitest, no browser needed
npm run build             # -> dist/gui-experimental.cjs
```

`dist/gui-experimental.cjs` is **committed on purpose**: the desktop app loads that
file, and a git install cannot run a build step. Rebuild it after any change to
`gui.tsx` or `rpc.ts`, or the app keeps running the old bundle.

The app reloads a local plugin's GUI when the bundle changes.

## Contributing

Setup, the rule about the committed bundle, and how releases are cut are in
[CONTRIBUTING.md](CONTRIBUTING.md). Bugs go through the issue form, which asks for
`.run/almanac/almanac.log` first — most "it never ran" reports are answered there.

## Licence

MIT.
