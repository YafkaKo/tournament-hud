/**
 * WebSocket-рассылка.
 *
 * Каждая страница при подключении говорит, кто она:
 *   /ws?game=dota  — страницы Dota (оверлей, пульт): получают состояние в форме Dota
 *   /ws?game=cs2   — страницы CS2: состояние в форме CS2
 *   /ws            — общие страницы (оболочка оверлея и пульта): только сообщения 'hud'
 *
 * Сообщение 'hud' получают все: какая игра в эфире, реклама, пики и т.п.
 */

const { WebSocketServer } = require('ws');

class Hub {
  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.onConnect = () => {};
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      const game = url.searchParams.get('game');
      ws.game = game === 'dota' || game === 'cs2' ? game : null;
      ws.role = url.searchParams.get('role') || (ws.game ? 'page' : 'shell');
      ws.main = url.searchParams.get('main') === '1';
      ws.on('error', () => {});
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        this.onMessage(ws, msg);
      });
      this.onConnect(ws);
    });
    this.onMessage = () => {};
  }

  get size() { return this.wss.clients.size; }

  clients(filter) {
    const out = [];
    for (const ws of this.wss.clients) if (ws.readyState === 1 && (!filter || filter(ws))) out.push(ws);
    return out;
  }

  send(ws, type, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
  }

  /** filter: функция от ws, либо строка 'dota' / 'cs2' — только страницам этой игры. */
  broadcast(type, data, filter) {
    const fn = typeof filter === 'string' ? (ws) => ws.game === filter : filter;
    const msg = JSON.stringify({ type, data });
    for (const ws of this.clients(fn)) ws.send(msg);
  }
}

module.exports = { Hub };
