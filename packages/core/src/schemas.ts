import { z } from "zod";

/** Zod schemas for everything crossing a trust boundary (HTTP API, WS, config). */

export const exposureModeSchema = z.enum(["local", "lan", "public"]);
export const runtimeKindSchema = z.enum(["native", "docker", "compose", "static", "custom"]);

export const startRequestSchema = z.object({
  root: z.string().min(1).max(4096),
  name: z.string().min(1).max(64).optional(),
  runtime: z.union([runtimeKindSchema, z.literal("auto")]).optional(),
  command: z.string().min(1).max(4096).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  host: z.string().max(255).optional(),
  exposure: exposureModeSchema.optional(),
  install: z.boolean().optional(),
  env: z.record(z.string().max(32_768)).optional(),
  /** Interface name or address whose IP goes in the share link. */
  network: z.string().max(255).optional(),
  maxUsers: z.number().int().min(0).max(100_000).optional(),
  protected: z.boolean().optional(),
  advertise: z.boolean().optional(),
  restart: z.enum(["never", "on-failure", "always"]).optional(),
  healthCheck: z.boolean().optional(),
  /** Create a public tunnel once live (explicit opt-in). */
  public: z.boolean().optional(),
});
export type StartRequest = z.infer<typeof startRequestSchema>;

export const idParamSchema = z.object({ id: z.string().min(1).max(128) });

export const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10_000).default(200),
  since: z.coerce.number().int().optional(),
});

export const shareRequestSchema = z.object({
  public: z.boolean().default(false),
  provider: z.string().max(64).optional(),
});

export const accessUpdateSchema = z.object({
  maxUsers: z.number().int().min(0).max(100_000).optional(),
  mode: z.enum(["open", "protected"]).optional(),
  advertise: z.boolean().optional(),
});

export const inviteRequestSchema = z.object({
  /** Lifetime in ms (default 1 hour, max 30 days). */
  ttlMs: z.number().int().min(10_000).max(30 * 24 * 3_600_000).default(3_600_000),
  /** How many new sessions may be started with it (default 10). */
  maxUses: z.number().int().min(1).max(10_000).default(10),
});

export const disconnectRequestSchema = z.object({ block: z.boolean().default(false) });
