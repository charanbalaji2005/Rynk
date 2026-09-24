/**
 * Secret redaction applied to every log line before it is stored or
 * streamed. Patterns cover common credential shapes; env values whose keys
 * look sensitive are also registered as literal secrets at deploy time.
 */
const PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/]+):([^@\s/]+)@/gi, // creds in URLs
];

const KEYVAL =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi;

const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|ACCESS_KEY|CREDENTIAL|DSN|DATABASE_URL)/i;

export class Redactor {
  private literals = new Set<string>();

  addSecret(value: string | undefined): void {
    if (value && value.length >= 6) this.literals.add(value);
  }

  addFromEnv(env: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(env)) if (isSensitiveKey(k)) this.addSecret(v);
  }

  redact(input: string): string {
    let out = input;
    for (const lit of this.literals) out = out.split(lit).join("[REDACTED]");
    for (const re of PATTERNS) {
      out = out.replace(re, (m, a) =>
        typeof a === "string" && m.includes("://") ? `${a}:[REDACTED]@` : "[REDACTED]",
      );
    }
    out = out.replace(KEYVAL, (_m, k: string) => `${k}=[REDACTED]`);
    return out;
  }
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export const defaultRedactor = new Redactor();
export const redact = (s: string) => defaultRedactor.redact(s);
