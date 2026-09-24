/** JSON-lines protocol between the CLI and the popup window. */

export interface PopupInterface {
  name: string;
  address: string;
  kind: string;
  label?: string;
}

export interface PopupInit {
  type: "init";
  project: { name: string; root: string; framework?: string; runtimeLabel?: string; packageManager?: string | null; command: string };
  options: { runtimes: string[]; ports: number[] };
  network: { interfaces: PopupInterface[]; selected: string };
  defaults: {
    name: string;
    command: string;
    runtime: string;
    port: number | "Auto";
    host: string;
    exposure: "local" | "lan" | "public";
    maxUsers: number;
    protected: boolean;
    autoRestart: boolean;
    healthCheck: boolean;
    advertise: boolean;
  };
  sharePort?: number | null;
}

export interface PopupSettings {
  name: string;
  command: string;
  runtime: string;
  port: number | null;
  host: string;
  network: string;
  exposure: "local" | "lan" | "public";
  maxUsers: number;
  protected: boolean;
  autoRestart: boolean;
  healthCheck: boolean;
  advertise: boolean;
}

export type ToPopup =
  | PopupInit
  | { type: "progress"; text: string }
  | { type: "failed"; message: string; causes: string[]; suggestions: string[] }
  | { type: "live"; name: string; urls: Record<string, string | undefined>; port: number; pid: number | null; health: string; uptimeMs: number; access: { maxUsers: number; mode: string }; warnings: string[] }
  | { type: "status"; health: string; pid: number | null; urls?: Record<string, string | undefined>; users: { active: number; limit: number }; clients: Array<{ sessionId: string; clientAddress: string; status: string; connectedAt: number }> }
  | { type: "qr"; url: string; matrix: string[] }
  | { type: "log"; line: string }
  | { type: "stopped"; message?: string }
  | { type: "close" };

export type FromPopup =
  | { type: "ready" }
  | { type: "start"; settings: PopupSettings }
  | { type: "cancel" }
  | { type: "closed" }
  | { type: "action"; action: "stop" | "restart" | "qr" | "logs" | "copy" | "open" }
  | { type: "disconnect"; sessionId: string; block: boolean }
  | { type: "limit"; maxUsers: number };

export const RUNTIME_CHOICES = ["Auto", "Docker", "Static", "Custom command"] as const;

/** Map the popup's runtime choice to a Rynk runtime kind. */
export function runtimeFromChoice(choice: string): "auto" | "docker" | "static" | "custom" {
  const c = choice.toLowerCase();
  return c.startsWith("docker") ? "docker" : c.startsWith("static") ? "static" : c.startsWith("custom") ? "custom" : "auto";
}
