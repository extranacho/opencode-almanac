// A calendar scheduler as an OpenCode plugin — the whole trigger, with no launchd.
//
// `/loop` schedules by duration (`idle`, `every 5m`, `after 5m`) and cannot express
// "the first of the month at 08:00". A plugin can: `setup` may hold a timer, and
// the plugin context can create a session and prompt it, which is the same pair of
// calls `opencode-loopd` makes.
//
// The ticker lives in the OpenCode server, so no OpenCode means no tick. That is
// accepted: the job runs the next time OpenCode is open, not at 08:00 with the
// laptop closed. The catch-up window is the rest of the month, and a late run is
// safe because the job's prompt starts with `--plan`.
//
// The schedule is `jobs.json` beside this file, re-read on every tick so an edit —
// or a change made from the panel — takes effect without a reload. Claims and
// pause state are files under `.run/almanac/` in the target repo, because `setup`
// can run more than once for one location and anything in memory is per instance.
// On 2026-11-19 a duplicate registration produced four dispatches in one second.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Plugin } from "@opencode/plugin";
import { describeNext, evaluate, monthKey } from "./schedule.ts";
import { addJob, claimFile, consumeRunRequest, describeJobs, isPaused, loadJobs, readClaim, recordRun, removeJob, requestRun, resolveJobsFile, setPaused } from "./state.ts";
import { hhmm } from "./tz.ts";
import { Almanac } from "./rpc.ts";

const TICK_MS = 60_000;
const PLUGIN_DIR = import.meta.dirname;

export default Plugin.define({
  id: "almanac",

  async setup(ctx) {
    // The repo the jobs belong to. Set through plugin options so this can live in
    // the global config; defaults to the current location for project-local use.
    const options = (ctx.options ?? {}) as { repo?: string; jobsFile?: string };
    const target = String(options.repo ?? ctx.location.directory);
    const jobsPath = resolveJobsFile(PLUGIN_DIR, target, options.jobsFile);

    const runDir = path.join(target, ".run");

    // Plugin console output never reaches the OpenCode log, so a file is the only
    // way to answer "is it alive and did it fire".
    const log = (message: string) => {
      try {
        mkdirSync(runDir, { recursive: true });
        appendFileSync(path.join(runDir, "almanac.log"), `${new Date().toISOString()} ${message}\n`);
      } catch {}
    };

    if (!existsSync(target)) {
      log(`target is missing: ${target}`);
      return () => {};
    }


    const running = new Set<string>();

    const fire = async (job, reason, force = false) => {
      const now = new Date();
      if (running.has(job.id)) return;
      running.add(job.id);

      const file = claimFile(target, job, now);
      if (force) {
        // "Run now" is a person asking for it, so the month already having run is
        // not an answer. Clear the claim and take it again, which still keeps two
        // concurrent instances from both dispatching.
        try {
          unlinkSync(file);
        } catch {}
      }
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        // Claim before dispatching: O_EXCL is the only atomic claim available, and
        // it is what stops duplicate instances from double-firing.
        const handle = openSync(file, "wx");
        writeFileSync(handle, JSON.stringify({ startedAt: now.toISOString() }));
        closeSync(handle);
      } catch {
        running.delete(job.id);
        log(`${job.id} already claimed this month; skipping`);
        return;
      }

      try {
        const session = await ctx.session.create({
          title: `almanac: ${job.id} ${monthKey(job, now).split("/")[1]}`,
          location: { directory: target },
          ...(job.agent ? { agent: job.agent } : {}),
        });
        log(`dispatched ${job.id} (${reason}) -> ${session.id}`);
        recordRun(target, {
          jobID: job.id,
          sessionID: session.id,
          at: now.toISOString(),
          month: monthKey(job, now),
          reason,
        });
        void rpc.events.emit("changed", {});

        void ctx.session
          .prompt({ sessionID: session.id, text: job.prompt })
          .then(() => {
            writeFileSync(file, JSON.stringify({ startedAt: now.toISOString(), sessionID: session.id, ok: true }));
          })
          .catch((error) => log(`${job.id} prompt failed: ${error.message}`))
          .finally(() => running.delete(job.id));
      } catch (error) {
        running.delete(job.id);
        try {
          unlinkSync(file);
        } catch {}
        log(`${job.id} could not start: ${error.message}`);
      }
    };

    const tick = async () => {
      const now = new Date();
      const jobs = loadJobs(jobsPath);
      if (!jobs.length) return;

      for (const job of jobs) {
        try {
          if (isPaused(target, job.id)) continue;

          if (consumeRunRequest(target, job.id)) {
            log(`${job.id} run requested from the panel`);
            await fire(job, "requested", true);
            continue;
          }

          const existing = readClaim(target, job, now);
          const decision = evaluate(job, now, existing ? monthKey(job, now) : undefined);
          if (!decision.due) continue;
          log(`${job.id} ${decision.reason}`);
          await fire(job, decision.reason);
        } catch (error) {
          log(`${job.id} tick failed: ${error.message}`);
        }
      }
    };

    const startup = () => {
      const jobs = loadJobs(jobsPath);
      if (!jobs.length) {
        log(`no jobs in ${jobsPath}`);
        return;
      }
      for (const job of jobs) {
        const paused = isPaused(target, job.id) ? " (paused)" : "";
        log(`${job.id} next ${describeNext(job, new Date())}${paused} (target ${target})`);
      }
    };
    startup();

    // The GUI runs in a desktop window with no file system, so every read and write
    // it needs comes through here. Same code as the ticker, so they cannot disagree.
    const rpc = await ctx.rpc.register(Almanac, {
      list: async () => {
        const jobs = loadJobs(jobsPath);
        return { target, jobs: describeJobs(target, jobs) };
      },
      pause: async (input) => {
        const { id } = input as { id: string };
        setPaused(target, id, true);
        log(`pause requested: ${id}`);
        await rpc.events.emit("changed", {});
        return { ok: true };
      },
      resume: async (input) => {
        const { id } = input as { id: string };
        setPaused(target, id, false);
        log(`resume requested: ${id}`);
        await rpc.events.emit("changed", {});
        return { ok: true };
      },
      addJob: async (input) => {
        const result = addJob(jobsPath, input as never);
        log(result.ok ? `job added: ${(input as { id: string }).id}` : `job rejected: ${result.error}`);
        if (result.ok) await rpc.events.emit("changed", {});
        return result;
      },
      removeJob: async (input) => {
        const { id } = input as { id: string };
        const result = removeJob(jobsPath, id);
        log(result.ok ? `job removed: ${id}` : `remove rejected: ${result.error}`);
        if (result.ok) await rpc.events.emit("changed", {});
        return result;
      },
      runNow: async (input) => {
        const { id } = input as { id: string };
        requestRun(target, id);
        log(`run requested: ${id}`);
        await rpc.events.emit("changed", {});
        return { queued: true };
      },
    });

    // A tool, so an agent can schedule work from a session instead of hand-editing
    // JSON — and gets the validation rather than a schedule that silently never
    // fires. Same code as the RPC.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "almanac_schedule",
        description: [
          "Add, remove or list scheduled agent runs in the almanac plugin.",
          `The schedule is ${jobsPath}.`,
          "actions: 'list', 'add', 'remove'.",
          "For 'add': day 1-31 (29-31 mean the last day of a shorter month), hour 0-23, minute 0-59,",
          "catchUpDays 0-31 (how late a missed run may still fire), optional agent name,",
          "and one of prompt (a string) or promptFile (relative to the jobs file, and it must exist).",
          "The job fires on that day at exactly hour:minute — the minute is part of the trigger, not a rounding.",
          "Optional timezone is an IANA name (Europe/Lisbon, Asia/Tokyo); without it the job runs on this",
          "machine's local clock. Before adding a job, ask the user whether it should run in this machine's",
          "local time or in a specific timezone — do not assume, and do not pass a zone the user did not ask for.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "add", "remove"] },
            id: { type: "string" },
            label: { type: "string" },
            day: { type: "number" },
            hour: { type: "number" },
            minute: { type: "number" },
            timezone: { type: "string" },
            catchUpDays: { type: "number" },
            agent: { type: "string" },
            promptFile: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const request = input as Record<string, string | number> & { action: string };
          if (request.action === "list") {
            const jobs = loadJobs(jobsPath);
            if (!jobs.length) return { content: `No jobs scheduled in ${jobsPath}` };
            return {
              content: jobs
                .map(
                  (job) =>
                    `${job.id} — day ${job.day} at ${hhmm(job.hour, job.minute)}${job.timezone ? ` ${job.timezone}` : " local"}, catch-up ${job.catchUpDays ?? 0}d${job.agent ? `, agent ${job.agent}` : ""}`,
                )
                .join("\n"),
            };
          }
          if (request.action === "add") {
            const result = addJob(jobsPath, request as never);
            log(result.ok ? `job added via tool: ${request.id}` : `tool add rejected: ${result.error}`);
            if (result.ok) await rpc.events.emit("changed", {});
            return {
              content: result.ok
                ? `Added ${request.id}, running ${request.timezone ? `in ${request.timezone}` : "on this machine's local time"}. ${result.jobs} job(s) scheduled. It is live within a minute — no reload.`
                : `Rejected: ${result.error}`,
            };
          }
          const result = removeJob(jobsPath, String(request.id ?? ""));
          log(result.ok ? `job removed via tool: ${request.id}` : `tool remove rejected: ${result.error}`);
          if (result.ok) await rpc.events.emit("changed", {});
          return {
            content: result.ok ? `Removed ${request.id}. ${result.jobs} job(s) left.` : `Rejected: ${result.error}`,
          };
        },
      });
    });

    // Status, so "is it alive" is answerable without reading files.
    const registration = await ctx.command.transform((editor) => {
      editor.add({
        name: "almanac-status",
        description: "Show the almanac jobs, their next run and the last dispatch",
        execute: async ({ sessionID, prompt, delivery }) => {
          const now = new Date();
          const jobs = loadJobs(jobsPath);
          const lines = ["almanac", "", `target: ${target}`, ""];
          for (const job of jobs) {
            const claim = readClaim(target, job, now);
            const paused = isPaused(target, job.id);
            lines.push(`${job.id} — day ${job.day} at ${hhmm(job.hour, job.minute)}${job.timezone ? ` ${job.timezone}` : " local"}`);
            lines.push(`  next: ${describeNext(job, now)}`);
            if (paused) lines.push("  paused: yes");
            if (claim) lines.push(`  this month: ${claim.sessionID ?? "claimed, no session"}${claim.ok ? " (ok)" : ""}`);
            lines.push("");
          }
          await ctx.session.prompt({ sessionID, text: lines.join("\n"), delivery });
        },
      });
    });

    const timer = setInterval(() => void tick(), TICK_MS);
    void tick();

    return async () => {
      clearInterval(timer);
      await registration.dispose();
    };
  },
});
