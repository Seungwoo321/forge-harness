# 0074 — Retire an unstarted engine delivery plan with a delivery policy change

Finish records an engine delivery plan and moves an Accepted unit to Delivering before it runs the first delivery effect. When that first effect cannot start, for example because no repository provider is configured, the unit stays in Delivering with a plan and no ledger effect.

Before this decision, no public operation could leave that state:

- the policy change refused any unit with a delivery plan;
- a finish without the delivery payload no longer matched the plan;
- a reopen discarded the acceptance and the review.

A plan whose engine effects never started is only a recorded intention. A verified `unit policy change` of `delivery` therefore also accepts a Delivering unit when all of the following hold:

- it has a delivery plan;
- it has no delivery result and no session finalization;
- its ledger has no `git.commit`, `git.push`, `git.integrate`, `pr.create` or `pr.merge` intent.

The new policy must still satisfy every delivery obligation, as for any delivery policy change. The change removes the plan and its start sequence, and records the plan under `retiredDeliveryPlans` with the policy change id. It returns the unit to SelfGated with its acceptance cleared and its review kept.

Re-acceptance reuses that review. Finish then follows the new policy, for example `none` together with a verified external delivery obligation. A plan whose engine effects have started is still reconciled or continued through the existing delivery paths.
