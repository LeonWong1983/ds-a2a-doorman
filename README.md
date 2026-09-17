# ds-a2a-doorman

**Bridge inbound [A2A](https://a2a-protocol.org/) messages into the DeepSeek Harness session you are actually watching — and send that session's reply back to the caller.**

`dsh-a2a` already speaks A2A: it accepts `SendMessage` over JSON-RPC, runs each request in its own durable session, and returns the result. The catch is *where* it runs it: every inbound message is answered inside a throwaway `a2a-*` session, isolated from the GUI session a human is driving. The caller gets an answer from a session nobody is watching, and you never see the inbound message at all.

`ds-a2a-doorman` closes that gap. It adds a global `doorman_relay` tool plus a *pure relay* agent preset, so an inbound A2A message is injected into your watched session as a normal user turn and the reply is exactly what that session produced.

```
  A2A caller                     dsh-a2a (host)                  watched GUI session
 (any A2A agent,    ──SendMessage──▶  a2a-* relay session  ──doorman_relay──▶  your session
  another harness)   ◀──task result──   (preset: a2a-relay)   ◀──reply text──   (a real user turn)
```

## How it works

1. **`dsh-a2a`** accepts `POST /agents/<slug>/` with a JSON-RPC `SendMessage` and creates (or reuses) a durable session per `contextId`. Those sessions use a dedicated agent preset.
2. **The relay preset** (`a2a-relay`, installed by this repo) turns that session into a stateless forwarder: its persona instructs the model to call `doorman_relay` with the exact inbound text and to return the tool's output verbatim — never answering on its own.
3. **`doorman_relay`** (this repo's bundle, registered on the host plane so it is visible to *every* agent) injects the text into the configured **target session** via the agent's `followup()`, waits for that session to go idle, and returns the assistant text produced in that turn.
4. The relay session echoes that text back as the A2A task result, so `TASK_STATE_COMPLETED` carries the reply of your watched session.

Because injection goes through the same path as a typed user message, the target session treats it as a real turn: it appears in the transcript, streams in the GUI, and can be interrupted or steered like anything else.

## Features

- **Global tool, zero coupling** — `doorman_relay` lives on the host plane and is available to dsh-a2a relay sessions without patching them.
- **Multi-target routing** — send different traffic to different sessions, matched by A2A `contextId` prefix/exact value or by text keywords. A route whose session is not currently open is skipped, falling back to the default target instead of failing.
- **Durable by construction** — if the target session is busy, the message is queued into its inbox and consumed on the next turn; it is not dropped.
- **No session hijacking** — on timeout the relay reports the timeout. It never cancels the target session, because a human may be working in it.
- **Reply fidelity** — only assistant text produced *after* the injection is returned, so no transcript history leaks into the reply.

## Requirements

- A working DeepSeek Harness install with the `dsh-a2a` bundle serving an A2A endpoint.
- Node.js ≥ 22.19 (the bundle is a plain ESM module with zero runtime dependencies).
- A GUI session you want to act as the "front desk" — you will need its session id.

## Install

### Option A — helper script

```bash
node tools/install-a2a-relay-preset.mjs
```

It copies the shipped `standard` preset to `<harness-home>/.agent-presets/a2a-relay/`, rewrites its persona into the pure-relay persona, adds this bundle to `profiles/web/package.json`, and points the web profile's server preset at `a2a-relay`. It prints a summary and never touches running processes.

Useful environment variables: `DSH_HOME` (harness home, default `~/.dsh`) and `DSH_PRESET_ROOT` (directory containing the shipped `standard` preset), if auto-detection fails.

### Option B — manual

1. Copy this repo's `bundle/dsh-a2a-doorman/` somewhere stable and add it to the web profile as a dependency (`file:` or git reference).
2. Add `dsh-a2a-doorman` to `dsh.profile.bundles` in `profiles/web/package.json`.
3. Put the bundle patch row from `bundle/dsh-a2a-doorman/cordis.patch.yml` into `profiles/web/cordis.patch.yml` and set **`targetSession`** to your watched session id.
4. Create the `a2a-relay` preset (copy of `standard` with the relay persona) and set `server.preset: a2a-relay`.
5. **Restart `dsh web`** — host-plane plugins are loaded at startup.

> The default config in this repo ships with a placeholder session id on purpose. Nothing is hard-coded to the maintainer's machine.

## Configuration

```yaml
- insert:
    - id: a2a-doorman
      name: dsh-a2a-doorman
      config:
        targetSession: session-REPLACE-WITH-YOUR-SESSION-ID  # required
        timeoutMs: 300000                                    # optional, default 5 min
        sessionPrefix: a2a-                                  # informational
        routes:                                              # optional
          - textContains: [project-alpha]
            targetSession: session-REPLACE-WITH-ALPHA-ID
```

| Key | Meaning |
|---|---|
| `targetSession` | Default watched session. **Required** — without it the tool is not registered and a warning is logged. |
| `timeoutMs` | Deadline for one relayed turn. On expiry the caller receives a timeout error; the target keeps running. |
| `routes` | Ordered routing table. Each entry may match on `contextIdExact`, `contextIdPrefix`, and/or `textContains` (case-insensitive). First **live** candidate wins, then `targetSession`. |

## Verify

```powershell
pwsh -File scripts/probe-a2a.ps1 -Key <bearer-token> -Text 'hello from the probe'
# or:  $env:A2A_TOKEN = '<token>'; pwsh -File scripts/probe-a2a.ps1 -Text 'hi'
```

Then confirm two things: the text shows up as a fresh user turn in your watched session, and the script prints a `TASK_STATE_COMPLETED` result whose text is that session's answer.

Two protocol details worth knowing up front:

- **`params` must be nested** (`params.message.{...}`). A flat `params:{messageId, parts}` payload is rejected with JSON-RPC `-32602`.
- **`SendMessage` is a synchronous long-poll** that returns only when the target session has answered, so give your HTTP client a timeout above the relay deadline (the probe defaults to 320 s).

## Operational notes

- **Busy target = queued, not lost.** Injection uses `followup()`, so it lands in the session inbox for the next turn. The HTTP call still returns when the relay's own deadline expires.
- **One session per `contextId`.** Reuse a context id to continue in the same relay session; a new one creates a new isolated session.
- **Keep credentials out of the repo.** The bearer token is a shared secret between you and your A2A peer — pass it via an environment variable, never as a committed default (the probe script reflects this).
- **Restart to apply.** Bundle code and patch config are read when `dsh web` starts; editing them requires a restart.

## Repository layout

| Path | Contents |
|---|---|
| `bundle/dsh-a2a-doorman/` | The plugin: `index.js` (global `doorman_relay`), `cordis.patch.yml`, `package.json` |
| `tools/install-a2a-relay-preset.mjs` | Installs the relay preset + profile wiring |
| `tools/decode-zstd.mjs` | Decodes multi-frame `.jsonl.zstd` session logs to plain JSONL (handy for debugging) |
| `scripts/probe-a2a.ps1` | Sends one authenticated `SendMessage` and prints the task result |
| `docs/DESIGN.md` | Architecture, verified harness internals, and design decisions |
| `docs/a2a-wire-spec.md` | Protocol and operating contract (payload shape, timeouts, ids, routing) |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `doorman_relay` not in the tool list | `targetSession` not set, or `dsh web` was not restarted after install |
| `-32602 message.messageId is required` | Flat `params`; use nested `params.message` |
| Caller times out with no bytes | Client timeout shorter than the relay deadline — raise it above `timeoutMs` |
| `no live target session for relay` | The configured session is not open in the GUI (session ids change per install) |
| Reply says the target produced no text this turn | The target was busy when the message was injected; it will answer on its next turn |

## License

MIT — see [LICENSE](LICENSE).
