import { evaluateCapacity } from "../node-replay/capacity.js";

export function evaluateNativeCapacity(input) {
  return evaluateCapacity({
    ...input,
    phases: input.phases.map((phase) => ({
      ...phase,
      recipientsWithProgress: phase.sent > 0 ? phase.recipientsAsserted : 0,
      firstRecipientProgressMs: {
        max: phase.classificationWallMs + phase.firstProgressMaxMs,
      },
    })),
  });
}
