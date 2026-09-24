# Plugins

Plugins add detectors, runtime adapters and exposure providers.

```js
// rynk-plugin-elixir.mjs
import { definePlugin } from "@rynk/plugins";

export default definePlugin({
  name: "rynk-plugin-elixir",
  detectors: [
    {
      name: "phoenix",
      async detect(ctx) {
        if (!ctx.exists("mix.exs") || !/phoenix/.test(ctx.read("mix.exs") ?? "")) return null;
        return {
          detector: "phoenix",
          language: "elixir",
          framework: "Phoenix",
          runtime: "native",
          confidence: 0.9,
          evidence: ["mix.exs with phoenix"],
          install: [{ file: "mix", args: ["deps.get"], display: "mix deps.get" }],
          start: { file: "mix", args: ["phx.server"], display: "mix phx.server" },
          defaultPort: 4000,
          binding: { env: { PORT: "{port}" }, portControllable: true },
        };
      },
    },
  ],
  setup({ log }) {
    log("Phoenix support loaded");
  },
});
```

## Loading

- Per project: list it under `plugins:` in `rynk.yaml` (package name resolved
  from the project's `node_modules`, or a relative path).
- Globally: `RYNK_PLUGINS=pkg-a,pkg-b` in the daemon's environment, or install
  into `RYNK_HOME/plugins`.

A plugin that throws while loading is skipped with a warning; it never takes
Rynk down.

## Interfaces

| Kind | Contract |
| --- | --- |
| Detector | `{ name, detect(ctx): DetectionResult \| null }` — `ctx` offers cached `exists`, `read`, `json`, `isDir`, `files`, `grep` |
| Runtime | `{ kind, available(), install(), build(), start() → RuntimeInstance, cleanup?() }` |
| Exposure | `{ name, mode, available(), create(target) → {id, url}, destroy(id), status(id) }` |

Types live in `@rynk/detector`, `@rynk/runtime` and `@rynk/exposure`.

Plugins run inside the daemon with your user's permissions. Only install
plugins you trust.
