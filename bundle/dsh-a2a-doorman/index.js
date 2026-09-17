/**
 * dsh-a2a-doorman — host-plane plugin registering the GLOBAL tool
 * `doorman_relay`, which the relay preset's agent model is instructed to call
 * for every inbound A2A message.
 *
 * Why: `dsh-a2a` answers each inbound A2A `SendMessage` inside its own
 * throwaway `a2a-*` session, so the message never reaches the session a human
 * is actually watching. This plugin closes that gap: the relay session calls
 * `doorman_relay`, which injects the inbound text into a *watched* GUI session
 * as a normal user turn and returns that session's reply as the A2A result.
 *
 * Tool semantics: inject `text` into the resolved target session as a fresh
 * user turn, wait for that session's driver to go idle, then return the
 * assistant text produced since the injection — so "the reply comes from the
 * target session".
 *
 * Configuration (bundle patch `config`):
 * - `targetSession` (required): the default watched session id. The plugin does
 *   not register the tool when this is missing.
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
 *   `ctx.tools.register` lands in the global layer — visible to every agent,
 *   including the dsh-a2a-created `a2a-*` sessions.
 * - Zero static imports on purpose: resolution of `@deepseek-ai/*` peers from a
 *   profile-local package is not guaranteed under the profile's pnpm layout, so
 *   the plugin talks to services through `ctx` and builds the user-message
 *   shape by hand (same shape the harness's createUserMessage produces:
 *   { id, role:'user', content:[{type:'text'}], source:{kind:'user'} }).
 * - Timeout DOES NOT cancel the target session: the target is a live GUI
 *   session a human may be driving, so aborting it mid-turn would destroy their
 *   work. On deadline the timeout is surfaced to the caller instead.
 */

export default {
  name: 'dsh-a2a-doorman',
  inject: ['agents', 'tools'],
  apply(ctx, config = {}) {
    const DEFAULT_TARGET = config.targetSession ?? ''
    const ROUTES = Array.isArray(config.routes) ? config.routes : []
    const TIMEOUT_MS = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 300000
    const agents = ctx.get('agents')
    if (agents === undefined) {
      ctx.logger?.warn?.('dsh-a2a-doorman: agents service unavailable; doorman_relay not registered')
      return
    }
    if (DEFAULT_TARGET.length === 0) {
      ctx.logger?.warn?.(
        'dsh-a2a-doorman: config.targetSession is not set; doorman_relay not registered',
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
            const contextId = String(args.contextId ?? '')
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
            const baseline = target.session.events.length
            target.followup(userMessageLike(text))
            await idleWithDeadline(target, TIMEOUT_MS)
            const produced = target.session.events.slice(baseline)
            return collectReplyText(produced)
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

function idleWithDeadline(agent, ms) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`dsh-a2a-doorman: target session did not go idle within ${ms}ms`)),
      ms,
    )
  })
  return Promise.race([agent.whenIdle(), deadline]).finally(() => clearTimeout(timer))
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
