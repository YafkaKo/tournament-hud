/**
 * Быстрые действия: ими пользуются хоткеи пультов, агент хоткеев и Stream Deck
 * (обычный HTTP-запрос:  http://localhost:3000/api/action/scene-starting).
 *
 * games — в какой игре действие имеет смысл. Вызвать можно в любой момент,
 * но в списке /api/actions?game=… показываются только подходящие.
 */

const { SCENES } = require('./state');

const SCENE_TITLES = {
  auto: 'Игра', starting: 'Скоро начнём', break: 'Перерыв', bracket: 'Сетка',
  results: 'Итог-заставка', scoreboard: 'Таблица счёта', veto: 'Пики карт', blank: 'Чистый экран'
};

function buildActions({ state, change, games, ads, pickFx }) {
  const sh = () => state.s.shared;
  const list = [];
  const add = (name, title, gamesFor, run) => list.push({ name, title, games: gamesFor, run });
  const BOTH = ['dota', 'cs2'];

  // ---------------------------------------------------------------- сцены
  for (const scene of SCENES) {
    add(`scene-${scene}`, `Сцена: ${SCENE_TITLES[scene]}`, scene === 'veto' ? ['cs2'] : BOTH, () => change(() => {
      sh().scene = scene === 'veto' && state.game === 'dota' ? 'auto' : scene;
    }));
  }

  // ---------------------------------------------------------------- общие плашки
  const toggle = (name, title, gamesFor, get, set) => add(name, title, gamesFor, () => {
    let on;
    change(() => { on = !get(); set(on); });
    return { on };
  });

  toggle('toggle-hud', 'Вся графика', BOTH, () => sh().showHud, (v) => { sh().showHud = v; });
  toggle('toggle-casters', 'Комментаторы', BOTH, () => sh().casters.show, (v) => { sh().casters.show = v; });
  toggle('toggle-trivia', 'Trivia', BOTH, () => sh().trivia.show, (v) => { sh().trivia.show = v; });

  add('trivia-next', 'Следующий факт', BOTH, () => {
    const lib = sh().triviaLibrary || [];
    if (!lib.length) return { error: 'Заготовок нет' };
    let index;
    change(() => {
      index = ((sh().triviaIndex ?? -1) + 1) % lib.length;
      sh().triviaIndex = index;
      sh().trivia = { ...sh().trivia, title: lib[index].title || '', text: lib[index].text || '', show: true };
    });
    return { index, total: lib.length };
  });

  add('toggle-countdown', 'Таймер «скоро начнётся»', BOTH, () => {
    let on;
    change(() => {
      const cd = sh().countdown;
      on = !cd.show;
      cd.show = on;
      // Таймер без времени — ставим 10 минут, чтобы не появилась пустая плашка.
      if (on && (!cd.to || new Date(cd.to).getTime() < Date.now())) cd.to = new Date(Date.now() + 10 * 60000 + 900).toISOString();
    });
    return { on };
  });
  for (const [name, by] of [['countdown-plus', 1], ['countdown-minus', -1]]) {
    add(name, `Таймер ${by > 0 ? '+' : '−'}1 мин`, BOTH, () => change(() => {
      const cd = sh().countdown;
      const base = cd.to ? new Date(cd.to).getTime() : Date.now();
      cd.to = new Date(Math.max(Date.now(), base) + by * 60000).toISOString();
    }));
  }

  // ---------------------------------------------------------------- серия
  for (const [name, key, by] of [['series-a+', 'aWins', 1], ['series-a-', 'aWins', -1], ['series-b+', 'bWins', 1], ['series-b-', 'bWins', -1]]) {
    add(name, `Счёт серии: ${key === 'aWins' ? 'A' : 'B'} ${by > 0 ? '+1' : '−1'}`, BOTH, () => change(() => {
      sh().series[key] = Math.max(0, (sh().series[key] || 0) + by);
    }));
  }

  // ---------------------------------------------------------------- игра в эфире
  add('game-dota', 'Игра: Dota 2', BOTH, () => change(() => state.setGame('dota')));
  add('game-cs2', 'Игра: CS2', BOTH, () => change(() => state.setGame('cs2')));

  // ---------------------------------------------------------------- Dota
  const d = () => state.s.dota;
  toggle('toggle-probability', 'Вероятность победы', ['dota'], () => d().probability.show, (v) => { d().probability.show = v; });
  toggle('toggle-mapResults', 'Итоги карты', ['dota'], () => d().mapResults.show, (v) => { d().mapResults.show = v; });
  toggle('toggle-networth', 'Полоса золота', ['dota'], () => d().panels.networth, (v) => { d().panels.networth = v; });
  toggle('toggle-objectives', 'Рошан', ['dota'], () => d().panels.objectives, (v) => { d().panels.objectives = v; });
  toggle('toggle-rosters', 'Составы команд', ['dota'], () => d().panels.rosters, (v) => { d().panels.rosters = v; });
  add('dota-swap-sides', 'Команды поменялись сторонами (Radiant/Dire)', ['dota'], () => change(() => {
    d().radiantIs = d().radiantIs === 'B' ? 'A' : 'B';
  }));
  add('match-reset', 'Сбросить матч Dota', ['dota'], () => { games.dota.resetMatch(); });

  // ---------------------------------------------------------------- CS2
  const c = () => state.s.cs2;
  for (const [key, title] of [['stats', 'Таблица игроков'], ['rounds', 'История раундов'], ['economy', 'Экономика'],
    ['killfeed', 'Своя лента убийств'], ['players', 'Карточки игроков'], ['observed', 'Игрок в камере'], ['roundResult', 'Итог раунда']]) {
    toggle(`toggle-${key}`, title, ['cs2'], () => c().panels[key], (v) => { c().panels[key] = v; });
  }
  add('sides-swap', 'Поменять стороны CT/T', ['cs2'], () => { games.cs2.swapSides(); });

  // ---------------------------------------------------------------- реклама и пики
  if (ads) {
    add('ads-play', 'Реклама: запустить очередь', BOTH, () => ads.play());
    add('ads-stop', 'Реклама: остановить', BOTH, () => ads.stop());
    add('ads-skip', 'Реклама: следующий ролик', BOTH, () => ads.skip());
  }
  if (pickFx) {
    add('pick-replay', 'Повторить анимацию последнего пика', ['dota'], () => pickFx.replay());
    toggle('toggle-pickfx', 'Анимация пика', ['dota'], () => state.s.pickFx.enabled, (v) => { state.s.pickFx.enabled = v; });
  }

  const byName = new Map(list.map(a => [a.name, a]));
  // Старые имена из CS2-HUD и пульта Dota.
  const ALIASES = { 'toggle-results': 'toggle-mapResults', 'toggle-maps': 'toggle-mapResults' };

  return {
    run(name) {
      const a = byName.get(ALIASES[name] || name);
      if (!a) return null;
      const out = a.run();
      return out && typeof out === 'object' ? out : {};
    },
    list(game) {
      return list.filter(a => !game || a.games.includes(game)).map(({ name, title, games: g }) => ({ name, title, games: g }));
    },
    has: (name) => byName.has(ALIASES[name] || name)
  };
}

module.exports = { buildActions };
