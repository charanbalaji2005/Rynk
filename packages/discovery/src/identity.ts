import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface NodeIdentity {
  /** rynk-node-<first 24 hex of sha256(public key)> — derived from the key, so it can't be claimed without it. */
  nodeId: string;
  createdAt: number;
  /** Ed25519 public key, base64 DER (SPKI). Shared with other nodes. */
  publicKey: string;
  /** Ed25519 private key, PKCS#8 PEM. Never leaves this machine. */
  privateKey: string;
}

export function nodeIdFromPublicKey(publicKeyB64: string): string {
  return "rynk-node-" + crypto.createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 24);
}

function generate(): NodeIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { nodeId: nodeIdFromPublicKey(pub), createdAt: Date.now(), publicKey: pub, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/**
 * Persistent, self-certifying node identity stored in RYNK_HOME/node.json
 * (owner-only). Machines are never identified by IP. Identities from older
 * versions (random id, no key) are replaced once by a keyed identity.
 */
export function loadIdentity(home: string): NodeIdentity {
  const file = path.join(home, "node.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<NodeIdentity>;
    if (raw.publicKey && raw.privateKey && raw.nodeId === nodeIdFromPublicKey(raw.publicKey)) return raw as NodeIdentity;
  } catch {
    /* create below */
  }
  const identity = generate();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return identity;
}

export function signBody(identity: Pick<NodeIdentity, "privateKey">, body: string): string {
  return crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(identity.privateKey)).toString("base64");
}

export function verifyBody(publicKeyB64: string, body: string, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(body), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Friendly node name: RYNK_NODE_NAME, else the hostname without a .local suffix. */
export function nodeName(): string {
  const n = process.env.RYNK_NODE_NAME?.trim() || os.hostname().replace(/\.local$/i, "");
  return n.replace(/[^\w.-]/g, "-").slice(0, 63) || "rynk-node";
}
