# 0072 — Move an unstarted engine delivery obligation to its external owner

A delivery correction records who must perform a delivery obligation (`engine` or `external`) and its minimum level. Later corrections could not change the owner, because every owner change was treated as a classification change. When a unit was mistakenly classified as engine-delivered but was actually delivered outside the engine, nothing could resolve it. `delivery: none` was refused while the engine obligation stood, and finish kept trying an engine delivery the host could not perform.

Moving from `engine` to `external` does not weaken the obligation. External delivery must still be proven by the trusted `verifyExternalDelivery` provider at finish, at the same or a stronger level. The move is accepted only under all of these conditions:

- the new correction keeps `kind: delivery` and a level no lower than the current one;
- the unit's ledger records no engine delivery effect (`git.commit`, `git.push`, `git.integrate`, `pr.create`, `pr.merge`);
- the verified user input and the trusted `verifyAcceptanceCorrection` confirm the owner and level from the original authority, as for any correction.

The move does not change product criteria, so the independent review and gate evidence stay. A SelfGated unit stays SelfGated. An Accepted unit returns to SelfGated with its acceptance cleared, as for a delivery policy change.

The operator then:

1. changes the delivery policy to `none`;
2. re-accepts the unit, which reuses the review;
3. finishes the unit, which verifies the actual external delivery against the accepted target.

An `external → engine` change, a weaker level, and any owner change after engine delivery has started remain refused.
