# Superseded recovery diagnostic

The recorded 500-recipient virtual result passed delivery/recovery verification
but exposed a scheduler fairness defect: the last first listing arrived at
7,460 simulated ms. An urgent retry consumed an ordinary cursor turn, deferring
the skipped recipient for a full sweep. The fix preserves the ordinary cursor
when selecting an urgent retry; both languages have a 500-recipient regression
against the unchanged shared first-progress bound.

This run has no capacity verdict. The following wall run was stopped before
completion when the defect was found; it produced no usable result. The manifest
contains only the completed virtual run. Its recorded filename
`500-virtual-1.json` corresponds to `500-before-cursor-fix.json` here. An earlier
attempt was stopped during its first virtual run for review fixes and produced
no result. None of these incomplete attempts contributes to final measurements.
