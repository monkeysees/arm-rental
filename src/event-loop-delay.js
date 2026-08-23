import { monitorEventLoopDelay } from "node:perf_hooks";

// Long enough that ordinary scheduling jitter stays out of the journal, short
// enough to still name a block the browser would notice. Puppeteer gives an
// optional page interaction a third of the protocol budget, so anything past a
// quarter-second is already a measurable share of what a CDP call may spend
// waiting for this loop.
const DEFAULT_THRESHOLD_MS = 250;

// One record per window rather than one per spike: a stall is diagnosed by
// lining a window up against the crawl records that share its timestamps, and
// windows shorter than a page fetch would report the same block twice.
const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Watches how late the event loop is running and reports the windows that were
 * late enough to matter.
 *
 * The browser's CDP client shares this loop with everything else the process
 * does. A response that arrives while the loop is blocked is not read until
 * the block ends, so a long enough block is indistinguishable from a browser
 * that stopped answering, and surfaces as a protocol timeout rather than as
 * anything naming the work that actually caused it. Storage instrumentation
 * cannot stand in for this: it times the operations it knows about, which is
 * exactly the set that would already be suspected.
 */
export function createEventLoopDelayMonitor({
  onMetric = () => {},
  intervalMs = DEFAULT_INTERVAL_MS,
  thresholdMs = DEFAULT_THRESHOLD_MS,
  // The histogram resolution bounds how finely a block can be located; 10ms
  // keeps the sampling timer itself off the profile it is measuring.
  resolutionMs = 10,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  let stopped = false;

  const milliseconds = (nanoseconds) =>
    Number.isFinite(nanoseconds) ? nanoseconds / 1e6 : 0;

  const sample = () => {
    const maxMs = milliseconds(histogram.max);
    const p99Ms = milliseconds(histogram.percentile(99));
    const meanMs = milliseconds(histogram.mean);
    // Reset regardless of whether the window is reported, so a quiet window
    // never inherits the peak of a loud one.
    histogram.reset();
    if (maxMs < thresholdMs) return undefined;
    const metric = {
      name: "runtime.event_loop.delayed",
      component: "runtime",
      operation: "event_loop",
      windowMs: intervalMs,
      maxMs: Math.round(maxMs),
      p99Ms: Math.round(p99Ms),
      meanMs: Math.round(meanMs),
      thresholdMs,
    };
    try {
      onMetric(metric);
    } catch {
      // Observability cannot alter the run it is observing.
    }
    return metric;
  };

  const timer = setIntervalImpl(sample, intervalMs);
  // The process must still exit when its work is done; this only observes.
  timer.unref?.();

  return {
    /** Exposed so a caller can close a window on demand, and for tests. */
    sample,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(timer);
      histogram.disable();
    },
  };
}
