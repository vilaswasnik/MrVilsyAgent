import type { Job } from "./storage";

export function isJobDue(job: Job, now: number): boolean {
  if (!job.enabled) return false;
  if (job.schedule.kind === "interval") {
    return now - job.lastRunAt >= Math.max(1, job.schedule.minutes) * 60_000;
  }
  const [hours, minutes] = job.schedule.time.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return false;
  const scheduled = new Date(now);
  scheduled.setHours(hours, minutes, 0, 0);
  return now >= scheduled.getTime() && job.lastRunAt < scheduled.getTime();
}

export function describeSchedule(job: Job): string {
  return job.schedule.kind === "interval" ? `every ${job.schedule.minutes} min` : `daily at ${job.schedule.time}`;
}

// Read-only notice for unattended runs: write tools are queued, never executed.
export const SCHEDULED_RUN_NOTE =
  "This is an unattended scheduled run. Use read tools only. If you call a write tool it will be queued for the user's approval and will not execute. Keep the final report short.";
