import crypto from "node:crypto";
import type { JobEvent } from "./types.ts";

export interface Job {
  id: string;
  kind: "clone" | "modify";
  slug: string;
  status: "running" | "done" | "failed";
  events: (JobEvent & { at: number })[];
  listeners: Set<(e: JobEvent & { at: number }) => void>;
}

const jobs = new Map<string, Job>();

export function createJob(kind: Job["kind"], slug: string): Job {
  const job: Job = { id: crypto.randomUUID().slice(0, 8), kind, slug, status: "running", events: [], listeners: new Set() };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function emit(job: Job, event: JobEvent) {
  const e = { ...event, at: Date.now() };
  job.events.push(e);
  if (event.type === "done") job.status = "done";
  if (event.type === "failed") job.status = "failed";
  for (const l of job.listeners) l(e);
}

/** Emitter helpers so pipeline code reads naturally and also mirrors progress to the terminal. */
export function reporter(job: Job | null, echo = true) {
  const send = (e: JobEvent) => {
    if (job) emit(job, e);
    if (!echo) return;
    if (e.type === "stage") console.log(`\n== ${e.stage.toUpperCase()}: ${e.message}`);
    else if (e.type === "log") console.log(`${e.level === "info" ? "  " : e.level === "warn" ? "  ! " : "  x "}${e.message}`);
    else if (e.type === "failed") console.log(`\nFAILED: ${e.message}`);
  };
  return {
    stage: (stage: string, message: string) => send({ type: "stage", stage, message }),
    info: (message: string) => send({ type: "log", level: "info", message }),
    warn: (message: string) => send({ type: "log", level: "warn", message }),
    error: (message: string) => send({ type: "log", level: "error", message }),
    event: send,
  };
}
export type Reporter = ReturnType<typeof reporter>;
