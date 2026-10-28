/* Хоткеи — одна таблица для всех пультов.

   Работают, пока пульт в фокусе и курсор не стоит в поле ввода.
   Глобальные хоткеи (когда в фокусе игра или OBS) — через агент: agent/config.json.
   Alt+E, Alt+F и Alt+D не используем — в Chrome они открывают меню и адресную строку. */

const HOTKEYS = {
  common: [
    { key: 'Digit1', label: 'Alt+1', action: 'scene-auto', title: 'Сцена: Игра' },
    { key: 'Digit2', label: 'Alt+2', action: 'scene-starting', title: 'Сцена: Скоро начнём' },
    { key: 'Digit3', label: 'Alt+3', action: 'scene-break', title: 'Сцена: Перерыв' },
    { key: 'Digit4', label: 'Alt+4', action: 'scene-bracket', title: 'Сцена: Сетка' },
    { key: 'Digit5', label: 'Alt+5', action: 'scene-results', title: 'Сцена: Итог-заставка' },
    { key: 'Digit6', label: 'Alt+6', action: 'scene-scoreboard', title: 'Сцена: Таблица счёта' },
    { key: 'Digit0', label: 'Alt+0', action: 'scene-blank', title: 'Чистый экран' },
    { key: 'KeyH', label: 'Alt+H', action: 'toggle-hud', title: 'Вся графика' },
    { key: 'KeyK', label: 'Alt+K', action: 'toggle-casters', title: 'Комментаторы' },
    { key: 'KeyT', label: 'Alt+T', action: 'toggle-trivia', title: 'Trivia' },
    { key: 'KeyN', label: 'Alt+N', action: 'trivia-next', title: 'Следующий факт' },
    { key: 'KeyC', label: 'Alt+C', action: 'toggle-countdown', title: 'Таймер «скоро начнётся»' },
    { key: 'ArrowUp', label: 'Alt+↑', action: 'countdown-plus', title: 'Таймер +1 мин' },
    { key: 'ArrowDown', label: 'Alt+↓', action: 'countdown-minus', title: 'Таймер −1 мин' },
    { key: 'KeyA', label: 'Alt+A', action: 'ads-play', title: 'Реклама: запустить очередь' },
    { key: 'KeyS', label: 'Alt+S', action: 'ads-stop', title: 'Реклама: остановить' }
  ],
  dota: [
    { key: 'KeyR', label: 'Alt+R', action: 'toggle-rosters', title: 'Составы команд' },
    { key: 'KeyI', label: 'Alt+I', action: 'toggle-mapResults', title: 'Итоги карты' },
    { key: 'KeyP', label: 'Alt+P', action: 'toggle-probability', title: 'Вероятность победы' },
    { key: 'KeyW', label: 'Alt+W', action: 'toggle-networth', title: 'Полоса золота' },
    { key: 'KeyO', label: 'Alt+O', action: 'toggle-objectives', title: 'Рошан' },
    { key: 'KeyJ', label: 'Alt+J', action: 'pick-replay', title: 'Повторить анимацию пика' }
  ],
  cs2: [
    { key: 'Digit7', label: 'Alt+7', action: 'scene-veto', title: 'Сцена: Пики карт' },
    { key: 'KeyR', label: 'Alt+R', action: 'toggle-stats', title: 'Таблица игроков' },
    { key: 'KeyM', label: 'Alt+M', action: 'toggle-rounds', title: 'История раундов' },
    { key: 'KeyB', label: 'Alt+B', action: 'toggle-economy', title: 'Экономика в закупку' },
    { key: 'KeyL', label: 'Alt+L', action: 'toggle-killfeed', title: 'Своя лента убийств' }
  ]
};

function hotkeysFor(game) {
  return [...HOTKEYS.common, ...(HOTKEYS[game] || [])];
}

/**
 * Вешает хоткеи на окно (и его документ). getGame() — игра в эфире,
 * onAction(hotkey, result) — показать оператору, что сработало.
 */
function bindHotkeys(win, { getGame, onAction }) {
  if (!win || win.__hudHotkeys) return;
  win.__hudHotkeys = true;
  win.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    const tag = win.document.activeElement && win.document.activeElement.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const hk = hotkeysFor(getGame()).find((h) => h.key === e.code);
    if (!hk) return;
    e.preventDefault();
    e.stopPropagation();
    fetch(`/api/action/${encodeURIComponent(hk.action)}`, { method: 'POST' })
      .then((r) => r.json().catch(() => ({})).then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => onAction && onAction(hk, ok ? body : { error: body.error || 'не выполнено' }))
      .catch(() => onAction && onAction(hk, { error: 'нет связи с сервером' }));
  }, true);
  // Alt в Windows выделяет меню браузера — гасим одиночное отпускание Alt.
  win.addEventListener('keyup', (e) => { if (e.key === 'Alt') e.preventDefault(); });
}
