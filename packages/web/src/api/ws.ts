// Live updates over the daemon WebSocket. On any event for the watched ticket we invalidate its
// query so TanStack Query refetches — simple and robust (the DB is authoritative; we don't apply
// events incrementally). Reconnects with backoff; the ticket's own polling is the safety net.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

export function useTicketStream(ticketId?: string): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!ticketId) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${proto}://${location.host}/ws?ticket=${encodeURIComponent(ticketId)}`,
      );
      socket.onmessage = () => {
        void qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
        void qc.invalidateQueries({ queryKey: ['tickets'] });
      };
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1500);
      };
      socket.onerror = () => socket?.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [ticketId, qc]);
}
