// The contract between the server part and the desktop GUI.
//
// The GUI cannot read `.run/almanac/` itself: a desktop window gets inert
// placeholders for Node built-ins, so `node:fs` there is a stub, not a file
// system. Every read and write goes through the server part over this RPC, which
// is also why the GUI can never disagree with the ticker — both use the same code.

import { Rpc } from "@opencode/plugin/rpc";

const JobState = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    day: { type: "number" },
    hour: { type: "number" },
    minute: { type: "number" },
    catchUpDays: { type: "number" },
    paused: { type: "boolean" },
    ranThisMonth: { type: "boolean" },
    nextAt: { type: ["string", "null"] },
    lastRun: { type: ["string", "null"] },
    lastSession: { type: ["string", "null"] },
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          at: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sessionID", "at", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["id", "label", "day", "hour", "minute", "paused", "ranThisMonth", "sessions"],
  additionalProperties: false,
} as const;

const One = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
} as const;

export const Almanac = Rpc.define({
  id: "almanac",
  methods: {
    list: {
      // The validator expects something to validate even when the method takes no
      // argument; without this the call fails with "e is not an Object".
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          target: { type: "string" },
          jobs: { type: "array", items: JobState },
        },
        required: ["target", "jobs"],
        additionalProperties: false,
      },
    },
    pause: { input: One, output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
    resume: { input: One, output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
    addJob: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          day: { type: "number" },
          hour: { type: "number" },
          minute: { type: "number" },
          catchUpDays: { type: "number" },
          agent: { type: "string" },
          promptFile: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["id", "day", "hour"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          jobs: { type: "number" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
    },
    removeJob: {
      input: One,
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          jobs: { type: "number" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
    },
    runNow: {
      input: One,
      output: { type: "object", properties: { queued: { type: "boolean" } }, required: ["queued"] },
    },
  },
  events: {
    // Emitted after anything that changes what the panel shows, so the GUI does
    // not poll for it.
    changed: { schema: { type: "object", additionalProperties: false } },
  },
});
