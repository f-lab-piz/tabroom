import {createNativeSampler} from './native-cpu.js';
const percent = value => value.toFixed(1) + '%';
const seconds = value => (value / 1000).toFixed(1) + '초';

export function attachMonitor() {
  const live = document.querySelector('#cpu-live');
  const progress = document.querySelector('#cpu-progress');
  const start = document.querySelector('#cpu-start');
  const duration = document.querySelector('#cpu-duration');
  const results = document.querySelector('#cpu-results');
  const chart = document.querySelector('#cpu-chart');
  const systemCpu = document.querySelector('#system-cpu');
  const previewFps = document.querySelector('#preview-fps');
  const autoLabel = document.querySelector('#auto-preview-stage');
  const stages = ['모든 탭 무제한', '모든 탭 합계 30fps', '작업 중인 탭만 30fps'];
  const nativeSample = createNativeSampler();
  const history = [];
  let previous, active, capture, lastRequested, deadlineTimer, polling = false;
  let queue = Promise.resolve();
  let records = [];

  function serialize(action) {
    queue = queue.then(action).catch(() => {
      active = null;
      previous = null;
      clearTimeout(deadlineTimer);
      live.textContent = '—';
      progress.textContent = '일반 Chrome CPU 연결.command를 한 번 실행한 뒤 확장을 새로고침하세요.';
      buttons();
    });
    return queue;
  }

  function buttons() {
    start.textContent = active ? '측정 중지' : '측정 시작';
    start.disabled = capture === undefined || !previous;
    duration.disabled = Boolean(active);
  }

  function renderResults() {
    results.replaceChildren();
    if (!records.length) return;
    const last = records[0];
    const summary = document.createElement('strong');
    summary.textContent = '최근 측정　' + seconds(last.ms) + ' · 평균 ' + percent(last.pct);
    results.append(summary);
    // Show the latest available interval for each state, including separate runs.
    const values = {};
    for (const mode of ['ON', 'OFF']) {
      const record = records.find(r => r[mode]?.ms > 0);
      if (!record) continue;
      const {ms, cpu} = record[mode];
      values[mode] = cpu * 100000 / ms;
      const row = document.createElement('div');
      row.textContent = mode + '　' + seconds(ms) + '　' + percent(values[mode]);
      row.title = new Date(record.at).toLocaleTimeString('ko-KR') + ' 종료';
      results.append(row);
    }
    if (Object.keys(values).length === 2) {
      const row = document.createElement('div');
      const diff = values.ON - values.OFF;
      row.textContent = '최근 ON − OFF　' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%p';
      results.append(row);
    }
  }

  function draw(now) {
    while (history.length && history[0].time < now - 60000) history.shift();
    const ctx = chart.getContext('2d');
    const {width, height} = chart;
    ctx.clearRect(0, 0, width, height);
    const max = Math.max(100, ...history.map(point => point.pct));
    ctx.beginPath();
    for (const [index, point] of history.entries()) {
      const x = width * (1 - (now - point.time) / 60000);
      const y = height - 3 - (height - 6) * point.pct / max;
      if (index) ctx.lineTo(x,y); else ctx.moveTo(x,y);
    }
    ctx.strokeStyle = '#55817b';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  async function finish() {
    if (!active) return;
    const ms = active.ON.ms + active.OFF.ms;
    if (ms > 0) {
      const pct = (active.ON.cpu + active.OFF.cpu) * 100000 / ms;
      records.unshift({ms, pct, ON:active.ON, OFF:active.OFF, at:Date.now()});
      records = records.slice(0, 12);
      sessionStorage.setItem('tabroom-cpu-records', JSON.stringify(records));
      renderResults();
    }
    clearTimeout(deadlineTimer);
    active = null;
    progress.textContent = '측정 완료';
    buttons();
  }

  async function read() {
    const next = await nativeSample();
    const before = previous;
    previous = next;
    if (!before || before.generation !== next.generation) {
      if (active) {
        active = null;
        clearTimeout(deadlineTimer);
        progress.textContent = '브라우저가 재연결되어 측정을 종료했어요.';
      } else progress.textContent = '측정 대기';
      history.length = 0;
      buttons();
      return next;
    }
    const ms = next.time - before.time;
    if (ms <= 0) return next;
    const cpu = Math.max(0, next.cpuSeconds - before.cpuSeconds);
    const pct = cpu * 100000 / ms;
    live.textContent = percent(pct);
    history.push({time:next.time, pct});
    draw(next.time);
    if (active) {
      const usedMs = Math.max(0, Math.min(ms, active.end - before.time));
      const part = active[capture ? 'ON' : 'OFF'];
      part.ms += usedMs;
      part.cpu += cpu * usedMs / ms;
      progress.textContent = '측정 중 · ' + seconds(active.ON.ms + active.OFF.ms);
      if (next.time >= active.end) await finish();
    }
    buttons();
    return next;
  }

  try { records = JSON.parse(sessionStorage.getItem('tabroom-cpu-records') || '[]'); } catch { records = []; }
  renderResults();
  buttons();
  start.addEventListener('click', () => {
    const stopping = Boolean(active);
    start.disabled = true;
    serialize(async () => {
      const next = await read();
      if (stopping) { await finish(); return; }
      if (active || capture === undefined) { buttons(); return; }
      const limit = Number(duration.value) * 1000;
      active = {end:limit ? next.time + limit : Infinity, ON:{ms:0,cpu:0}, OFF:{ms:0,cpu:0}};
      if (limit) deadlineTimer = setTimeout(() => serialize(read),limit + 2);
      progress.textContent = '측정 중 · 0.0초';
      buttons();
    });
  });
  function poll() {
    if (polling) return;
    polling = true;
    serialize(read).finally(() => { polling = false; });
  }
  poll();
  setInterval(poll, 1000);
  return {
    previewStats(stats) {
      systemCpu.textContent = Number.isFinite(stats.systemCpu) ? percent(stats.systemCpu) : '—';
      previewFps.textContent = (stats.fps ?? 0).toFixed(1) + ' FPS';
      autoLabel.hidden = !Number.isInteger(stats.autoStage);
      autoLabel.textContent = autoLabel.hidden ? '' : '자동 · ' + stages[stats.autoStage];
    },
    captureChanged(enabled) {
      if (lastRequested === enabled) return;
      lastRequested = enabled;
      serialize(async () => {
        try { if (active) await read(); }
        finally { capture = enabled; buttons(); }
      });
    }
  };
}
