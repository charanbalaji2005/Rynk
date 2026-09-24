import type { DetectionResult } from "@rynk/core";
import type { ProjectContext } from "./context.js";

export interface Detector {
  /** Unique id, e.g. "node", "python". */
  name: string;
  /** Return null when this detector does not recognise the project. */
  detect(ctx: ProjectContext): DetectionResult | null | Promise<DetectionResult | null>;
}
