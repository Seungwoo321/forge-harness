---
name: scope
description: Fix the request scope, acceptance criteria, and allowed paths for a unit.
---

# Scope

Read only the StageInput file named by the unit driver. Use its request, canonical references, and policy to define the work boundary.

1. Return a complete `StageOutput` matching `contract.json`. Keep the acceptance list stable after this stage; later stages cannot replace it.
2. Make acceptance criteria observable and atomic. Set `scopePaths` to the smallest complete set of paths needed for the request.
3. Resolve technical choices when the canonical direction, acceptance criteria, existing code conventions, or a named design principle leaves one valid choice. Record each choice in `assumptions` with `decision`, `basis`, and `reversible`; do not ask the user about it or create an `openDecisions` entry.
4. Use `openDecisions` only when multiple choices remain and the answer changes product meaning, UX, price, risk tolerance, external authority, or canonical direction. Defer only the acceptance criteria that actually depend on the answer.
5. Do not infer user intent from repository clues. Do not read or write Unit Record, policy, evidence, failure, or ledger files. Submit only through the unit driver.
