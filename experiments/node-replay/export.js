import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectedClassifications } from "./verify.js";
import {
  contract,
  retainedIds,
  filtersFor,
  phasePage,
  phases,
  sequence,
} from "./fixture.js";

const [directory] = process.argv.slice(2);
assert(
  directory,
  "Usage: node experiments/node-replay/export.js NEW_DIRECTORY",
);
mkdirSync(directory);

for (const phase of phases) {
  phase.pages = {};
  for (const kind of ["apartment", "house"]) {
    const filename = `${phase.name}-${kind}.html`;
    writeFileSync(path.join(directory, filename), phasePage(phase, kind));
    phase.pages[kind] = filename;
  }
  delete phase.updated;
}
writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify(
    {
      ...contract,
      recipients: {
        id: "decimal index + 1",
        group: "zero-based index modulo 4",
        filtersByGroup: [0, 1, 2, 3].map(filtersFor),
      },
      seedDecisions: {
        timestamp: contract.seed.timestamp,
        initialSelectionApplied: true,
        matching: "notified",
        nonmatching: "filtered",
        group: "numeric listing ID modulo 4",
        listingIds: retainedIds,
        absentIds: sequence(
          contract.seed.absentIdBase,
          contract.seed.absentCount,
        ),
      },
      phases,
      expectedClassifications: Object.fromEntries(
        phases
          .filter((phase) => contract.expected[phase.name])
          .map((phase) => [
            phase.name,
            [0, 1, 2, 3].map((group) => expectedClassifications(phase, group)),
          ]),
      ),
      emptySubsequentPage: '<div id="contentr"></div>',
    },
    null,
    2,
  ),
);
