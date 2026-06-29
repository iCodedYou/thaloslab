// WebSocket hub (SPEC §17). Clients subscribe to a ticket; the hub fans out EngineBus events for
// that ticket to its sockets. Fan-out is NON-BLOCKING and lossy by design — the authoritative
// record is the DB (runs/task_events); a reconnecting client fetches the seq gap over REST. The
// engine never imports Fastify — the hub just subscribes to the bus.
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../workflow/runtime';

interface Subscription {
  ticketId: string;
  send: (data: string) => void;
}

export async function registerWebSocket(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const { default: websocket } = await import('@fastify/websocket');
  await app.register(websocket);

  const subs = new Set<Subscription>();

  // One bus subscription fans out to all interested sockets.
  runtime.bus.subscribe((event) => {
    const data = JSON.stringify({ event: event.type, payload: event });
    for (const sub of subs) {
      if (sub.ticketId === event.ticketId) {
        try {
          sub.send(data);
        } catch {
          // dead socket — dropped on its next 'close'
        }
      }
    }
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const ticketId = new URL(req.url, 'http://localhost').searchParams.get('ticket') ?? '';
    const sub: Subscription = { ticketId, send: (d) => socket.send(d) };
    subs.add(sub);

    socket.on('message', (raw: Buffer) => {
      void handleInbound(runtime, raw.toString());
    });
    socket.on('close', () => subs.delete(sub));
  });
}

async function handleInbound(runtime: Runtime, raw: string): Promise<void> {
  let msg: { event?: string; payload?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return;
  }
  const p = msg.payload ?? {};
  switch (msg.event) {
    case 'gate.resolve':
      await runtime.engine.resolveHumanGate(
        String(p.gateId),
        p.decision as 'approve' | 'reject' | 'request-changes',
        'user',
        p.comment ? String(p.comment) : undefined,
      );
      break;
    case 'ticket.abort':
      runtime.engine.abort(String(p.ticketId));
      break;
    default:
      break;
  }
}
