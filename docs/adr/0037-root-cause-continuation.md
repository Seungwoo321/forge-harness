# 0037: Continue root-cause repair after a retry limit

## Decision

An explicitly selected `retry.onExhaustion: root-cause` allows a failed, isolated product gate to enter same-unit repair after its ordinary retry budget is exhausted. The default is `stop`. Both numeric limits and resolver depth remain in force. The continuation is a repair and revalidation of a captured failure, with its own receipt, rather than a reservation from either retry budget.

The failure must identify the current captured gate and target. A completed root-cause submission for that failure precedes repair. The control plane checks the unit and unresolved effect ledger, resumes the same owner and unit, binds the submitted correction to the verification target, and reruns the failed gate against new inputs. It retains the failure, policy source, diagnosis, repair and revalidation evidence. A further repair of a gate that remains red requires measured progress: previously failing cases now pass, with no new failing cases. Repeated or reverted input and unchanged or inconclusive outcomes stop progression. An external effect remains subject to its existing reconciliation contract.

## Rationale

An unbounded retry number cannot distinguish a new corrective action from a replay. Evidence-backed continuation permits successive repairs while keeping the default behavior and preventing repeats on unproven or unchanged state. Isolated gate execution supplies the target binding and a repeatable observation. For exhausted product or harness failures whose correction is verified outside the gate runner, a trusted read-only provider proves the correction and successful original reproduction. The same-unit resolution receipt permits ordinary resume with mandatory revalidation. The original numeric counts remain intact and the provider's observation cannot authorize another continuation. Environment and authority failures retain their existing recovery boundaries.
