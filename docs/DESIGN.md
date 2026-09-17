# Design notes

This document records *why* `ds-a2a-doorman` looks the way it does, what was
verified empirically about DeepSeek Harness internals, and which alternatives
were rejected.

## 1. The gap

`dsh-a2a` is a harness bundle that exposes an A2A JSON-RPC endpoint
(`/agents/<slug>/`). For each inbound `SendMessage` it creates or reuses a
durable session keyed by `contextId`, runs the message through that session's
agent, and returns the produced text as the task result.

That design is correct for a headless agent, but wrong for a *human-attended*
one: the inbound message is answered by a session the user never opens. From the
user's point of view the A2A peer is talking to a stranger. Two things are
missing:

1. the inbound message must appear **in the session the user is watching**, as a
   normal user turn; and
2. the A2A reply must be **that session's answer**, not an independent one.

## 2. Design options considered

| Option | Idea | Outcome |
|---|---|---|
| **A. Event tap** | A host-plane plugin listens on `agent/inbox/inserted`, filters sessions by id prefix, and `followup()`s the text into the target session. No preset change. | Feasible and verified, but passive: it must re-implement message de-duplication, and it fires for *every* session event, including ones it should ignore. Kept as a documented alternative. |
| **B. Global tool + relay preset** | Register a global `doorman_relay` tool on the host plane; give dsh-a2a's sessions a *pure relay* persona that calls it and echoes the result. | **Shipped.** The decision to forward is explicit and auditable (it happens in a tool call), the relay session stays stateless, and the reply is returned through the normal A2A result path. |
| **C. Patch the executor** | Modify dsh-a2a's executor to accept a "target session" option. | Rejected. It forks a third-party bundle and has to be re-applied on every upgrade. |

The shipped approach deliberately avoids static imports and touches no
`@deepseek-ai/*` package internals, so it survives harness upgrades as long as
the agent/event surfaces it uses stay stable.

## 3. Verified harness internals

Verified against a DeepSeek Harness build of **September 2026** by inspecting the
running services (`ctx.inspect`) and by reading session logs. These are the
assumptions the plugin depends on; re-verify them after a harness upgrade.

1. **`ctx.get('agents')` is reachable** from a plugin context without a prior
   `inject` declaration — `get` performs an optional lookup. It returns the
   agent registry, which is registered at host scope.
2. **Unscoped listeners receive every agent's inbox events.**
   `agent/inbox/inserted` is dispatched through a scope-target carrier that
   *admits listeners whose context carries no scope tag*. A host-plane plugin
   context is untagged, so it observes insertions for all sessions — including
   the `a2a-*` sessions created by dsh-a2a. (This is what makes option A
   possible at all.)
3. **`SessionId` is a plain string at runtime**, so `agents.get(id)` accepts a
   session id directly; no branding/wrapping is required.
4. **An injected message is a harness `UserMessage`**, not an A2A SDK payload:
   `{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }`.
   Text lives in `content` blocks, not in `parts`.
5. **`agent.followup(message)` is the same path a typed message takes** —
   internally `send(message, 'next-turn', wakeup=true)`, which splices the
   message into the durable inbox and wakes the driver.
6. **Completion is observable** via `agent.whenIdle()`; the turn's output is the
   `assistant/message` events appended to `agent.session.events` after the
   injection point. Collecting from a baseline length avoids returning
   transcript history.
7. **Host-plane tool registration lands in the global layer**, so a tool
   registered by a host bundle is visible to sessions composed from *any*
   preset — including the dsh-a2a relay sessions. This is why the tool approach
   (option B) works without patching the relay preset's tool list.

### Why the reply is collected rather than awaited

`doorman_relay` snapshots `target.session.events.length`, injects, awaits
idleness, then slices the events appended since the snapshot. Only
`assistant/message` text blocks are joined. Consequences:

- no history echo, even if the target session is long;
- tool calls, reasoning, and status events are ignored — the A2A caller receives
  prose only;
- if the target produces no text (for example it was busy and the message was
  deferred to a later turn), the tool returns an explicit
  "no text reply this turn" placeholder rather than blocking forever.

## 4. Timeout and busy semantics

- **The target is never cancelled.** It is a live session a human may be
  driving; aborting it mid-turn would destroy their work. On deadline,
  `doorman_relay` throws a timeout error, and the relay session returns that
  error text verbatim to the caller.
- **Busy target ⇒ queued, not lost.** Injection goes into the durable inbox, so
  the message is consumed on the next turn. The HTTP call itself still ends when
  the relay deadline expires, which the caller sees as a long wait or a timeout.
- **Client timeout must exceed the relay deadline.** The A2A `SendMessage` call
  is a synchronous long-poll. A 30-second client timeout is a caller-side bug,
  not a delivery failure.

## 5. Multi-target routing

A single watched session is the common case, but different A2A conversations can
belong to different projects. `config.routes` therefore allows an ordered table:

```yaml
routes:
  - contextIdPrefix: team-alpha
    targetSession: session-<alpha>
  - textContains: [project-beta, beta-report]
    targetSession: session-<beta>
```

Resolution order for one relay:

1. every route that matches (`contextIdExact` → `contextIdPrefix` →
   `textContains`, case-insensitive), in table order;
2. then `targetSession`;
3. pick the **first candidate that is live** in this process
   (`agents.get(id) !== undefined`).

Two deliberate properties:

- **Live-only matching** means a route pointing at a closed session degrades to
  the default target instead of failing the delivery.
- **`contextId` is optional.** Routing works on message text alone, because the
  relay persona is only required to pass text. Context-based rules are more
  precise when the relay model supplies the id.

If no candidate is live the tool throws an error naming every candidate, which
the caller sees as the task result.

## 6. Security and hygiene

- **The bearer token is a shared secret.** It is passed to the probe script via
  `-Key` or `A2A_TOKEN` and is never given a committed default. Rotate it if it
  was ever placed in a file that left the machine.
- **Session ids are instance-specific, not secrets** — but they are meaningless
  on another machine, so the shipped config uses placeholders rather than the
  maintainer's ids.
- **The relay session holds no state and no history of its own.** It has no file
  or shell tools by policy (its persona forbids using them); the watched session
  is the only authority. Treat the A2A endpoint's authentication as the real
  security boundary.
- **Prompt injection is inherent to the pattern.** Inbound text becomes a user
  turn in a session that may hold powerful tools. Restrict who can reach the A2A
  endpoint, and prefer a dedicated watched session if the peer is only
  semi-trusted.

## 7. Debugging toolkit

- `tools/decode-zstd.mjs` decodes harness session logs
  (`<harness-home>/sessions/<project>/<session>/session.jsonl.zstd`), which are
  *concatenated* zstd frames — one frame per flush — so a naive decompressor
  fails. The script scans frames the same way the harness's own persistence
  layer does, then prints the event types it found.
- Injection is observable in the log as, in order: `agent/inbox/spliced`
  (target `next-turn`) → `user/message` → the target's `assistant/*` events. If
  the first event exists but the second does not, the message was spliced into
  the inbox but not yet claimed by a turn — the signature of a busy target.
- `scripts/probe-a2a.ps1` reproduces the caller side end to end.

## 8. Limitations

- **Verified against one harness build.** The plugin relies on documented-by-
  inspection behaviour (see §3); a harness upgrade can invalidate it. The
  fallbacks are intentionally explicit (warnings instead of silent no-ops).
- **Text-only relay.** Only text blocks are forwarded in, and only assistant
  text is returned out. A2A file/artifact parts are not bridged.
- **One relay hop.** The tool returns the target's reply to the A2A caller; it
  does not attempt to keep the relay session in sync with the target's later
  turns.
- **No streaming.** The A2A result is produced once the target goes idle;
  callers see a single completed task rather than incremental updates.
