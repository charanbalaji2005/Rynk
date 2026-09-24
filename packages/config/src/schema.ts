import { z } from "zod";

const commandField = z.union([z.string().min(1), z.object({ command: z.string().min(1) })]);
const duration = z.union([z.string(), z.number()]);

export const rynkYamlSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    runtime: z
      .union([
        z.enum(["auto", "native", "docker", "compose", "static", "custom"]),
        z.object({ type: z.enum(["auto", "native", "docker", "compose", "static", "custom"]).default("auto") }),
      ])
      .optional(),
    install: commandField.optional(),
    build: commandField.optional(),
    start: commandField.optional(),
    /** Opt in to shell semantics (pipes, &&) for commands written in this file. */
    shell: z.boolean().optional(),
    server: z
      .object({
        host: z.string().optional(),
        port: z.union([z.number().int().min(1).max(65535), z.literal("auto")]).optional(),
      })
      .optional(),
    health: z
      .object({
        type: z.enum(["http", "tcp", "process", "command", "none"]).optional(),
        path: z.string().startsWith("/").optional(),
        command: z.string().optional(),
        interval: duration.optional(),
        timeout: duration.optional(),
        startupTimeout: duration.optional(),
      })
      .optional(),
    network: z
      .object({
        exposure: z.enum(["local", "lan", "public"]).optional(),
        /** Alias accepted for compatibility with early docs. */
        mode: z.enum(["local", "lan", "public"]).optional(),
      })
      .optional(),
    restart: z
      .object({
        policy: z.enum(["never", "on-failure", "always"]).optional(),
        maxRetries: z.number().int().min(0).max(100).optional(),
      })
      .optional(),
    env: z.record(z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional(),
    static: z.object({ dir: z.string() }).optional(),
    docker: z
      .object({
        dockerfile: z.string().optional(),
        compose: z.string().optional(),
        service: z.string().optional(),
        containerPort: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
    security: z
      .object({
        public: z.boolean().optional(),
        authentication: z.enum(["none", "optional", "required"]).optional(),
      })
      .optional(),
    plugins: z.array(z.string()).optional(),
    access: z
      .object({
        mode: z.enum(["open", "protected"]).optional(),
        maxUsers: z.number().int().min(0).max(100_000).optional(),
        idleTimeout: duration.optional(),
        clientRetention: duration.optional(),
        advertise: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RynkYaml = z.infer<typeof rynkYamlSchema>;

export function commandString(v: RynkYaml["start"]): string | undefined {
  if (!v) return undefined;
  return typeof v === "string" ? v : v.command;
}
