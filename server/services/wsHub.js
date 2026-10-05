/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

export function registerClient(socket) {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
}

export function disconnectAllClients(code = 4401, reason = 'Unauthorized') {
  for (const client of clients) {
    client.close(code, reason);
  }
  clients.clear();
}

export function broadcast(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(text);
    }
  }
}
