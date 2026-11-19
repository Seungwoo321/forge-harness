# 0071 — Claude prompt suggestions and authorized delivery retry

## Prompt suggestions

A Claude recipient can show a contextual prompt suggestion in an otherwise empty input box. The plain screen text cannot tell that suggestion apart from a typed draft. Result delivery therefore refused it as "another draft", and each finalize retry failed the same way.

Claude renders both its placeholder and its suggestions with every input cell faint. Text the user types is never faint. The cmux delivery reads the render grid (`terminal.replay`) for the exact receiver surface. It treats the input box as empty only when its row has visible text and every visible cell is faint. A partly faint, typed, unreadable or foreign-surface box is still another draft. Paste, settle and Return-boundary checks are unchanged. Recipients can also set `promptSuggestionEnabled: false`, but delivery does not require it, because the recipient may be an existing user session.

## Authorized retry after an exhausted budget

A delivery that failed before any input is retried by a later finalize. The retry is bounded by `retry.maxPerSignature`, counting failed executions of the same intent. When a defect caused those failures and a fixed release is installed, the intent has no public way forward.

`unit finalize <unit> --retry-delivery --user-input <ref>` reopens that budget once, and only for the exact unresolved `session.deliver` intent with no `submission` or `result` row. The trusted `verifyUserInput` must return the binding `{effect:'unit.finalize.retry-delivery',unit,key,seq,failedAttempts,userInputRef}` with `verified:true`.

The ledger then appends a `delivery-retry-authorization` row. Failed attempts are counted again only after the latest such row. When the budget is not exhausted, the option adds no row. Submitted or resolved deliveries keep their receipt and duplicate rules. The original intent, failures and verifications are preserved.

## Mode-only footer

While background shells or agents are listed, Claude drops `(shift+tab to cycle)` from its mode hint. The composer is therefore also identified by a mode hint row (`⏵⏵ …` or `⏸ …`) below its bottom rule. Without that, a pasted reference stopped before Return.

## Shell packet reads

Claude recipients often read a packet with a shell command, for example `cat` and `shasum`, instead of the Read tool. The packet is proven read under either of these conditions:

- a Read result returns its exact numbered lines;
- a non-error Bash result, whose command names the packet path, contains the packet's exact content.

Truncated, partial, failed or unrelated output stays unproven. An already received return then reconciles through an ordinary finalize, with no new recovery operation.
