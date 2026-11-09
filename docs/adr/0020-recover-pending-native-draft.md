# Recover a pending native goal draft without duplicate submission

## Context

Codex 0.167.0 processes slash-popup keys before flushing buffered argument characters. While `/goal` remains the selected command, an unmodified `/` is handled as completion without insertion. Sending the first argument burst before a visible argument settles can therefore drop slashes. A submission fence correctly prevents blind replay but leaves a pre-Return failed draft without a public continuation.

## Decision

The goal composer observes a short first argument outside the command token before writing the remaining objective. Full exact objective/packet verification remains mandatory; missing punctuation never counts as a match.

An existing original submission can recover only with the same binding, no native goal/queue/input, a current complete Ready composer and an engine-recorded pre-Return composer failure. Exact full pending text can continue without typing. The pinned first-burst slash-loss variant is a distinct authorized correction: every other character must match, the objective is one logical line, and a separate durable edit marker is synced before line clearing/retyping. No clipped suffix match authorizes continuation or correction. Foreign, partial, ambiguous, already-started and unsupported drafts are rejected.

A separate durable Return marker is synced before Enter. Marked Return is observation-only even if its response is lost or the goal later disappears. A marked uncertain correction cannot be repeated; only its exact completed pending draft can proceed to a previously unmarked Return. Completed effects remain observation-only. Both boundaries retain original intent/sequence/native identity/packets and repeat native absence plus exact composer verification after owner probes. No direct installed/state edit or new native session is a recovery mechanism.
