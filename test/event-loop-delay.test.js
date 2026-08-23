import assert from "node:assert/strict";
import test from "node:test";

import { createEventLoopDelayMonitor } from "../src/event-loop-delay.js";

/** Drives the sampling timer by hand so a test never waits on a real window. */
function manualInterval() {
  const timers = new Set();
  return {
    setIntervalImpl: (callback) => {
      const timer = { callback, unref: () => timer };
      timers.add(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => timers.delete(timer),
    fire: () => {
      for (const timer of timers) timer.callback();
    },
    get active() {
      return timers.size;
    },
  };
}

function blockFor(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // Occupy the loop the way a long synchronous read does.
  }
}

test("a blocked loop is reported once per window and not carried into the next", async () => {
  const timer = manualInterval();
  const metrics = [];
  const monitor = createEventLoopDelayMonitor({
    onMetric: (metric) => metrics.push(metric),
    thresholdMs: 50,
    intervalMs: 10_000,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  try {
    // The histogram only records a turn once the loop actually runs one, so
    // the block has to sit between two of them.
    await new Promise((resolve) => setTimeout(resolve, 20));
    blockFor(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    timer.fire();

    assert.equal(metrics.length, 1);
    const [reported] = metrics;
    assert.equal(reported.name, "runtime.event_loop.delayed");
    assert.equal(reported.component, "runtime");
    assert.equal(reported.windowMs, 10_000);
    assert.equal(reported.thresholdMs, 50);
    assert.ok(
      reported.maxMs >= 150,
      `expected the 200ms block to be reported, saw ${reported.maxMs}ms`,
    );

    // A quiet window must not inherit the loud one's peak, or every later
    // window would keep accusing whatever ran during the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    timer.fire();
    assert.equal(metrics.length, 1);
  } finally {
    monitor.stop();
  }
  assert.equal(timer.active, 0);
});

test("a failing metric sink cannot take down the run it observes", async () => {
  const timer = manualInterval();
  const monitor = createEventLoopDelayMonitor({
    onMetric: () => {
      throw new Error("journal unavailable");
    },
    thresholdMs: 50,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    blockFor(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotThrow(() => timer.fire());
  } finally {
    monitor.stop();
  }

  // Stopping twice is what a shutdown that already failed once does.
  assert.doesNotThrow(() => monitor.stop());
});
