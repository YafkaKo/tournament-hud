/* Привязка страницы к игре.

   Страницы Dota и CS2 написаны каждая для своего HUD и про другую игру не знают.
   Этот скрипт подключается первым и тихо дописывает игру ко всем запросам:
     — fetch('/api/…')  → заголовок X-Hud-Game: dota | cs2
     — new WebSocket('/ws') → /ws?game=dota | cs2
   Поэтому код самих страниц почти не менялся.

   <script src="/js/game-scope.js" data-game="cs2"></script> */

(function () {
  const game = (document.currentScript && document.currentScript.dataset.game) || 'dota';
  window.HUD_GAME = game;
  // Страница открыта внутри общего пульта или оверлея (в iframe).
  window.HUD_EMBEDDED = window.top !== window;
  if (window.HUD_EMBEDDED) document.documentElement.classList.add('is-embedded');

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
        init = { ...(init || {}) };
        const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
        if (!headers.has('X-Hud-Game')) headers.set('X-Hud-Game', game);
        init.headers = headers;
      }
    } catch { /* необычный адрес — отправляем как есть */ }
    return nativeFetch(input, init);
  };

  const NativeWS = window.WebSocket;
  function ScopedWebSocket(url, protocols) {
    try {
      const u = new URL(url, location.href);
      if (u.pathname === '/ws' && !u.searchParams.has('game')) u.searchParams.set('game', game);
      url = u.toString();
    } catch { /* оставляем как есть */ }
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  }
  ScopedWebSocket.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) ScopedWebSocket[k] = NativeWS[k];
  window.WebSocket = ScopedWebSocket;
})();
