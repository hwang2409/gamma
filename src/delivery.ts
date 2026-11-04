import type { RunEvent } from "@fulcrum/core";
import type { ZetaClient } from "@fulcrum/zeta";

/** Zeta errors that mean the turn changed state between the click and the server: -32004 running, -32005 not running. */
const TURN_RUNNING = -32004;
const NO_TURN = -32005;
const DETAILS_EVICTED = -32010;
const code = (error: unknown) => (error as { code?: unknown } | null)?.code;

type Accepted = { accepted?: boolean; status?: string };

/** One message the user asked for. `intent` names it for its whole life; `id` names one attempt to deliver it. */
type Message = { text: string; intent: string; id: string | null };
type Method = "send" | "steer";

/** Whether the turn changed state between the click and the server, so the other method should run instead. */
const raced = (method: Method, error: unknown) => code(error) === (method === "steer" ? NO_TURN : TURN_RUNNING);
const refusal = (result: Accepted) => new Error(result.status === "dropped" ? "the server dropped this message before the turn took it; send it again" : "the server did not accept this message");

/**
 * Sends the composer's draft to zeta: `send` starts a turn, `steer` adds to the running one. With the negotiated
 * `delivery_id` feature every attempt carries an id, and a retry of the same text reuses it, so a retry after a timeout
 * or a dropped socket can never deliver the message twice (docs/serve-protocol.md, "client delivery IDs"). The id is
 * dropped once the server has accepted or definitely dropped the message, so the next message gets a fresh one. When
 * the turn starts or ends between the click and the server, the other method runs once with the same id.
 *
 * Zeta delivers a steer at the next provider boundary of the running turn. A turn that ends first (a final answer with
 * no tool call) drops it, and the protocol leaves the resend to the client. `turnEnded` does that, as the zeta TUI does:
 * each dropped steer goes out again as a new message, in order, with a new delivery id. After a stop the user meant to
 * drop them, so they stay dropped, and `turnEnded` names them so the view can show they never reached the agent.
 *
 * Each message keeps one `intent` across every attempt, and the client stamps it on zeta's `user_message` echo, so the
 * steer's row becomes the resent message's row: the user sees one row per message they wrote.
 */
export function createDelivery(newId: () => string = () => `web-${crypto.randomUUID()}`, reconcile?: (event: RunEvent) => void) {
  let unsettled: Message | null = null;
  let steers: Message[] = [];
  // The user's stop of the running turn: resolves to whether it ended the turn (it failed, or found no turn: false).
  let stopping: Promise<boolean> | null = null;
  const request = async (client: ZetaClient, method: Method, { text, id, intent }: Message) => {
    try {
      return (await client.request(method, { text, ...(id ? { delivery_id: id } : {}) }, { timeoutMs: 15_000, intent })) as Accepted;
    } catch (error) {
      // The id was accepted before, but the server no longer has its result: its outcome still says what happened.
      const outcome = (error as { data?: { outcome?: unknown } }).data?.outcome;
      if (code(error) === DETAILS_EVICTED) return { accepted: outcome !== "dropped", status: String(outcome) };
      throw error;
    }
  };
  /** Delivers one attempt; a steer that zeta queued is remembered, since the turn may still drop it. */
  const deliver = async (client: ZetaClient, method: Method, message: Message) => {
    let used = method;
    let result: Accepted;
    try {
      result = await request(client, method, message);
    } catch (error) {
      if (!raced(method, error)) throw error;
      used = method === "steer" ? "send" : "steer";
      result = await request(client, used, message);
    }
    if (used === "steer" && message.id && result.accepted !== false) steers.push(message);
    return { result, used };
  };
  const reconcileAccepted = (message: Message, used: Method, result: Accepted) => {
    if (result.accepted === true && message.id && reconcile)
      reconcile({ type: "user_message", text: message.text, mode: used, intent: message.intent, delivery_id: message.id });
  };
  const fresh = (client: ZetaClient, text: string): Message => {
    const intent = newId();
    return { text, intent, id: client.features.includes("delivery_id") ? intent : null };
  };
  const dropped = async (client: ZetaClient, id: string) => {
    const { status, outcome } = (await client.request("delivery_status", { delivery_id: id }, { timeoutMs: 15_000 })) as { status?: string; outcome?: string };
    return status === "dropped" || (status === "evicted" && outcome === "dropped");
  };
  return {
    async submit(client: ZetaClient, text: string, steer: boolean) {
      const message = unsettled?.text === text ? unsettled : fresh(client, text);
      unsettled = message;
      const delivered = await deliver(client, steer ? "steer" : "send", message);
      unsettled = null;
      if (delivered.result.accepted === false) throw refusal(delivered.result);
      reconcileAccepted(message, delivered.used, delivered.result);
    },
    /** Stops the running turn (zeta's default session-scope abort); `turnEnded` then knows the user ended it. */
    stop(client: ZetaClient) {
      const request = stopTurn(client);
      stopping = request.then((result) => (result as { aborted?: boolean } | null)?.aborted !== false, () => false);
      return request;
    },
    /**
     * Call when the running turn ends. Resends the steers it dropped, unless the user's stop ended it: then they stay
     * dropped, and their intents are returned so the view can mark those rows as not delivered. A stop that failed or
     * found no turn is not a stop: the turn ended on its own, so its dropped steers are resent.
     */
    async turnEnded(client: ZetaClient) {
      const ended = steers;
      steers = [];
      const stopped = await (stopping ?? false);
      stopping = null;
      const undelivered: string[] = [];
      // A query that fails (a dropped socket) leaves its steer unmarked, the safe side; the others still count.
      const statuses = await Promise.allSettled(ended.map((message) => dropped(client, message.id!)));
      for (const [index, message] of ended.entries()) {
        const status = statuses[index]!;
        if (status.status === "rejected" || !status.value) continue;
        if (stopped) { undelivered.push(message.intent); continue; }
        const retry = { ...message, id: newId() };
        const delivered = await deliver(client, "send", retry);
        if (delivered.result.accepted === false) throw refusal(delivered.result);
        reconcileAccepted(retry, delivered.used, delivered.result);
      }
      return undelivered;
    },
  };
}

/** Stops the running turn and everything it started (zeta's default session-scope abort). */
export const stopTurn = (client: ZetaClient) => client.request("abort", {}, { timeoutMs: 15_000 });
