/**
 * Explicit deployment state machine. Status is never a bag of booleans:
 * every transition is validated so impossible states cannot be persisted.
 */

export const DEPLOYMENT_STATES = [
  "CREATED",
  "DISCOVERING",
  "RESOLVING",
  "PREPARING",
  "INSTALLING",
  "BUILDING",
  "ALLOCATING",
  "STARTING",
  "HEALTH_CHECKING",
  "REGISTERING",
  "EXPOSING",
  "LIVE",
  "RESTARTING",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

const PIPELINE: DeploymentState[] = [
  "CREATED",
  "DISCOVERING",
  "RESOLVING",
  "PREPARING",
  "INSTALLING",
  "BUILDING",
  "ALLOCATING",
  "STARTING",
  "HEALTH_CHECKING",
  "REGISTERING",
  "EXPOSING",
  "LIVE",
];

const TRANSITIONS: Record<DeploymentState, ReadonlySet<DeploymentState>> = (() => {
  const t = {} as Record<DeploymentState, Set<DeploymentState>>;
  for (const s of DEPLOYMENT_STATES) t[s] = new Set();
  // Forward progress through the pipeline; stages may be skipped (e.g. no build step).
  // Health checking is a hard gate: nothing before it may jump past it, so a
  // deployment can never become LIVE without answering a health check.
  const gate = PIPELINE.indexOf("HEALTH_CHECKING");
  PIPELINE.forEach((s, i) => {
    for (const next of PIPELINE.slice(i + 1, i < gate ? gate + 1 : undefined)) t[s].add(next);
  });
  // Any non-terminal stage can fail or be stopped.
  for (const s of DEPLOYMENT_STATES) {
    if (s !== "STOPPED" && s !== "FAILED") {
      t[s].add("FAILED");
      t[s].add("STOPPING");
    }
  }
  t.LIVE.add("RESTARTING");
  t.FAILED.add("RESTARTING");
  t.RESTARTING.add("STARTING");
  t.RESTARTING.add("FAILED");
  t.STOPPING.add("STOPPED");
  // Redeploys start over.
  t.STOPPED.add("CREATED");
  t.FAILED.add("CREATED");
  t.STOPPED.add("RESTARTING");
  t.FAILED.add("STOPPED");
  return t;
})();

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DeploymentState,
    readonly to: DeploymentState,
  ) {
    super(`Invalid deployment transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: DeploymentState, to: DeploymentState): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertTransition(from: DeploymentState, to: DeploymentState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(s: DeploymentState): boolean {
  return s === "STOPPED" || s === "FAILED";
}

export function isActive(s: DeploymentState): boolean {
  return !isTerminal(s);
}

/** Human labels for pipeline stages (shared by daemon logs and CLI progress). */
export const STAGE_LABELS: Partial<Record<DeploymentState, string>> = {
  DISCOVERING: "Detecting project",
  RESOLVING: "Resolving configuration",
  PREPARING: "Preparing runtime",
  INSTALLING: "Installing dependencies",
  BUILDING: "Building",
  ALLOCATING: "Allocating port",
  STARTING: "Starting application",
  HEALTH_CHECKING: "Waiting for the app to respond",
  REGISTERING: "Registering service",
  EXPOSING: "Creating network route",
  LIVE: "Live",
  RESTARTING: "Restarting",
  STOPPING: "Stopping",
  STOPPED: "Stopped",
};
