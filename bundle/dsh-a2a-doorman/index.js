/**
 * dsh-a2a-doorman — host-plane plugin with two faces over one relay core:
 *
 * 1. the GLOBAL tool `doorman_relay` (legacy path: a relay-preset agent model
 *    calls it per inbound A2A message), and
 * 2. the `a2aDoorman` service, whose `execute(request)` plugs straight into
 *    `@ryubyte/dsh-a2a`'s inbound executor seat
 *    (`- id: a2a` row, `config.execute`, executor priority #1). This is the
 *    preferred path: the A2A task is handed to the watched session directly,
 *    with no throwaway A2A session and no extra model hop.
 *
 * Why: an A2A server normally answers each inbound `SendMessage` inside its own
 * session, so the message never reaches the session a human is actually
 * watching. Both faces close that gap the same way: inject the inbound text
 * into a *watched* GUI session as a normal user turn, wait for that session to
 * go idle, and return the assistant text produced since the injection — so
 * "the reply comes from the target session".
 *
 * Configuration (bundle patch `config`):
 * - `targetSession` (required for the tool): the default watched session id.
 * - `timeoutMs` (optional, default 300000): deadline for one relayed turn.
 * - `routes` (optional): ordered multi-target routing table. Each entry is
 *   { contextIdPrefix? | contextIdExact? | textContains?[], targetSession }.
 *
 * Routing: matching route targets are tried first, then `targetSession`; the
 * first id that is live in this process (`agents.get(id) !== undefined`) wins,
 * so a route whose session is not currently open falls through instead of
 * failing. No live candidate → error naming the candidates.
 *
 * Design notes:
 * - Runs on the host plane (bundle patch insert at profile root), so
 *   `ctx.tools.register` lands in the global layer — visible to every agent.
 * - Zero static imports on purpose: resolution of `@deepseek-ai/*` peers from a
 *   profile-local package is not guaranteed under the profile's pnpm layout, so
 *   the plugin talks to services through `ctx` and builds the user-message
 *   shape by hand (same shape the harness's createUserMessage produces:
 *   { id, role:'user', content:[{type:'text'}], source:{kind:'user'} }).
 * - Timeout DOES NOT cancel the target session: the target is a live GUI
 *   session a human may be driving, so aborting it mid-turn would destroy their
 *   work. On deadline (or caller cancel) the condition is surfaced to the
 *   caller instead.
 * - Relays are serialized per A2A contextId, so two concurrent tasks for the
 *   same conversation never interleave turns in the target session.
 */

const SERVICE_NAME = 'a2aDoorman'

export default {
  name: 'dsh-a2a-doorman',
  inject: ['agents', 'tools'],
  apply(ctx, config = {}) {
    const DEFAULT_TARGET = config.targetSession ?? ''
    const ROUTES = Array.isArray(config.routes) ? config.routes : []
    const TIMEOUT_MS = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 300000
    const agents = ctx.get('agents')
    if (agents === undefined) {
      ctx.logger?.warn?.('dsh-a2a-doorman: agents service unavailable; relay disabled')
      return
    }

    /** One relayed turn: inject text, wait for idle, return the produced reply. */
    const relay = async (text, contextId, signal) => {
      const target = pickLiveTarget(agents, ROUTES, DEFAULT_TARGET, text, contextId)
      if (target === undefined) {
        const candidateIds = [
          ...ROUTES.filter((r) => routeMatches(r, text, contextId)).map((r) => r.targetSession),
          DEFAULT_TARGET,
        ]
        throw new Error(
          `dsh-a2a-doorman: no live target session for relay (candidates: ${candidateIds.join(', ')})`,
        )
      }
      const session = target.session
      // 0.2.2+ removed the synchronous `events` array: use `seq` + `snapshotEvents()`.
      // Keep the old path as a fallback so this bundle still runs on 0.2.1 runtimes.
      const baseline =
        typeof session.seq === 'number' ? session.seq : (session.events?.length ?? 0)
      target.followup(userMessageLike(text))
      await idleWithDeadline(target, TIMEOUT_MS, signal)
      const produced =
        typeof session.snapshotEvents === 'function'
          ? session.snapshotEvents(baseline)
          : (session.events ?? []).slice(baseline)
      return collectReplyText(produced)
    }

    // Serialize per conversation: chain each relay behind its context's tail.
    const tails = new Map()
    const relaySerialized = (text, contextId, signal) => {
      const key = contextId.length > 0 ? contextId : DEFAULT_TARGET
      const prior = tails.get(key) ?? Promise.resolve()
      const run = prior.catch(() => {}).then(() => relay(text, contextId, signal))
      tails.set(key, run)
      return run.finally(() => {
        if (tails.get(key) === run) tails.delete(key)
      })
    }

    // ── face 2: the inbound A2A executor seat ─────────────────────────────────
    ctx.provide(SERVICE_NAME, {
      relay: relaySerialized,
      /** A2A executor contract: ({ message, contextId, signal }) → agent Message. */
      async execute(request) {
        const text = promptFromParts(request?.message?.parts)
        if (text.length === 0) return agentMessage('No prompt provided.')
        if (request?.signal?.aborted) return agentMessage('(canceled)')
        try {
          return agentMessage(await relaySerialized(text, String(request?.contextId ?? ''), request?.signal))
        } catch (err) {
          // Surface the reason as an artifact, like the built-in DSH executor
          // does, instead of failing the task without explanation.
          const reason = err?.message ?? String(err)
          return agentMessage(reason.startsWith('dsh-a2a-doorman:') ? reason : `dsh-a2a-doorman: ${reason}`)
        }
      },
    })

    // ── face 1: the legacy global tool ────────────────────────────────────────
    if (DEFAULT_TARGET.length === 0) {
      ctx.logger?.warn?.(
        'dsh-a2a-doorman: config.targetSession is not set; doorman_relay not registered (a2aDoorman service still available)',
      )
      return
    }

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'doorman_relay',
          description:
            'Inject a piece of text as a fresh user message into the watched target DSH session, wait for that session to finish answering, and return the complete text reply produced by the target session. Use this ONLY when a remote A2A caller sends a message that must be handled by the target session: pass the inbound text as `text`, then answer the caller with exactly this tool\'s returned reply — do not paraphrase, summarise, or answer yourself.',
          parameters: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The exact inbound text to relay into the target session as a user turn.',
              },
              contextId: {
                type: 'string',
                description: 'Optional source A2A context id, used for routing (contextIdPrefix/contextIdExact rules) and logging/de-duplication.',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          timeoutMs: TIMEOUT_MS,
          async execute(args) {
            const text = String(args.text ?? '')
            if (text.trim().length === 0) throw new Error('dsh-a2a-doorman: empty relay text')
            return relaySerialized(text, String(args.contextId ?? ''), undefined)
          },
        }),
      'a2a-doorman.doorman_relay',
    )
  },
}

let seq = 0
function userMessageLike(text) {
  seq += 1
  const id = `doorman-${Date.now().toString(36)}-${seq.toString(36)}`
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** A2A agent message carrying just text (role string mirrors protocol Role.AGENT). */
function agentMessage(text) {
  return { messageId: newMessageId(), role: 'ROLE_AGENT', parts: [{ text }] }
}

function newMessageId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `doorman-${Date.now().toString(36)}-${(seq += 1).toString(36)}`
}

/** Flatten A2A message parts into the prompt relayed to the target session. */
function promptFromParts(parts) {
  const out = []
  for (const part of parts ?? []) {
    if (typeof part?.text === 'string') out.push(part.text)
    else if (part?.url !== undefined) out.push(String(part.url))
    else if (part?.data !== undefined) {
      out.push(typeof part.data === 'string' ? part.data : JSON.stringify(part.data))
    } else if (part?.raw !== undefined) out.push(`[raw ${part.mediaType ?? 'bytes'} part]`)
  }
  return out.join('\n').trim()
}

function idleWithDeadline(agent, ms, signal) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`dsh-a2a-doorman: target session did not go idle within ${ms}ms`)),
      ms,
    )
  })
  const races = [agent.whenIdle(), deadline]
  if (signal !== undefined) {
    races.push(
      new Promise((_, reject) => {
        if (signal.aborted) reject(new Error('dsh-a2a-doorman: relay canceled by caller'))
        else {
          signal.addEventListener(
            'abort',
            () => reject(new Error('dsh-a2a-doorman: relay canceled by caller')),
            { once: true },
          )
        }
      }),
    )
  }
  return Promise.race(races).finally(() => clearTimeout(timer))
}

/** Assistant text blocks of the events produced during one relayed turn. */
function collectReplyText(events) {
  const texts = []
  for (const event of events ?? []) {
    if (event?.type !== 'assistant/message') continue
    for (const block of event?.data?.message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        texts.push(block.text.trim())
      }
    }
  }
  return texts.length > 0 ? texts.join('\n') : '(the target session produced no text reply this turn)'
}

function routeMatches(route, text, contextId) {
  if (route.contextIdExact && contextId === route.contextIdExact) return true
  if (route.contextIdPrefix && contextId.startsWith(route.contextIdPrefix)) return true
  if (Array.isArray(route.textContains)) {
    const lower = text.toLowerCase()
    if (route.textContains.some((k) => lower.includes(String(k).toLowerCase()))) return true
  }
  return false
}

/** First live agent among matching routes' targets, then the default target. */
function pickLiveTarget(agents, routes, fallback, text, contextId) {
  const candidates = []
  for (const route of routes ?? []) {
    if (routeMatches(route, text, contextId)) candidates.push(route.targetSession)
  }
  candidates.push(fallback)
  for (const id of [...new Set(candidates)]) {
    const agent = agents.get(id)
    if (agent !== undefined) return agent
  }
  return undefined
}
