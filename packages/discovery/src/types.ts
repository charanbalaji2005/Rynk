/**
 * What a node announces on the wire. Deliberately tiny (< 300 bytes): the
 * full node description (apps, platform…) is fetched over HTTP only when
 * `rev` changes, so nothing large is ever broadcast.
 */
export interface Announcement {
  nodeId: string;
  name: string;
  address: string;
  apiPort: number;
  rev: number;
  version: string;
  /** Which provider saw it: "udp" | "mdns" | … */
  via: string;
}

export interface DiscoveryProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Set (or update) what this node announces. Safe to call repeatedly. */
  advertise(self: Omit<Announcement, "via">): Promise<void>;
  /** Actively ask the network who's there; resolves with what's known after a short wait. */
  discover(): Promise<Announcement[]>;
  onNodeDiscovered(cb: (a: Announcement) => void): void;
  onNodeLost(cb: (nodeId: string) => void): void;
}

export const DEFAULT_UDP_PORT = 7779;
export const DEFAULT_NODE_PORT = 7780;
export const MULTICAST_GROUP = "239.255.73.79";
export const SERVICE_TYPE = "_rynk._tcp.local";
