# A2A wire notes

Operational contract for talking to a `dsh-a2a` endpoint fronted by
`ds-a2a-doorman`. Written from observed behaviour; treat it as the shared
reference between the harness side and any A2A peer.

## 1. Endpoint and authentication

| Item | Value |
|---|---|
| Base URL | your deployment's public address, e.g. `https://harness.example.com` (the A2A server listens on `:8899` by default) |
| Agent path | `/agents/<slug>/`, fixed by the server's `agents` configuration (do not let it drift with preset changes) |
| Agent card | `/agents/<slug>/.well-known/agent-card.json` — the only unauthenticated route |
| Everything else | `Authorization: Bearer <token>`; a `401` means the token is wrong |

Multiple addresses for the same server are a common footgun: peers often reach
one address but not another (VPN vs LAN vs loopback). Verify reachability from
the *peer's* network position, then pin the working address in the peer's config
instead of leaving a stale alias around.

## 2. Sending a message

JSON-RPC 2.0. **`params` must be nested** — the server validates the A2A v1
schema, and a flat `params: {messageId, parts}` payload is rejected with:

```
-32602  message.messageId is required
```

Canonical request:

```bash
curl -sS -X POST "$BASE_URL/agents/standard/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --max-time 320 \
  -d "$(jq -n --arg id "$MSG_ID" --arg t "$TEXT" \
    '{jsonrpc:"2.0",id:$id,method:"SendMessage",
      params:{message:{messageId:$id,role:"user",parts:[{kind:"text",text:$t}]}}}')"
```

A successful delivery answers `HTTP 200` with a `result.task` whose
`status.state` is `TASK_STATE_COMPLETED` and whose `status.message.parts[0].text`
is the watched session's reply.

### Server-side receipt check

Every accepted message materialises a durable relay session on the harness side
(one per `contextId`). That directory is the authoritative "it arrived" signal —
more reliable than any client-side bookkeeping:

```bash
ls "$A2A_SESSION_DIR"   # one directory per context id
```

## 3. Semantics and timeouts

- **Synchronous long-poll.** `SendMessage` returns only when the watched session
  has answered or the relay deadline (`timeoutMs`, default 300 s) expires. Give
  the client a timeout *above* that deadline; `--max-time 320` is a sane value.
  A 30-second client timeout produces a timeout error with zero bytes and looks
  exactly like a delivery failure while the message is in fact being processed.
- **A timeout is not a delivery failure.** If a zero-byte/timeout response is
  followed by a relay session appearing on the harness side, the message was
  delivered; do not resend it blindly.
- **Busy target queues.** If the watched session is mid-turn, the message is
  spliced into its inbox and consumed on the next turn. Delivery is not lost;
  only the HTTP call is delayed (and may hit the caller's timeout).
- **No partial/deferred acknowledgement.** The server has no
  `{deferred: true, retry_after_s}` style response: a caller cannot distinguish
  "busy", "throttled" and "slow" from the wire alone. Design peer retries
  accordingly (§6).
- **One session per `contextId`.** Reuse a context id to continue in the same
  relay session; a new context id creates a new one.

## 4. Identity and the echo contract

- Treat a **message id** (e.g. `MSG-YYYYMMDD-NN`) as the external contract
  between the two sides: the peer sends it, and the harness reply should echo it
  on the first line so replies can be correlated in logs across days.
- The harness's internal identifiers (session ids, per-turn message ids such as
  `doorman-*`) are **implementation details** and should not appear on the wire
  or in the reply header. Correlate on the message id, not on internal ids.

## 5. Routing

`ds-a2a-doorman` can dispatch different conversations to different GUI sessions
(see `docs/DESIGN.md` §5). Rules are matched in order on:

- `contextIdExact` / `contextIdPrefix` — precise, when the relay model passes
  the A2A context id; and
- `textContains` — keyword fallback that requires nothing from the caller.

The first **live** candidate wins; otherwise delivery falls back to the default
target. A route pointing at a session that is not open is therefore harmless,
and cross-topic leakage is avoided without the peer having to know anything
about session management.

## 6. Interop lessons

These came out of running a real peer integration and are worth designing for:

1. **Nested payloads or bust.** Validate your client against the server's schema
   before blaming the network (§2).
2. **Client timeout > relay deadline**, always.
3. **Receipt by side effect, not by response.** Use the harness-side session
   directory as the arrival signal when a response is missing.
4. **Retry idempotently.** Because "no response" and "delivered" can look alike,
   attach a stable content identifier to notifications and agree that the
   receiver integrates a given identifier once and ignores duplicates. Retries
   that mint new ids create duplicate work.
5. **Throttling can be reported while the message still gets through.** A
   rate-limit error on a control channel does not prove the payload was dropped;
   check for a receipt before re-sending.
6. **Do not stack delivery layers.** A queue-based delivery path in front of the
   direct HTTP call adds a second, weaker acknowledgement mechanism (and its own
   orphaned state). One reliable path beats two half-reliable ones.
7. **Keep one source of truth for the contract.** Duplicated protocol
   documentation drifts within days; make one side authoritative and have the
   other read/patch from it.
