import type { Route } from "@rynk/core";

export interface ProxyRoute extends Route {
  /** When false, only loopback clients may use this route. */
  lan: boolean;
}

export interface ProxyProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  register(route: ProxyRoute): Promise<void>;
  remove(routeId: string): Promise<void>;
  list(): Promise<ProxyRoute[]>;
  reload(): Promise<void>;
  readonly port: number;
}
