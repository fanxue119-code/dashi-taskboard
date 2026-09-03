---
name: manage-taskboard
description: Manage taskboard work with taskctl. Use for e-taskboard prompts, issue IDs from any project, status sync, or comments.
---

# Manage Taskboard

Use `taskctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Core workflow

1. For an existing issue, first run `issue get` and `comment list`. Read the description and latest comments before deciding whether to start. Treat comments as current requirements, including returned work. If they say to wait, not execute, or not start now, stop and report without changing the status.
2. If work may start, claim it before reading code, downloading attachments, analyzing the implementation, or doing any other task work. Move a claimable `todo` to `in_progress` with its current `version`; if returned work is in `in_review`, the latest comment or user message authorizes the return, and it is bound to the current conversation, move it back to `in_progress` with its current `version` before continuing. Do not continue until the move succeeds. If it is already `in_progress`, continue only when it is bound to the current conversation. Never move an issue claimed by another conversation.
3. If the move conflicts because the `version` is stale, run `issue get` and `comment list` again. Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another conversation, is not archived, and its description and latest comments are unchanged. If it was claimed, its status or requirements changed, it is archived, a permanent API error occurs, or the retry fails, stop and report. Treat `STALE_RUNTIME_ENDPOINT`, `INVALID_RUNTIME_DESCRIPTOR`, `INVALID_INSTANCE_CHALLENGE`, `SERVICE_UNAVAILABLE`, and `Route not found` as a failed Taskboard entrypoint. Before a successful claim or when the binding is unknown, stop business work and never take over another agent's claim. If this conversation was already successfully established as the issue's primary execution thread and the user explicitly asks it to continue or supplies new material, continue only inside the existing issue scope, tell the user that board synchronization is deferred, and retry the status/comment sync once after the entrypoint recovers or on the next turn. Entry failure never authorizes a different issue, a binding conflict, or a risky action. Never loop.
4. For a new durable requirement, run `context current` and search existing project issues before creating one. Update a matching issue instead of creating a duplicate. Do not track trivial requests.
5. Execute only the requested work in the issue's branch or worktree when one is bound.
6. Verify the requested operation path. Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then move it to `in_review` with its current `version`.
7. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## Other operations

- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Let `taskctl` read `CODEX_THREAD_ID` for writes. Outside Codex, pass the exact conversation ID with `--thread-id`.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.
