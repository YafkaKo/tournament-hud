/* Оверлей эфира: показывает HUD выбранной игры, проигрывает рекламу и анимацию пика.

   Основной оверлей — тот, что открыт в OBS (overlay.html?obs=1, не внутри другой
   страницы) или с ?main=1. Только у него есть звук, и только он сообщает серверу,
   как идёт реклама. Превью в пульте и в браузере показывают то же самое без звука. */

const params = new URLSearchParams(location.search);
const OBS = params.get('obs') === '1';
const EMBEDDED = window.top !== window;
const MAIN = params.get('main') === '1' || (OBS && !EMBEDDED && params.get('main') !== '0');
if (OBS) document.body.classList.add('obs');

const $ = (id) => document.getElementById(id);

/* ----------------------------------------------------------- рамки игр */

const frames = { dota: $('frameDota'), cs2: $('frameCs2') };
const gap = params.has('gap') ? `&gap=${encodeURIComponent(params.get('gap'))}` : '';
frames.dota.src = `overlay-dota.html?obs=1${gap}`;
frames.cs2.src = 'cs2/overlay.html?obs=1';

let hud = null;

function showGame(game) {
  for (const [g, el] of Object.entries(frames)) el.classList.toggle('is-on', g === game);
}

/* ----------------------------------------------------------- связь */

let ws = null;
let retry = 0;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=overlay${MAIN ? '&main=1' : ''}`);
  ws.onopen = () => {
    retry = 0;
    document.body.classList.add('is-connected');
    document.body.classList.remove('is-loading');
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'hud') { hud = msg.data; showGame(hud.game); }
    if (msg.type === 'ads') Ads.command(msg.data);
    if (msg.type === 'pick') Pick.enqueue(msg.data);
  };
  ws.onclose = () => {
    document.body.classList.remove('is-connected');
    retry = Math.min(retry + 1, 10);
    setTimeout(connect, 400 * retry);
  };
  ws.onerror = () => ws.close();
}
connect();

function report(type, data) {
  if (!MAIN || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, ...data }));
}

/* ====================================================================== РЕКЛАМА

   Порядок: переход → (в точке перекрытия) ролик → ролик до конца →
   переход → (в точке перекрытия) ролик убирается → эфир.
   Между роликами очереди — переход или прямая склейка (как выбрано в пульте).
   Ролик не играет — пропускаем его, сообщаем об ошибке, эфир не висит на чёрном. */

const Ads = (() => {
  const clips = [$('adClipA'), $('adClipB')];
  const trans = $('adTransition');
  let run = null;          // текущий показ: { session, items, between, index, phase, stop, skip }
  let progressTimer = null;

  function setVolume(el, v) {
    el.muted = !MAIN;
    el.volume = Math.max(0, Math.min(1, (Number(v ?? 100)) / 100));
  }

  async function playSafe(el) {
    try {
      await el.play();
    } catch (err) {
      // Обычный браузер запрещает автозапуск со звуком — пробуем без звука.
      if (!el.muted) { el.muted = true; await el.play(); } else throw err;
    }
  }

  function load(el, url) {
    if (el.dataset.src !== url) {
      el.dataset.src = url;
      el.src = url;
      el.load();
    }
  }

  function reset() {
    clearInterval(progressTimer);
    for (const el of [...clips, trans]) {
      el.pause();
      el.classList.remove('is-on');
      el.removeAttribute('src');
      el.dataset.src = '';
      el.load();
    }
    $('ads').setAttribute('aria-hidden', 'true');
  }

  /** Проигрывает переход; в точке перекрытия вызывает onCut. Без перехода — сразу onCut. */
  function transition(t, onCut) {
    return new Promise((resolve) => {
      if (!t || !t.url) { onCut(); resolve(); return; }
      let cut = false;
      const doCut = () => { if (!cut) { cut = true; onCut(); } };
      const done = () => {
        doCut();
        trans.classList.remove('is-on');
        trans.pause();
        trans.ontimeupdate = trans.onended = trans.onerror = null;
        clearTimeout(safety);
        resolve();
      };
      load(trans, t.url);
      setVolume(trans, t.volume);
      trans.currentTime = 0;
      trans.classList.add('is-on');
      trans.ontimeupdate = () => { if (trans.currentTime * 1000 >= (t.cutMs || 0)) doCut(); };
      trans.onended = done;
      trans.onerror = () => { report('ads-error', { session: run && run.session, index: run ? run.index : 0, message: 'переход не воспроизвёлся' }); done(); };
      // Страховка, если видео перехода зависло
      const safety = setTimeout(done, 15000);
      if ((t.cutMs || 0) === 0) doCut();
      playSafe(trans).catch(() => done());
    });
  }

  /** Показывает ролик и ждёт его конца (или «стоп» / «пропустить»). */
  function playClip(el, item, index) {
    return new Promise((resolve) => {
      let lastTime = -1;
      let stalledFor = 0;
      const finish = (why) => {
        clearInterval(watch);
        el.onended = el.onerror = null;
        resolve(why);
      };
      setVolume(el, item.volume);
      el.currentTime = 0;
      el.onended = () => finish('ended');
      el.onerror = () => {
        report('ads-error', { session: run.session, index, message: 'файл не открылся (кодек?)' });
        finish('error');
      };
      // Если видео стоит на месте дольше 8 секунд — считаем, что оно не играет.
      const watch = setInterval(() => {
        if (run.stop || run.skip) { finish(run.stop ? 'stop' : 'skip'); return; }
        if (el.currentTime === lastTime && !el.paused) stalledFor += 250; else stalledFor = 0;
        lastTime = el.currentTime;
        if (stalledFor >= 8000) {
          report('ads-error', { session: run.session, index, message: 'видео зависло' });
          finish('error');
        }
      }, 250);
      playSafe(el).catch(() => {
        report('ads-error', { session: run.session, index, message: 'браузер не смог запустить видео' });
        finish('error');
      });
    });
  }

  async function start(cmd) {
    if (run) { run.stop = true; await waitIdle(); }
    reset();
    run = { session: cmd.session, items: cmd.items || [], between: cmd.between || 'transition', index: 0, phase: 'in', stop: false, skip: false };
    const me = run;
    $('ads').setAttribute('aria-hidden', 'false');

    progressTimer = setInterval(() => {
      if (run !== me) return;
      const el = clips[me.index % 2];
      report('ads-progress', {
        session: me.session, index: me.index, phase: me.phase,
        position: Math.round((el.currentTime || 0) * 10) / 10,
        duration: Math.round((el.duration || 0) * 10) / 10
      });
    }, 500);

    let shown = null;      // какой видеоэлемент ролика сейчас на экране
    let lastTransition = null;

    for (let i = 0; i < me.items.length && !me.stop; i++) {
      const item = me.items[i];
      const el = clips[i % 2];
      me.index = i;
      me.skip = false;
      load(el, item.url);
      // следующий ролик грузим заранее во второй элемент — без чёрного кадра
      if (me.items[i + 1]) load(clips[(i + 1) % 2], me.items[i + 1].url);

      const show = () => {
        if (shown && shown !== el) { shown.classList.remove('is-on'); shown.pause(); }
        el.classList.add('is-on');
        shown = el;
      };
      me.phase = i === 0 ? 'in' : 'between';
      if (i === 0 || me.between === 'transition') {
        // Ролик стартует в точке перекрытия перехода, а не после него
        let started = null;
        await transition(item.transition, () => { show(); me.phase = 'clip'; started = playClip(el, item, i); });
        me.phase = 'clip';
        lastTransition = item.transition;
        const why = await started;
        if (why === 'stop') break;
      } else {
        show();
        me.phase = 'clip';
        lastTransition = item.transition || lastTransition;
        const why = await playClip(el, item, i);
        if (why === 'stop') break;
      }
    }

    // Выход: переход, в точке перекрытия ролик убирается — под ним уже эфир.
    me.phase = 'out';
    await transition(lastTransition || (me.items[0] && me.items[0].transition), () => {
      if (shown) { shown.classList.remove('is-on'); shown.pause(); }
    });
    if (run === me) {
      report('ads-done', { session: me.session });
      run = null;
      reset();
    }
  }

  function waitIdle() {
    return new Promise((resolve) => {
      const t = setInterval(() => { if (!run) { clearInterval(t); resolve(); } }, 50);
      setTimeout(() => { clearInterval(t); run = null; resolve(); }, 3000);
    });
  }

  return {
    command(cmd) {
      if (!cmd) return;
      if (cmd.cmd === 'play') start(cmd);
      else if (cmd.cmd === 'stop' && run && run.session === cmd.session) run.stop = true;
      else if (cmd.cmd === 'skip' && run && run.session === cmd.session) run.skip = true;
      else if (cmd.cmd === 'idle' && run && run.session !== cmd.session) { run = null; reset(); }
    }
  };
})();

/* ====================================================================== ПИК ГЕРОЯ

   Карточка героя со стороны пикнувшей команды: анимированный портрет
   (видео с CDN Steam; не загрузилось — обычный портрет с движением),
   название команды, номер пика, имя героя и фраза героя (если файл есть). */

const Pick = (() => {
  const RENDER = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/videos/dota_react/heroes/renders';
  const DURATION = 3600;
  const queue = [];
  let busy = false;
  const card = $('pickCard');
  const video = $('pickVideo');
  const voice = $('pickVoice');

  function enqueue(p) {
    if (!p || p.game !== 'dota') return;
    if (queue.length > 4) queue.shift();      // пики пачкой — не копим хвост
    queue.push(p);
    if (!busy) next();
  }

  function next() {
    const p = queue.shift();
    if (!p) { busy = false; return; }
    busy = true;
    play(p);
    setTimeout(next, DURATION + 150);
  }

  function play(p) {
    const key = heroKey(p.hero);
    const side = p.side === 'dire' ? 'dire' : 'radiant';
    card.classList.remove('is-playing', 'is-radiant', 'is-dire');
    void card.offsetWidth;   // перезапуск CSS-анимации
    card.classList.add(side === 'dire' ? 'is-dire' : 'is-radiant');

    $('pickTeam').textContent = p.team || (side === 'dire' ? 'Dire' : 'Radiant');
    $('pickNum').textContent = Number.isFinite(p.slot) ? `пик ${p.slot + 1}` : 'пик';
    const name = heroLabel(key);
    $('pickHero').textContent = name;
    $('pickHero').classList.toggle('is-long', name.length > 11);

    $('pickImg').style.backgroundImage = `url('${heroImage(key)}'), linear-gradient(135deg, rgba(108,77,255,.45), rgba(255,61,138,.25))`;
    video.classList.remove('is-ready');
    video.oncanplay = () => { video.classList.add('is-ready'); video.play().catch(() => {}); };
    video.onerror = () => video.classList.remove('is-ready');
    video.src = `${RENDER}/${key}.webm`;

    card.classList.add('is-playing');

    if (MAIN && p.voice) {
      voice.src = p.voice;
      voice.volume = Math.max(0, Math.min(1, (p.volume ?? 80) / 100));
      setTimeout(() => voice.play().catch(() => {}), 250);
    }
  }

  return { enqueue };
})();
