# Recognize the measured hintless Ready composer

## Context

Codex 0.167.0 can render a full configured status line with model, cwd, branch, Ready and a clipped remaining segment, omitting the separate shortcuts hint row. Result delivery rejects this measured empty composer before its durable submission boundary.

## Decision

Result delivery additionally recognizes the complete measured hintless footer grammar, anchored to the last nonempty row and including model/effort, absolute or home-relative cwd, optional branch, exact Ready status and clipped tail with optional warning controls. It retains every composer row before that footer when comparing a wrapped reference. Arbitrary Ready text is not a footer. Working, unknown footer/status, foreign or clipped drafts and modals remain rejected before input. Existing hinted narrow footers remain supported.

The change does not alter native absence/activity evidence, durable submission and separate Return fences, original effect sequence/recipient/packets or retry records. Actual recovery stays on the same public finalize intent; no result receipt or completion is inferred from the screen.
