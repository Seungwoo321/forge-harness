# 0046 — Correlate submitted startup through the immutable receiver

## Context

Native applications can change a terminal or workspace title before a managed goal starts. Rediscovering an already submitted receiver through its launch title then loses the exact process even though its durable submission still identifies it. Polling and the effect executor also discard the first execution error, leaving only later generic non-start observations.

## Decision

The host creation response supplies a worktree ID rather than a directory path. Its handle, incarnation and local execution host are checked against a fresh terminal lookup; that lookup must retain the acknowledged worktree and supply the exact requested directory before the receiver observation is appended. A changed incarnation or worktree refuses binding.

An Orca creation acknowledgement appends a separate receiver observation under its original startup intent before process polling. It fixes the host-created runtime, session, incarnation and directory even when foreground evidence is not yet ready or the title changes. It is neither a native input fence nor a task-start receipt. After a durable submission exists, its full native binding supersedes this creation observation. Native process, incarnation, thread, objective and packet validation remain mandatory; failure never falls back to another receiver or authorizes repeated input. Recovery proof must also match any recorded host-created receiver. Titles remain discovery hints only for older intents without either binding.

Polling retains its first failure when no observation succeeds. A failed goal-start execution appends that error as an unknown verification under the original intent before later reconciliation. This is diagnostic evidence, not proof of non-application. Existing submission and Return fences remain authoritative, and an uncertain original attempt requires the normal verified recovery contract before another attempt can start.
