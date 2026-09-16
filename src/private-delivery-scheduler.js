import { setImmediate, setTimeout } from "node:timers/promises";

export const PRIVATE_DELIVERY_CONCURRENCY = 8;

// One descriptor per recipient; payloads and pending IDs stay in the repository.
export async function schedulePrivateDeliveries(
  targets,
  step,
  { signal, sleep = setTimeout } = {},
) {
  const queue = targets.map((target) => ({ target, phase: "classify" }));
  const active = new Set();
  let failure;
  let wake;
  const onRecipientCancelled = () => wake?.();
  for (const target of targets)
    target.deliverySignal?.addEventListener("abort", onRecipientCancelled);
  try {
    while (queue.length || active.size) {
      if (signal?.aborted) break;
      let remaining = queue.length;
      while (remaining-- > 0 && active.size < PRIVATE_DELIVERY_CONCURRENCY) {
        const job = queue.shift();
        if (job.target.isAuthorized?.() === false) continue;
        const wait =
          job.phase === "classify" ? 0 : (job.target.deliveryDelayMs?.() ?? 0);
        if (wait > 0) {
          queue.push(job);
          continue;
        }
        await setImmediate();
        if (signal?.aborted) break;
        const operation = async () => {
          if (job.target.isAuthorized?.() === false) return;
          await step(job);
          if (job.phase !== "done") queue.push(job);
        };
        const promise = Promise.resolve()
          .then(() =>
            job.target.runDeliveryWorker
              ? job.target.runDeliveryWorker(operation)
              : operation(),
          )
          .catch((error) => {
            if (!error.privateRecipientUnavailable) failure ??= error;
          })
          .finally(() => {
            active.delete(promise);
            wake?.();
          });
        active.add(promise);
        await setImmediate();
      }
      if (signal?.aborted) break;
      if (!active.size && !queue.length) break;
      // Completed operations may have added ready recipients during the I/O yield.
      if (
        active.size < PRIVATE_DELIVERY_CONCURRENCY &&
        queue.some(
          ({ target, phase }) =>
            target.isAuthorized?.() === false ||
            phase === "classify" ||
            !(target.deliveryDelayMs?.() > 0),
        )
      )
        continue;
      const minimumDelay =
        active.size >= PRIVATE_DELIVERY_CONCURRENCY
          ? Infinity
          : queue.reduce(
              (minimum, { target }) =>
                Math.min(minimum, target.deliveryDelayMs?.() ?? 0),
              Infinity,
            );
      const timer = new AbortController();
      const changed = new Promise((resolve) => {
        wake = resolve;
      });
      try {
        await Promise.race([
          changed,
          sleep(Math.min(minimumDelay, 2 ** 31 - 1), undefined, {
            signal: signal
              ? AbortSignal.any([signal, timer.signal])
              : timer.signal,
          }),
        ]);
      } catch (error) {
        failure ??= error;
        break;
      } finally {
        wake = undefined;
        timer.abort();
      }
    }
  } finally {
    await Promise.all(active);
    for (const target of targets)
      target.deliverySignal?.removeEventListener("abort", onRecipientCancelled);
  }
  signal?.throwIfAborted();
  if (failure) throw failure;
}
