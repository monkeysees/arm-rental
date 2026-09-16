import { contract } from "./fixture.js";

export function evaluateCapacity({ users, mode, phases, primaryRamBytes }) {
  if (mode !== "wall") return null;
  const routine = phases.filter((phase) =>
    ["updated", "fresh"].includes(phase.name),
  );
  const catchup = phases.find((phase) => phase.name === "catchup");
  const fairProgressDeadlineMs =
    catchup.classificationWallMs +
    (2 * users * 1000) / contract.transport.globalAttemptsPerSecond +
    contract.transport.retryAfterMs +
    contract.transport.latencyMs;
  const idealDrainMs = Math.max(
    (catchup.attempts * 1000) / contract.transport.globalAttemptsPerSecond,
    ((contract.initialDeliveryLimit + 1 - contract.transport.recipientBurst) *
      60000) /
      contract.transport.recipientMessagesPerMinute,
  );
  return {
    routineWithinCrawlInterval:
      routine.reduce((sum, phase) => sum + phase.wallMs, 0) <=
      contract.crawlIntervalMs,
    classificationWithinCrawlInterval:
      routine.every((phase) => phase.classifiedRecipients === users) &&
      routine.reduce((sum, phase) => sum + phase.classificationWallMs, 0) <=
        contract.crawlIntervalMs,
    catchupIdealDrainMs: idealDrainMs,
    catchupWithinPermittedRateTarget:
      catchup.wallMs <=
      idealDrainMs * contract.measurement.capacityDrainTolerance,
    tolerance: contract.measurement.capacityDrainTolerance,
    allRecipientsProgressed: catchup.recipientsWithProgress === users,
    fairProgressDeadlineMs,
    fairProgress:
      catchup.firstRecipientProgressMs.max <=
      fairProgressDeadlineMs * contract.measurement.capacityDrainTolerance,
    withinApplicationMemoryLimit:
      primaryRamBytes === null
        ? null
        : primaryRamBytes <= contract.measurement.memoryBytes,
  };
}
