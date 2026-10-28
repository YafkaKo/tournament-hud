/**
 * Состояние текущей карты: последний полный снимок, замороженные итоги,
 * снимки вероятности для сравнения и статус догрузки из OpenDota.
 *
 * Всё, что нельзя потерять при перезапуске сервера (итоги, снимки), лежит в data/match.json.
 */

const fs = require('fs');
const path = require('path');
const {
  hasMatchData, matchIdOf, isEarlyState, isFinished,
  mergeSnapshot, buildResults, isFilled
} = require('./snapshot');
const { applyOpenDota } = require('./opendota');

const MAX_SNAPSHOTS = 200;

class MatchState {
  constructor({ file, log = console }) {
    this.file = file;
    this.log = log;
    this.clear();
    this.load();
  }

  clear() {
    this.matchId = null;
    this.live = null;              // склеенный снимок последних полных данных
    this.final = null;             // замороженные итоги карты
    this.snapshots = [];           // [{ clock, radiant, reason, at }]
    this.comparisonBase = null;    // снимок, с которым сравниваем после включения плашки
    this.enrichment = { state: 'idle' };
    this.lastAutoSnapClock = null;
  }

  /**
   * Принимает пакет GSI. Возвращает, что произошло:
   *   newMatch — началась другая карта, всё старое сброшено;
   *   froze    — карта только что закончилась, итоги заморожены.
   */
  ingest(body) {
    if (!hasMatchData(body)) return { ignored: true };

    const incomingId = matchIdOf(body);
    const state = body.map.game_state;

    // Новая карта: сменился matchid, либо после законченной карты пошла
    // ранняя стадия нового лобби, где matchid ещё не назначен.
    const newMatch =
      (incomingId && this.matchId && incomingId !== this.matchId) ||
      (!incomingId && this.final && isEarlyState(state));

    if (newMatch) {
      this.log.log(`[match] новая карта${incomingId ? ' ' + incomingId : ''} — сбрасываю итоги и снимки`);
      this.clear();
    }

    let idChanged = false;
    if (incomingId && incomingId !== this.matchId) {
      this.matchId = incomingId;
      idChanged = true;
    }

    this.live = mergeSnapshot(this.live, body);

    let froze = false;
    if (!this.final && isFinished(this.live.map)) {
      this.final = buildResults(this.live, { matchId: this.matchId, provisional: false });
      froze = true;
      this.log.log(`[match] карта окончена, победа: ${this.final.winner || 'неизвестно'} — итоги заморожены`);
    }

    if (newMatch || idChanged || froze) this.save();
    return { newMatch: !!newMatch, froze };
  }

  /** Что показывать на плашке итогов: замороженные итоги или текущая статистика. */
  resultsView() {
    if (this.final) return this.final;
    if (this.live && isFilled(this.live.player)) {
      return buildResults(this.live, { matchId: this.matchId, provisional: true });
    }
    return null;
  }

  /**
   * Комментатор включил плашку вероятности. Сохраняем снимок и выбираем,
   * с чем сравнивать: самый свежий из прошлых снимков, которому по игровым
   * часам не меньше minAgeSec. Игровые часы (map.clock_time) во время паузы
   * стоят, поэтому паузы в возраст снимка не входят.
   */
  onProbabilityEnabled(prob, minAgeSec) {
    if (!prob || !(prob.clock >= 0)) {
      this.comparisonBase = null;
      return;
    }
    this.comparisonBase = this.findBase(prob.clock, minAgeSec);
    this.pushSnapshot(prob, 'toggle');
  }

  /** Дополнительные автоматические снимки (если включены в конфиге). */
  maybeAutoSnapshot(prob, everySec) {
    if (!everySec || !prob || !(prob.clock >= 0) || this.final) return;
    if (this.lastAutoSnapClock !== null && prob.clock - this.lastAutoSnapClock < everySec) return;
    this.lastAutoSnapClock = prob.clock;
    this.pushSnapshot(prob, 'auto');
  }

  findBase(clock, minAgeSec) {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].clock <= clock - minAgeSec) return this.snapshots[i];
    }
    return null;
  }

  pushSnapshot(prob, reason) {
    this.snapshots.push({ clock: prob.clock, radiant: prob.radiant, reason, at: new Date().toISOString() });
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.splice(0, this.snapshots.length - MAX_SNAPSHOTS);
    this.save();
  }

  /** Блок сравнения для плашки: «было → стало» по Radiant. */
  comparison(prob) {
    const base = this.comparisonBase;
    if (!base || !prob) return null;
    const from = Math.round(base.radiant);
    const to = Math.round(prob.radiant);
    return {
      from: { clock: base.clock, radiant: from, dire: 100 - from },
      to: { clock: prob.clock, radiant: to, dire: 100 - to },
      delta: to - from
    };
  }

  setEnrichment(status, odData, constants) {
    this.enrichment = { ...status, updatedAt: new Date().toISOString() };
    if (odData && this.final) this.final = applyOpenDota(this.final, odData, constants);
    this.save();
  }

  reset() {
    this.log.log('[match] сброс матча по кнопке');
    this.clear();
    this.save();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.matchId = raw.matchId ?? null;
      this.final = raw.final ?? null;
      this.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
      this.comparisonBase = raw.comparisonBase ?? null;
      this.enrichment = raw.enrichment ?? { state: 'idle' };
      if (this.final) this.log.log(`[match] восстановлены итоги карты ${this.matchId || ''} из data/match.json`);
    } catch {
      // файла нет — первый запуск
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        matchId: this.matchId,
        final: this.final,
        snapshots: this.snapshots,
        comparisonBase: this.comparisonBase,
        enrichment: this.enrichment
      }, null, 2), 'utf8');
    } catch (err) {
      this.log.error('[match] не удалось сохранить data/match.json:', err.message);
    }
  }
}

module.exports = { MatchState };
