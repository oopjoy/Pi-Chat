import type { QueuedPrompt, SessionSummary } from "../../shared/types";

/** Normalize one sidebar row with the newest browser-observed running fact. */
export function applySidebarRunningOverride(
  session: SessionSummary,
  running: boolean,
): SessionSummary {
  const activity = session.activity;
  if (running) {
    return {
      ...session,
      running: true,
      ...(activity ? { activity: { ...activity, execution: "running" } } : null),
    };
  }
  if (
    !activity
    || (activity.execution !== "running" && activity.execution !== "dispatching")
  ) return { ...session, running: false };
  const queued = session.queued === true;
  return {
    ...session,
    running: false,
    activity: { ...activity, execution: queued ? "queued" : "idle" },
  };
}

/** Keep coarse Sidebar queue/activity facts aligned with the queue projection. */
export function applySidebarQueueProjection(
  session: SessionSummary,
  queue: QueuedPrompt[],
  paused = session.activity?.execution === "paused",
): SessionSummary {
  const queued = queue.length > 0;
  const activity = session.activity;
  const staleQueueActivity =
    activity?.execution === "queued"
    || activity?.execution === "dispatching"
    || activity?.execution === "paused";
  return {
    ...session,
    queued,
    ...(staleQueueActivity
      ? {
          activity: {
            ...activity,
            execution: queued
              ? paused
                ? "paused"
                : session.running
                  ? "running"
                  : "queued"
              : session.running
                ? "running"
                : "idle",
          },
        }
      : null),
  };
}

export function settleSidebarActivity(session: SessionSummary): SessionSummary {
  return applySidebarRunningOverride(session, false);
}
