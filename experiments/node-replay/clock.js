import { setImmediate, setTimeout } from "node:timers/promises";

// Virtual sends are serialized at the transport boundary. Never use this clock
// to infer parallel throughput or wall-clock capacity.
export function replayClock(mode) {
  let virtualMs = 0;
  const started = performance.now();
  return {
    now: () => (mode === "virtual" ? virtualMs : performance.now() - started),
    sleep: async (ms, value, options = {}) => {
      if (mode === "wall") return setTimeout(ms, value, options);
      await setImmediate();
      options.signal?.throwIfAborted();
      virtualMs += ms;
    },
    transport: async (ms) => {
      if (mode === "wall") await setTimeout(ms);
      else virtualMs += ms;
    },
  };
}
