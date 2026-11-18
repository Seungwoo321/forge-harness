# 0042: Review finding resolution ownership

## Diagnosis

The review output contract accepts reviewer-shaped scope-guard and shared-path findings. Submission appends them to the target and a must-fix finding blocks acceptance. Finding resolution accepts only review and coverage, while scope recheck accepts only generated paths-shaped guards. Consequently a valid submitted reviewer finding can have no public resolution owner. Classification does not repair this ownership mismatch.

## Decision

New public review submissions accept review and coverage findings only, with nonblank finding identity and explanation fields required by resolution. Diagnosis belongs to root-cause stages; scope and shared-path guards belong to the deterministic control plane. Validation precedes target mutation.

The existing same-unit finding resolution command supports legacy reviewer-shaped findings only with explicit original review provenance. The supplied original output must match a completed recorded review attempt, its immutable input and output digests, exact target and exact original finding. Recovery also requires the current ship review, unchanged source and evidence, independent successful fix verification and request-bound authorization. The receipt retains the original provenance and finding digest; the original finding kind and historical review remain intact.

Generated guards remain ineligible even when a caller supplies reviewer provenance. Recovery adds no path authority and does not alter scope recheck or shared-path ownership. Revision checks, request identity, locking and repeated validation retain the ordinary resolution command's staleness, replay and concurrency guarantees.

## Rationale

Resolution authority follows the finding's verified producer rather than its label alone. Rejecting unsupported new outputs prevents fresh dead ends; checking immutable historical review output permits repair of prior accepted findings without rewriting history or waiving deterministic guards.
