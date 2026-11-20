// The desktop half. OpenCode Desktop loads `./gui-experimental` — a prebuilt CJS
// bundle — never the TUI part, which is terminal-only.
//
// A window gets inert placeholders for Node built-ins, so this file must not import
// `node:fs` or `./state.ts` (which does). Everything comes from the server part over
// RPC, which is also why the panel can never disagree with the ticker.

import { For, Show, createSignal, onCleanup } from "solid-js";
import { Command, MenuItem, Panel, Plugin, TitlebarItem, usePlugin, type PanelTab } from "@opencode/plugin/gui";
import { Almanac } from "./rpc";

interface Job {
  id: string;
  label: string;
  day: number;
  hour: number;
  minute: number;
  catchUpDays: number;
  paused: boolean;
  ranThisMonth: boolean;
  nextAt: string | null;
  lastRun: string | null;
  lastSession: string | null;
  sessions: Array<{ sessionID: string; at: string; reason: string }>;
}

const PANEL_ID = "main";

function clock(job: Job): string {
  return `${String(job.hour).padStart(2, "0")}:${String(job.minute).padStart(2, "0")}`;
}

function when(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? `today ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default Plugin.define({
  setup(ctx) {
    const [jobs, setJobs] = createSignal<Job[]>([]);
    const [target, setTarget] = createSignal("");
    const [error, setError] = createSignal("");

    const refresh = async () => {
      try {
        const result = (await ctx.client.rpc(Almanac).list({})) as { target: string; jobs: Job[] };
        setTarget(result.target);
        setJobs(result.jobs);
        setError("");
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      }
    };

    void refresh();
    const poll = setInterval(() => void refresh(), 30_000);
    const stop = ctx.client.rpc(Almanac).events.on("changed", () => void refresh());
    onCleanup(() => {
      clearInterval(poll);
      stop();
    });

    const act = async (method: "pause" | "resume" | "runNow", id: string) => {
      try {
        const rpc = ctx.client.rpc(Almanac) as unknown as Record<string, (input: { id: string }) => Promise<unknown>>;
        await rpc[method]({ id });
        await refresh();
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      }
    };

    const line = () => {
      const all = jobs();
      if (!all.length) return "almanac · no jobs";
      const paused = all.filter((job) => job.paused).length;
      if (paused === all.length) return "almanac · paused";
      const soonest = all
        .filter((job) => !job.paused && job.nextAt)
        .map((job) => new Date(job.nextAt as string))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const tail = paused ? ` · ${paused} paused` : "";
      return soonest ? `almanac · ${when(soonest.toISOString())}${tail}` : `almanac · scheduled${tail}`;
    };

    // Always visible, top right.
    ctx.add(TitlebarItem, () => ({
      id: "next",
      label: line(),
      title: "Almanac scheduled runs",
      icon: "status",
      run: () => {
        const session = ctx.sessions.current();
        if (session) ctx.layout.open(`almanac:${PANEL_ID}`, session);
      },
    }));

    const tab: PanelTab = {
      id: PANEL_ID,
      get title() {
        return "Almanac";
      },
      closable: "compact",
      fallback: true,
    };

    ctx.add(Panel, {
      id: PANEL_ID,
      region: "side",
      width: "narrow",
      mobile: {
        get title() {
          return "Almanac";
        },
        order: 40,
        kind: "tab",
        icon: "status",
      },
      list: (input) => (input.open.includes(PANEL_ID) ? [tab] : []),
      render: () => (
        <View
          jobs={jobs}
          target={target}
          error={error}
          act={act}
          openSession={(id) => ctx.tabs.open({ server: "sidecar", id }, { focus: true })}
        />
      ),
    });

    // Also a launcher, so Almanac appears in the side region's "New tab" list
    // beside Review, Browser, Terminal and Open file.
    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current();
      return {
        menu: "session.panel",
        id: "open",
        title: "Almanac",
        icon: "status",
        description: jobs().length ? `${jobs().length} scheduled` : "no jobs",
        opened: !!session && ctx.layout.state(`almanac:${PANEL_ID}`, session) !== "closed",
        run: () => {
          const live = ctx.sessions.current();
          if (live) ctx.layout.open(`almanac:${PANEL_ID}`, live);
        },
      };
    });

    ctx.add(Command, () => ({
      id: "open",
      title: "Almanac: scheduled runs",
      group: "Almanac",
      slash: { name: "almanac" },
      featured: true,
      run: () => {
        const session = ctx.sessions.current();
        if (!session) return;
        ctx.layout.toggle(`almanac:${PANEL_ID}`, session);
      },
    }));

    ctx.add(Command, () => ({
      id: "resume",
      title: "Almanac: resume every job",
      group: "Almanac",
      run: () => {
        for (const job of jobs()) void act("resume", job.id);
      },
    }));
  },
});

function View(props: {
  jobs: () => Job[];
  target: () => string;
  error: () => string;
  act: (method: "pause" | "resume" | "runNow", id: string) => Promise<void>;
  openSession: (sessionID: string) => void;
}) {
  const ctx = usePlugin();
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const row = { padding: "6px 8px", borderBottom: "1px solid rgba(127,127,127,0.18)" } as const;
  const button = {
    marginRight: "6px",
    padding: "2px 8px",
    cursor: "pointer",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: "4px",
    background: "transparent",
    color: "inherit",
    font: "inherit",
  } as const;

  return (
    <div style={{ padding: "8px", height: "100%", overflow: "auto", "font-size": "12px" }}>
      <div style={{ opacity: 0.65, "margin-bottom": "8px" }}>{props.target()}</div>
      <Show when={props.error()}>
        <div style={{ color: "var(--vscode-errorForeground, #d44)", "margin-bottom": "8px" }}>{props.error()}</div>
      </Show>
      <Show when={props.jobs().length > 0} fallback={<div style={{ opacity: 0.65 }}>No jobs in jobs.json</div>}>
        <For each={props.jobs()}>
          {(job) => (
            <div style={row}>
              <div style={{ display: "flex", "align-items": "baseline", gap: "6px" }}>
                <strong>{job.label}</strong>
                <span style={{ opacity: 0.65 }}>
                  day {job.day} at {clock(job)} · {job.paused ? "paused" : job.ranThisMonth ? "ran this month" : "scheduled"}
                </span>
              </div>
              <div style={{ opacity: 0.65, "margin-bottom": "4px" }}>
                {job.paused ? "not scheduled" : `next ${when(job.nextAt)}`}
                {job.lastSession ? ` · ${job.lastSession}` : ""}
              </div>
              <button style={button} onClick={() => void props.act(job.paused ? "resume" : "pause", job.id)}>
                {job.paused ? "Resume" : "Pause"}
              </button>
              <button style={button} onClick={() => void props.act("runNow", job.id)} disabled={job.paused}>
                Run now
              </button>
              <Show when={job.sessions.length > 0}>
                <div style={{ "margin-top": "6px" }}>
                  <button
                    style={{ ...button, border: "none", padding: "0 2px", opacity: 0.75 }}
                    onClick={() => setExpanded((open) => ({ ...open, [job.id]: !open[job.id] }))}
                  >
                    {expanded()[job.id] ? "▾" : "▸"} Sessions ({job.sessions.length})
                  </button>
                  <Show when={expanded()[job.id]}>
                    <div style={{ "margin-left": "10px", "margin-top": "2px" }}>
                      <For each={job.sessions}>
                        {(run) => (
                          <div
                            title={run.sessionID}
                            style={{ cursor: "pointer", "text-decoration": "underline", opacity: 0.85, padding: "1px 0" }}
                            onClick={() => props.openSession(run.sessionID)}
                          >
                            {when(run.at)} · {run.reason} · {run.sessionID.slice(0, 12)}…
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
      <div style={{ opacity: 0.5, "margin-top": "8px" }}>
        run now is picked up by the server on its next tick, within a minute
      </div>
      <div style={{ opacity: 0.35, "margin-top": "4px" }}>{ctx.id}</div>
    </div>
  );
}
