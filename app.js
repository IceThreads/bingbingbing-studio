/*
 * 冰冰冰音乐工作室 —— 弹奏器 + 制作器
 */
(function () {
  'use strict';

  var A = window.BingAudio;
  var engine = new A.BingEngine();

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // 钢琴卷帘：一行一个音高，范围 C4(60) ~ C6(84)，共 25 行
  var ROW_LOW = 60;
  var ROW_HIGH = 84;
  var DEFAULT_MIDIS = (function () {
    var arr = [];
    for (var m = ROW_LOW; m <= ROW_HIGH; m++) arr.push(m);
    return arr;
  })();
  var KEY_MAP = {
    'q': 74, 'w': 76, 'e': 77, 'r': 79, 't': 81, 'y': 83, 'u': 84, 'i': 86,
    'z': 60, 'x': 62, 'c': 64, 'v': 65, 'b': 67, 'n': 69, 'm': 71, ',': 72
  };
  var state = {
    soundSource: 'synth',
    sampleBuffer: null,
    sampleName: '',
    sampleRoot: 60,
    sampleBounds: null,
    sampleSegments: null,
    sampleMode: 'single',
    tone: { brightness: 1, decay: 1, gain: 1, pitch: 0 },
    reverb: { size: 1.6, mix: 0.18 },
    pattern: createPattern(16),
    playing: false,
    timer: null,
    nextTime: 0,
    schedulerStep: 0,
    metronome: false,          // 默认关掉，不然听编曲结果时全是节拍器“嘀嘀”
    loop: true,
    recording: false,
    recStart: 0,
    recEvents: [],
    heldKeys: {},
    musicBuffer: null,
    musicName: '',
    auditionNode: null,
    midiParsed: null
  };

  /* ---------------- 模型 ---------------- */

  function createPattern(steps) {
    var n = steps || 16;
    return {
      bpm: 120,
      swing: 0,
      steps: n,
      rowBase: ROW_LOW,
      // durs / vels 是稀疏表：只有非默认值才存（键 "行:格"）。
      // 这样每个音符都带时值和力度（相当于 MIDI 的 note on/off + velocity），
      // 而不是只有“有/没有”两态。
      durs: {},
      vels: {},
      tracks: DEFAULT_MIDIS.map(function (m) {
        return {
          name: A.midiToName(m),
          midi: m,
          gain: 0.85,
          muted: false,
          solo: false,
          cells: new Array(n).fill(false)
        };
      })
    };
  }

  function noteKey(ti, s) { return ti + ':' + s; }

  /** 音符时值（以格为单位，≥1） */
  function noteDur(p, ti, s) {
    var d = p.durs && p.durs[noteKey(ti, s)];
    return typeof d === 'number' && d > 0 ? d : 1;
  }

  /** 音符力度 0~1 */
  function noteVel(p, ti, s) {
    var v = p.vels && p.vels[noteKey(ti, s)];
    return typeof v === 'number' ? Math.max(0.05, Math.min(1.5, v)) : 0.85;
  }

  /** 写/删一个音符 */
  function setNote(ti, s, on, len, vel) {
    var p = state.pattern;
    var tr = p.tracks[ti];
    if (!tr || s < 0 || s >= p.steps) return;
    var key = noteKey(ti, s);
    if (on) {
      tr.cells[s] = true;
      if (len && len > 1) p.durs[key] = Math.min(64, Math.round(len));
      else delete p.durs[key];
      if (typeof vel === 'number' && Math.abs(vel - 0.85) > 0.001) p.vels[key] = Math.round(vel * 100) / 100;
      else delete p.vels[key];
    } else {
      tr.cells[s] = false;
      delete p.durs[key];
      delete p.vels[key];
    }
  }

  /** 调整已有音符的时值（±1 格） */
  function bumpNoteDur(ti, s, delta) {
    var p = state.pattern;
    if (!p.tracks[ti] || !p.tracks[ti].cells[s]) return;
    var cur = noteDur(p, ti, s) + delta;
    cur = Math.max(1, Math.min(64, cur));
    var key = noteKey(ti, s);
    if (cur <= 1) delete p.durs[key];
    else p.durs[key] = cur;
  }

  /** 清掉指向不存在音符的 durs/vels 残留 */
  function pruneNoteMaps() {
    var p = state.pattern;
    ['durs', 'vels'].forEach(function (name) {
      var map = p[name];
      if (!map) return;
      Object.keys(map).forEach(function (k) {
        var parts = k.split(':');
        var tr = p.tracks[parseInt(parts[0], 10)];
        if (!tr || !tr.cells[parseInt(parts[1], 10)]) delete map[k];
      });
    });
  }

  /** 把任意音高折到卷帘范围内，返回行下标 */
  function rowIndex(midi) {
    var m = Math.round(midi);
    while (m < ROW_LOW) m += 12;
    while (m > ROW_HIGH) m -= 12;
    return Math.max(0, Math.min(DEFAULT_MIDIS.length - 1, m - ROW_LOW));
  }

  /** 清空全部行 */
  function clearRows(steps) {
    state.pattern.durs = {};
    state.pattern.vels = {};
    state.pattern.tracks.forEach(function (tr) {
      tr.cells = new Array(steps).fill(false);
      tr.muted = false;
      tr.solo = false;
      tr.gain = 0.85;
    });
  }

  function resizeCells(n) {
    state.pattern.steps = n;
    state.pattern.tracks.forEach(function (tr) {
      var cells = new Array(n).fill(false);
      for (var i = 0; i < Math.min(n, tr.cells.length); i++) cells[i] = tr.cells[i];
      tr.cells = cells;
    });
    pruneNoteMaps();
  }

  /* ---------------- 音频 ---------------- */

  function ensureAudio() {
    var ctx = engine.init();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function trigger(midi, velocity, fromUser) {
    var ctx = ensureAudio();
    engine.playNote(midi, ctx.currentTime + 0.001, velocity);
    if (fromUser && state.recording) {
      state.recEvents.push({ midi: midi, t: performance.now() });
    }
  }

  function applyTone() {
    engine.setTone(state.tone);
    engine.setReverb(state.reverb.size, state.reverb.mix);
  }

  function applySource() {
    if (state.soundSource === 'sample' && state.sampleBuffer) {
      engine.setSample(state.sampleBuffer, state.sampleName, state.sampleRoot,
        state.sampleBounds, state.sampleSegments, state.sampleMode);
    } else {
      engine.setSample(null);
    }
  }

  /** 扫描素材：裁掉前后静音，并切出每个“冰”字的位置 */
  function analyzeSample(buf) {
    var ch = buf.getChannelData(0);
    var sr = buf.sampleRate;
    var n = ch.length;
    var peak = 0, i, a;
    for (i = 0; i < n; i++) { a = Math.abs(ch[i]); if (a > peak) peak = a; }
    var th = Math.max(0.008, peak * 0.06);
    var first = -1, last = -1;
    for (i = 0; i < n; i++) { if (Math.abs(ch[i]) > th) { first = i; break; } }
    for (i = n - 1; i >= 0; i--) { if (Math.abs(ch[i]) > th) { last = i; break; } }
    if (first < 0) {
      return { bounds: { start: 0, end: buf.duration }, segments: [[0, buf.duration]] };
    }
    var bounds = {
      start: Math.max(0, (first - Math.floor(sr * 0.004)) / sr),
      end: Math.min(buf.duration, (last + Math.floor(sr * 0.012)) / sr)
    };

    // 5ms 帧包络 → 找每个“冰”字的起音峰，用峰的位置切段
    var frame = Math.max(1, Math.floor(sr * 0.005));
    var i0 = Math.floor(bounds.start * sr);
    var i1 = Math.floor(bounds.end * sr);
    var env = [];
    for (i = i0; i < i1; i += frame) {
      var sum = 0, cnt = 0;
      for (var k = i; k < Math.min(i + frame, i1); k++) { sum += Math.abs(ch[k]); cnt++; }
      env.push(cnt ? sum / cnt : 0);
    }
    var maxE = 0;
    for (i = 0; i < env.length; i++) { if (env[i] > maxE) maxE = env[i]; }
    var frameSec = frame / sr;
    var peaks = [];
    for (i = 1; i < env.length - 1; i++) {
      if (env[i] >= env[i - 1] && env[i] > env[i + 1] && env[i] > maxE * 0.35) {
        var t = bounds.start + i * frameSec;
        if (!peaks.length || t - peaks[peaks.length - 1] > 0.06) peaks.push(t);
      }
    }

    var segments = [];
    if (peaks.length >= 2) {
      for (i = 0; i < peaks.length; i++) {
        var st = Math.max(bounds.start, peaks[i] - 0.012);
        var en = (i + 1 < peaks.length)
          ? Math.max(st + 0.05, peaks[i + 1] - 0.012)
          : bounds.end;
        segments.push([st, Math.min(bounds.end, en)]);
      }
    } else {
      segments.push([bounds.start, bounds.end]);
    }
    return { bounds: bounds, segments: segments };
  }

  /**
   * 识别素材本身的音高，返回 {midi, freq}
   * 素材若不是按它自己的音高播放（采样根音设错），整条旋律会被整体移调，
   * 而且播放速率一变，本来就短的“冰”会被压得更短，听起来就只剩“哒哒哒”。
   */
  function detectSampleRoot(buf, seg) {
    var AA = window.BingAutoArrange;
    if (!AA || !seg || !AA._internals || !AA._internals.estimateF0) return null;
    try {
      var data = buf.getChannelData(0);
      var sr = buf.sampleRate;
      var r = AA._internals.estimateF0(data, sr,
        Math.floor(seg[0] * sr), Math.floor((seg[1] - seg[0]) * sr));
      if (!r || !r.f0 || r.clarity < 0.5 || r.f0 < 55 || r.f0 > 1200) return null;
      return {
        midi: Math.round(69 + 12 * Math.log(r.f0 / 440) / Math.LN2),
        freq: r.f0,
        clarity: r.clarity
      };
    } catch (e) {
      return null;
    }
  }

  /** 采纳一段素材：分析静音与分段、识别音高并同步到引擎，返回描述文本 */
  function adoptSample(buf) {
    var a = analyzeSample(buf);
    state.sampleBounds = a.bounds;
    state.sampleSegments = a.segments;

    var info = buf.duration.toFixed(2) + 's · ' + buf.sampleRate + 'Hz · 裁静音后 ' +
      Math.max(0, a.bounds.end - a.bounds.start).toFixed(2) + 's · 切出 ' + a.segments.length + ' 段';

    var detected = detectSampleRoot(buf, a.segments[0] || [a.bounds.start, a.bounds.end]);
    if (detected) {
      state.sampleRoot = detected.midi;
      engine.sampleRoot = detected.midi;
      if ($('#sample-root')) $('#sample-root').value = String(detected.midi);
      info += ' · 原素材音高≈' + A.midiToName(detected.midi) + '（' + detected.freq.toFixed(0) +
        'Hz）已自动设为采样根音';
    }
    applySource();
    return info;
  }

  /* ---------------- 标签页 ---------------- */

  $$('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      $$('.tab').forEach(function (t) { t.classList.remove('active'); });
      $$('.panel').forEach(function (p) { p.classList.remove('active'); });
      tab.classList.add('active');
      $('#panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  /* ---------------- 雪 ---------------- */

  (function snow() {
    var host = $('#snow');
    for (var i = 0; i < 44; i++) {
      var s = document.createElement('i');
      var size = 2 + Math.random() * 3;
      s.style.left = (Math.random() * 100) + '%';
      s.style.width = size + 'px';
      s.style.height = size + 'px';
      s.style.opacity = 0.25 + Math.random() * 0.5;
      s.style.animationDuration = (9 + Math.random() * 14) + 's';
      s.style.animationDelay = (-Math.random() * 20) + 's';
      s.style.setProperty('--dx', (Math.random() * 120 - 60) + 'px');
      host.appendChild(s);
    }
  })();

  /* ---------------- 弹奏器 ---------------- */

  var keyEls = {};

  function buildKeys() {
    var host = $('#keys');
    host.innerHTML = '';
    keyEls = {};
    Object.keys(KEY_MAP).map(function (k) { return { key: k, midi: KEY_MAP[k] }; })
      .sort(function (a, b) { return a.midi - b.midi; })
      .forEach(function (item) {
        var el = document.createElement('div');
        el.className = 'key';
        el.dataset.midi = item.midi;
        el.innerHTML = '<span class="ripple"></span><span class="glyph">冰</span>' +
          '<span class="meta">' + item.key.toUpperCase() + ' · ' + A.midiToName(item.midi) + '</span>';
        el.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          pressKey(item.midi);
        });
        host.appendChild(el);
        if (!keyEls[item.midi]) keyEls[item.midi] = [];
        keyEls[item.midi].push(el);
      });
  }

  function flashKey(midi) {
    var els = keyEls[midi];
    if (!els) return;
    els.forEach(function (el) {
      el.classList.add('active');
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.classList.remove('active'); }, 150);
    });
  }

  function pressKey(midi) {
    trigger(midi, 0.95, true);
    flashKey(midi);
  }

  buildKeys();

  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    var midi = KEY_MAP[e.key.toLowerCase()];
    if (midi === undefined) return;
    e.preventDefault();
    pressKey(midi);
    if ($('#chk-keyhold').checked && !state.heldKeys[midi]) {
      state.heldKeys[midi] = setInterval(function () { pressKey(midi); }, 110);
    }
  });

  document.addEventListener('keyup', function (e) {
    var midi = KEY_MAP[e.key.toLowerCase()];
    if (midi === undefined) return;
    if (state.heldKeys[midi]) {
      clearInterval(state.heldKeys[midi]);
      delete state.heldKeys[midi];
    }
  });

  window.addEventListener('blur', function () {
    Object.keys(state.heldKeys).forEach(function (m) {
      clearInterval(state.heldKeys[m]);
      delete state.heldKeys[m];
    });
  });

  $('#btn-demo').addEventListener('click', function () { trigger(72, 1, false); });

  $('#btn-record').addEventListener('click', function () {
    state.recording = !state.recording;
    var btn = $('#btn-record');
    if (state.recording) {
      state.recEvents = [];
      state.recStart = performance.now();
      btn.classList.add('on');
      btn.textContent = '停止录制';
      $('#rec-status').textContent = '录制中…（弹你的节奏）';
      $('#btn-quantize').disabled = true;
    } else {
      btn.classList.remove('on');
      btn.textContent = '开始录制';
      $('#rec-status').textContent = state.recEvents.length
        ? '录到 ' + state.recEvents.length + ' 个冰'
        : '没录到东西';
      $('#btn-quantize').disabled = state.recEvents.length === 0;
    }
  });

  $('#btn-quantize').addEventListener('click', function () {
    if (!recordingToGrid()) {
      $('#rec-status').textContent = '没录到东西';
      return;
    }
    buildGrid();
    $('#rec-status').textContent = '已排进制作器网格';
    $$('.tab').forEach(function (t) { t.classList.remove('active'); });
    $$('.panel').forEach(function (p) { p.classList.remove('active'); });
    $('.tab[data-tab="make"]').classList.add('active');
    $('#panel-make').classList.add('active');
  });

  function recordingToGrid() {
    var evs = state.recEvents;
    if (!evs.length) return false;
    var p = state.pattern;
    var stepMs = 60000 / p.bpm / 4;
    var base = evs[0].t;
    var placed = evs.map(function (e) {
      return { midi: e.midi, step: Math.max(0, Math.round((e.t - base) / stepMs)) };
    });
    var maxStep = placed.reduce(function (a, e) { return Math.max(a, e.step); }, 0);
    var steps = p.steps;
    while (steps <= maxStep && steps < 128) steps *= 2;
    if (steps !== p.steps) {
      resizeCells(steps);
      $('#steps').value = String(steps);
    }
    clearRows(p.steps);
    placed.forEach(function (e) {
      if (e.step >= p.steps) return;
      var tr = p.tracks[rowIndex(e.midi)];
      if (tr) tr.cells[e.step] = true;
    });
    return true;
  }

  /* ---------------- 制作器：网格 ---------------- */

  var grid = $('#grid');
  grid.style.userSelect = 'none';
  var paintValue = null;

  function buildGrid() {
    var p = state.pattern;
    var onlyUsed = $('#chk-onlyused') && $('#chk-onlyused').checked;
    grid.innerHTML = '';
    grid.style.setProperty('--steps', p.steps);

    var head = document.createElement('div');
    head.className = 'grid-row grid-head';
    var corner = document.createElement('div');
    corner.className = 'row-label';
    corner.innerHTML = '<span class="note" style="text-align:left;min-width:74px">音高 / 控制</span>';
    head.appendChild(corner);
    for (var s = 0; s < p.steps; s++) {
      var sh = document.createElement('div');
      sh.className = 'step-head' + (s % 4 === 0 ? ' bar' : '');
      sh.textContent = (s % 4 === 0 ? (s / 4 + 1) : '·');
      head.appendChild(sh);
    }
    grid.appendChild(head);

    // 从上到下：高音在上一行，和五线谱的直觉一致
    var order = [];
    for (var ti = p.tracks.length - 1; ti >= 0; ti--) order.push(ti);

    order.forEach(function (ti) {
      var tr = p.tracks[ti];
      if (onlyUsed && !tr.cells.some(Boolean)) return;
      var row = document.createElement('div');
      row.className = 'grid-row' + (A.midiToName(tr.midi).indexOf('#') >= 0 ? ' accidental' : '');
      row.dataset.track = ti;

      var label = document.createElement('div');
      label.className = 'row-label';
      label.innerHTML =
        '<span class="note">' + A.midiToName(tr.midi) + '</span>' +
        '<button class="mini toggle' + (tr.muted ? ' on' : '') + '" data-act="mute">M</button>' +
        '<button class="mini toggle' + (tr.solo ? ' on' : '') + '" data-act="solo">S</button>' +
        '<input class="gain" type="range" data-act="gain" min="0" max="1" step="0.05" value="' + tr.gain + '">' +
        '<button class="mini" data-act="clear">×</button>';
      row.appendChild(label);

      // 先算出这一行每个格子是被“音符头”占着，还是被前一个音符的时值覆盖（延音）
      var headAt = new Array(p.steps).fill(false);
      var heldAt = new Array(p.steps).fill(false);
      var velAt = new Array(p.steps).fill(0);
      for (var s0 = 0; s0 < p.steps; s0++) {
        if (!tr.cells[s0]) continue;
        headAt[s0] = true;
        velAt[s0] = noteVel(p, ti, s0);
        var len = Math.round(noteDur(p, ti, s0));
        for (var k = 1; k < len && s0 + k < p.steps; k++) heldAt[s0 + k] = true;
      }

      for (var s = 0; s < p.steps; s++) {
        var cell = document.createElement('div');
        var cls = 'cell' + (s % 4 === 0 ? ' bar' : '');
        if (headAt[s]) {
          cls += ' on';
          if (velAt[s] > 1.02) cls += ' vel-hard';
          else if (velAt[s] < 0.6) cls += ' vel-soft';
        } else if (heldAt[s]) {
          cls += ' held';
        }
        cell.className = cls;
        cell.dataset.step = s;
        cell.dataset.track = ti;
        row.appendChild(cell);
      }
      grid.appendChild(row);
    });
  }

  /** 整块重画一行以外的轻量同步（时值/力度变了要重画保持/力度样式） */
  function syncCells() {
    var p = state.pattern;
    var held = {};
    p.tracks.forEach(function (tr, ti) {
      for (var s = 0; s < p.steps; s++) {
        if (!tr.cells[s]) continue;
        var len = Math.round(noteDur(p, ti, s));
        for (var k = 1; k < len && s + k < p.steps; k++) held[ti + ':' + (s + k)] = true;
      }
    });
    $$('.cell', grid).forEach(function (cell) {
      var ti = +cell.dataset.track, s = +cell.dataset.step;
      var tr = p.tracks[ti];
      if (!tr) return;
      var on = !!tr.cells[s];
      cell.classList.toggle('on', on);
      cell.classList.toggle('held', !on && !!held[ti + ':' + s]);
      if (on) {
        var v = noteVel(p, ti, s);
        cell.classList.toggle('vel-hard', v > 1.02);
        cell.classList.toggle('vel-soft', v < 0.6);
      } else {
        cell.classList.remove('vel-hard', 'vel-soft');
      }
    });
    $$('.grid-row', grid).forEach(function (row) {
      var ti = +row.dataset.track;
      if (isNaN(ti)) return;
      var tr = p.tracks[ti];
      var label = $('.row-label', row);
      if (!label || !tr) return;
      $('.note', label).textContent = A.midiToName(tr.midi);
      $('[data-act=mute]', label).classList.toggle('on', tr.muted);
      $('[data-act=solo]', label).classList.toggle('on', tr.solo);
      $('[data-act=gain]', label).value = tr.gain;
    });
  }

  /** 画笔参数：新画的音符用多长、多重 */
  function brushLen() {
    var el = $('#brush-len');
    return el ? Math.max(1, parseInt(el.value, 10) || 1) : 1;
  }

  function brushVel() {
    var el = $('#brush-vel');
    return el ? Math.max(0.05, Math.min(1.5, parseFloat(el.value) || 0.85)) : 0.85;
  }

  function applyCell(ti, s, value) {
    var tr = state.pattern.tracks[ti];
    if (!tr) return;
    if (!!tr.cells[s] === value) return;
    setNote(ti, s, value, value ? brushLen() : 1, value ? brushVel() : 0.85);
    var cell = $('.cell[data-track="' + ti + '"][data-step="' + s + '"]', grid);
    if (cell) {
      cell.classList.toggle('on', value);
      cell.classList.remove('held');
      if (value) {
        if (brushVel() > 1.02) cell.classList.add('vel-hard');
        else if (brushVel() < 0.6) cell.classList.add('vel-soft');
      } else {
        cell.classList.remove('vel-hard', 'vel-soft');
      }
    }
    if (value) trigger(tr.midi, tr.gain * brushVel(), false);
    syncCells();
  }

  grid.addEventListener('pointerdown', function (e) {
    var cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault();
    var ti = +cell.dataset.track, s = +cell.dataset.step;
    var p = state.pattern;
    // Shift+点：把这个音拉长一格；Alt+点：缩短一格
    if (p.tracks[ti].cells[s] && (e.shiftKey || e.altKey)) {
      bumpNoteDur(ti, s, e.shiftKey ? 1 : -1);
      syncCells();
      return;
    }
    paintValue = !p.tracks[ti].cells[s];
    applyCell(ti, s, paintValue);
  });

  grid.addEventListener('pointerover', function (e) {
    if (paintValue === null) return;
    var cell = e.target.closest('.cell');
    if (!cell) return;
    applyCell(+cell.dataset.track, +cell.dataset.step, paintValue);
  });

  window.addEventListener('pointerup', function () { paintValue = null; });

  grid.addEventListener('contextmenu', function (e) {
    var cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault();
    bumpNoteDur(+cell.dataset.track, +cell.dataset.step, -1);
    syncCells();
  });

  grid.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'INPUT') return;
    var row = btn.closest('.grid-row');
    var ti = +row.dataset.track;
    var tr = state.pattern.tracks[ti];
    if (!tr) return;
    var act = btn.dataset.act;
    if (act === 'note') trigger(tr.midi, tr.gain, false);
    else if (act === 'mute') tr.muted = !tr.muted;
    else if (act === 'solo') tr.solo = !tr.solo;
    else if (act === 'clear') {
      for (var s = 0; s < state.pattern.steps; s++) setNote(ti, s, false);
    }
    syncCells();
  });

  grid.addEventListener('input', function (e) {
    if (e.target.dataset.act !== 'gain') return;
    var ti = +e.target.closest('.grid-row').dataset.track;
    state.pattern.tracks[ti].gain = parseFloat(e.target.value);
  });

  /* ---------------- 传输 ---------------- */

  function stepDuration() { return 60 / state.pattern.bpm / 4; }

  function swingOffset(step) {
    return (step % 2 === 1) ? state.pattern.swing * stepDuration() * 0.5 : 0;
  }

  /** 一个音符的时值（秒） */
  function noteDurSec(p, ti, s) {
    return Math.max(1, noteDur(p, ti, s)) * stepDuration();
  }

  function scheduleStep(step, time) {
    var p = state.pattern;
    var soloed = p.tracks.some(function (t) { return t.solo; });
    var stepSec = stepDuration();
    p.tracks.forEach(function (tr, ti) {
      if (!tr.cells[step]) return;
      if (tr.muted || (soloed && !tr.solo)) return;
      // 力度来自音符本身（扒谱时按起音强度定，手画时按画笔力度定）
      var vel = tr.gain * noteVel(p, ti, step);
      var lenSec = noteDurSec(p, ti, step);
      engine.playNote(tr.midi, time, vel, lenSec);
      // 很长的音（≥2 拍）中途补两次轻击，听起来才是“按住了”，而不是一下就没
      if (lenSec >= stepSec * 8) {
        engine.playNote(tr.midi, time + lenSec * 0.5, vel * 0.42, lenSec * 0.5);
        engine.playNote(tr.midi, time + lenSec * 0.78, vel * 0.3, lenSec * 0.22);
      }
    });
    if (state.metronome) engine.click(time, step % 4 === 0);
  }

  function scheduler() {
    var ctx = engine.ctx;
    if (!ctx) return;
    var p = state.pattern;
    while (state.nextTime < ctx.currentTime + 0.12) {
      if (!state.loop && state.schedulerStep >= p.steps) { stop(); return; }
      var step = state.schedulerStep % p.steps;
      var when = state.nextTime + swingOffset(step);
      scheduleStep(step, when);
      (function (s, delay) {
        setTimeout(function () { highlightStep(s); }, Math.max(0, delay * 1000));
      })(step, when - ctx.currentTime);
      state.nextTime += stepDuration();
      state.schedulerStep++;
    }
  }

  function highlightStep(step) {
    $$('.cell.playing', grid).forEach(function (c) { c.classList.remove('playing'); });
    if (step < 0) return;
    $$('.cell[data-step="' + step + '"]', grid).forEach(function (c) { c.classList.add('playing'); });
  }

  function play() {
    ensureAudio();
    if (state.playing) return;
    state.playing = true;
    state.schedulerStep = 0;
    state.nextTime = engine.ctx.currentTime + 0.08;
    state.timer = setInterval(scheduler, 20);
    scheduler();
    $('#transport-status').textContent = '播放中';
    $('#btn-play').classList.add('primary');
  }

  function stop() {
    if (!state.playing) return;
    state.playing = false;
    clearInterval(state.timer);
    state.timer = null;
    highlightStep(-1);
    $('#transport-status').textContent = '已停止';
  }

  $('#btn-play').addEventListener('click', play);
  $('#btn-stop').addEventListener('click', stop);

  $('#bpm').addEventListener('input', function () {
    state.pattern.bpm = parseInt(this.value, 10);
    $('#bpm-val').textContent = this.value;
  });
  $('#swing').addEventListener('input', function () {
    state.pattern.swing = parseFloat(this.value);
    $('#swing-val').textContent = Math.round(this.value * 100) + '%';
  });
  $('#chk-metro').addEventListener('change', function () { state.metronome = this.checked; });
  $('#chk-loop').addEventListener('change', function () { state.loop = this.checked; });
  $('#steps').addEventListener('change', function () {
    resizeCells(parseInt(this.value, 10));
    buildGrid();
  });

  /* ---------------- 预设 / 随机 / 清空 ---------------- */

  function applyPreset(index) {
    var steps = state.pattern.steps;
    var p = createPattern(steps);
    var map = [
      // 经典冰冰冰
      {
        bpm: 128, notes: [
          { midi: 60, steps: [0, 4, 8, 12] },
          { midi: 72, steps: [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14] },
          { midi: 76, steps: [3, 7, 11, 15] }
        ]
      },
      // Bang 副歌感
      {
        bpm: 132, notes: [
          { midi: 60, steps: [0, 4, 8, 12] },
          { midi: 64, steps: [2, 6, 10, 14] },
          { midi: 72, steps: [0, 1, 2, 8, 9, 10] },
          { midi: 79, steps: [4, 5, 12, 13] }
        ]
      },
      // 冰原回响
      {
        bpm: 82, notes: [
          { midi: 67, steps: [0, 6, 10] },
          { midi: 72, steps: [0, 3, 8] },
          { midi: 76, steps: [12, 14] },
          { midi: 79, steps: [15] }
        ]
      }
    ][index];
    map.notes.forEach(function (n) {
      var ri = rowIndex(n.midi);
      var tr = p.tracks[ri];
      if (!tr) return;
      n.steps.forEach(function (s) {
        if (s >= steps) return;
        tr.cells[s] = true;
        // 预设带一点重音：小节头一记更用力，听起来才有律动
        p.vels[noteKey(ri, s)] = (s % 4 === 0) ? 1.15 : 0.8;
        p.durs[noteKey(ri, s)] = 1;
      });
    });
    p.bpm = map.bpm;
    if (index === 2) { state.reverb.size = 3.2; state.reverb.mix = 0.34; }
    if (index === 0) { state.reverb.size = 1.6; state.reverb.mix = 0.18; }
    state.pattern = p;
    syncUIFromPattern();
    buildGrid();
    applyTone();
    syncSliders();
  }

  $$('[data-preset]').forEach(function (btn) {
    btn.addEventListener('click', function () { applyPreset(parseInt(btn.dataset.preset, 10)); });
  });

  $('#btn-random').addEventListener('click', function () {
    var p = state.pattern;
    var rows = p.tracks.length;
    p.durs = {};
    p.vels = {};
    p.tracks.forEach(function (tr, i) {
      // 越低的音越密，听起来像“底鼓 + 点缀”
      var density = 0.04 + (rows - i) / rows * 0.14;
      for (var s = 0; s < p.steps; s++) {
        var on = Math.random() < (s % 4 === 0 ? density * 1.6 : density);
        tr.cells[s] = on;
        if (!on) continue;
        p.vels[noteKey(i, s)] = Math.round((0.55 + Math.random() * 0.6) * 100) / 100;
        if (Math.random() < 0.15) p.durs[noteKey(i, s)] = 2 + Math.floor(Math.random() * 3);
      }
    });
    buildGrid();
  });

  $('#btn-clear').addEventListener('click', function () {
    clearRows(state.pattern.steps);
    buildGrid();
  });

  var onlyUsedBox = $('#chk-onlyused');
  if (onlyUsedBox) onlyUsedBox.addEventListener('change', buildGrid);

  /* ---------------- 内嵌素材自动加载 ---------------- */

  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function loadEmbeddedSample() {
    var data = window.BING_SAMPLE;
    if (!data || !data.data) {
      $('#sample-info').textContent = '尚未载入采样，可拖入 冰冰冰.m4a / .wav / .mp3';
      return;
    }
    var ctx = engine.init();
    ctx.decodeAudioData(base64ToArrayBuffer(data.data), function (buf) {
      state.sampleBuffer = buf;
      state.sampleName = data.name || '内置冰冰冰';
      if (typeof data.root === 'number') {
        state.sampleRoot = data.root;
        engine.sampleRoot = data.root;
        $('#sample-root').value = String(data.root);
      }
      var info = adoptSample(buf);
      $('#sample-info').textContent = '内置素材：' + state.sampleName + '（' + (data.file || '') + '） · ' + info;
      setSource('sample');
    }, function () {
      $('#sample-info').textContent = '内置素材解码失败，请拖入音频文件手动加载';
    });
  }

  /* ---------------- 音源 ---------------- */

  function setSource(src) {
    state.soundSource = src;
    if (src === 'sample' && !state.sampleBuffer) {
      src = 'synth';
      state.soundSource = 'synth';
    }
    applySource();
    $('#btn-src-synth').classList.toggle('active', state.soundSource === 'synth');
    $('#btn-src-sample').classList.toggle('active', state.soundSource === 'sample');
    $('#source-status').textContent = state.soundSource === 'sample'
      ? '当前：采样音源（' + state.sampleName + '）'
      : '当前：合成冰音';
  }

  $('#btn-src-synth').addEventListener('click', function () { setSource('synth'); });
  $('#btn-src-sample').addEventListener('click', function () { setSource('sample'); });
  $('#sample-root').addEventListener('change', function () {
    state.sampleRoot = parseInt(this.value, 10);
    applySource();
  });
  $('#sample-mode').addEventListener('change', function () {
    state.sampleMode = this.value;
    applySource();
  });
  $('#btn-sample-raw').addEventListener('click', function () {
    if (!state.sampleBuffer) {
      $('#sample-info').textContent = '还没有采样可试听，先拖入音频文件';
      return;
    }
    var ctx = ensureAudio();
    engine.playRawSample(ctx.currentTime + 0.01, Math.min(1, state.tone.gain || 1));
  });
  $('#btn-sample-clear').addEventListener('click', function () {
    state.sampleBuffer = null;
    state.sampleName = '';
    state.sampleBounds = null;
    state.sampleSegments = null;
    engine.clearSample();
    $('#sample-info').textContent = '尚未载入采样';
    setSource('synth');
  });

  var dropzone = $('#dropzone');
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('dragover'); });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadSampleFile(file);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  $('#file-sample').addEventListener('change', function () {
    if (this.files && this.files[0]) loadSampleFile(this.files[0]);
    this.value = '';
  });

  function loadSampleFile(file) {
    var ctx = ensureAudio();
    var reader = new FileReader();
    reader.onload = function () {
      ctx.decodeAudioData(reader.result, function (buf) {
        state.sampleBuffer = buf;
        state.sampleName = file.name;
        var info = adoptSample(buf);
        $('#sample-info').textContent = '已载入：' + file.name + ' · ' + info;
        setSource('sample');
      }, function () {
        $('#sample-info').textContent = '解码失败，请换 wav / mp3 试试';
      });
    };
    reader.readAsArrayBuffer(file);
  }

  /* ---------------- 音色滑杆 ---------------- */

  function bindSlider(id, labelId, apply, format) {
    var el = $(id);
    var out = $(labelId);
    function update() {
      var v = parseFloat(el.value);
      out.textContent = format ? format(v) : v.toFixed(2);
      apply(v);
    }
    el.addEventListener('input', update);
    update();
  }

  bindSlider('#tone-bright', '#tone-bright-val', function (v) { state.tone.brightness = v; applyTone(); });
  bindSlider('#tone-decay', '#tone-decay-val', function (v) { state.tone.decay = v; applyTone(); });
  bindSlider('#tone-gain', '#tone-gain-val', function (v) { state.tone.gain = v; applyTone(); });
  bindSlider('#tone-pitch', '#tone-pitch-val', function (v) { state.tone.pitch = v; applyTone(); }, function (v) { return (v > 0 ? '+' : '') + v; });
  bindSlider('#rev-size', '#rev-size-val', function (v) { state.reverb.size = v; applyTone(); }, function (v) { return v.toFixed(1); });
  bindSlider('#rev-mix', '#rev-mix-val', function (v) { state.reverb.mix = v; applyTone(); });
  bindSlider('#sample-body', '#sample-body-val', function (v) { engine.setSampleBody(v); });
  bindSlider('#brush-vel', '#brush-vel-val', function () { /* 画笔力度只影响新画的音符，这里只更新数字 */ });

  function syncSliders() {
    $('#rev-size').value = state.reverb.size;
    $('#rev-size-val').textContent = state.reverb.size.toFixed(1);
    $('#rev-mix').value = state.reverb.mix;
    $('#rev-mix-val').textContent = state.reverb.mix.toFixed(2);
  }

  /* ---------------- 导入音乐 · 自动编曲 ---------------- */

  var musicDrop = $('#music-drop');
  // 整个「导入音乐」卡片都是拖放区，不必精确丢到虚线框里
  var musicCard = musicDrop.closest('.card') || musicDrop;

  musicCard.addEventListener('dragover', function (e) {
    e.preventDefault();
    musicDrop.classList.add('dragover');
  });
  musicCard.addEventListener('dragleave', function (e) {
    if (!musicCard.contains(e.relatedTarget)) musicDrop.classList.remove('dragover');
  });
  musicCard.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    musicDrop.classList.remove('dragover');
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadMusicFile(file);
  });
  $('#file-music').addEventListener('change', function () {
    if (this.files && this.files[0]) loadMusicFile(this.files[0]);
    this.value = '';
  });

  function adoptMusicBuffer(buf, name) {
    state.musicBuffer = buf;
    state.musicName = name;
    $('#music-info').textContent = '已就绪：' + name + ' · ' + buf.duration.toFixed(1) + 's · ' +
      buf.sampleRate + 'Hz · ' + buf.numberOfChannels + 'ch';
    $('#arr-start').value = '0';
    $('#arr-len').value = String(Math.min(8, Math.max(2, Math.round(buf.duration))));
    $('#btn-arrange').disabled = false;
    $('#btn-audition').disabled = false;
    $('#arrange-status').textContent = '待分析';
  }

  function loadMusicFile(file) {
    var ctx = ensureAudio();
    $('#arrange-status').textContent = '解码中…';
    var reader = new FileReader();
    reader.onload = function () {
      ctx.decodeAudioData(reader.result, function (buf) {
        adoptMusicBuffer(buf, file.name);
      }, function () {
        $('#arrange-status').textContent = '解码失败';
        $('#music-info').textContent = '这个文件解不开（浏览器只支持 mp3 / m4a(aac) / wav / ogg / flac），' +
          '可以先转成 mp3 再试，或者点「用示例曲试一次」看看功能本身';
      });
    };
    reader.readAsArrayBuffer(file);
  }

  $('#btn-demo-song').addEventListener('click', function () {
    var ctx = ensureAudio();
    $('#arrange-status').textContent = '生成示例曲…';
    setTimeout(function () {
      try {
        var buf = window.BingDemoSong.create(ctx, { bpm: 100, seconds: 8, sampleRate: 22050 });
        adoptMusicBuffer(buf, '内置示例曲（100 BPM 鼓+贝斯+和弦+旋律）');
        // 示例曲的意义就是演示“扒谱”，所以强制走旋律模式（这个片段有主旋律，扒得出来）
        $('#arr-pitch').value = 'melody';
        $('#btn-arrange').click();
      } catch (e) {
        $('#arrange-status').textContent = '示例曲生成失败';
        $('#arrange-detail').textContent = String((e && e.message) || e);
      }
    }, 30);
  });

  $('#arr-sens').addEventListener('input', function () {
    $('#arr-sens-val').textContent = parseFloat(this.value).toFixed(1);
  });
  $('#arr-tempo').addEventListener('change', function () {
    $('#arr-bpm-wrap').hidden = this.value !== 'manual';
  });

  function stopAudition() {
    if (state.auditionNode) {
      try { state.auditionNode.stop(); } catch (e) { /* 已停止 */ }
      state.auditionNode = null;
    }
    $('#btn-audition-stop').disabled = true;
  }

  function auditionChunk() {
    if (!state.musicBuffer) return;
    var ctx = ensureAudio();
    stopAudition();
    var start = Math.max(0, Math.min(parseFloat($('#arr-start').value) || 0, state.musicBuffer.duration - 0.5));
    var len = Math.max(0.5, parseFloat($('#arr-len').value) || 8);
    var src = ctx.createBufferSource();
    src.buffer = state.musicBuffer;
    var g = ctx.createGain();
    g.gain.value = 0.75;
    src.connect(g);
    g.connect(ctx.destination);
    src.start(ctx.currentTime + 0.03, start, Math.min(len, state.musicBuffer.duration - start));
    state.auditionNode = src;
    $('#btn-audition-stop').disabled = false;
    src.onended = function () {
      if (state.auditionNode === src) {
        state.auditionNode = null;
        $('#btn-audition-stop').disabled = true;
      }
    };
  }

  $('#btn-audition').addEventListener('click', auditionChunk);
  $('#btn-audition-stop').addEventListener('click', stopAudition);

  function applyArrangement(result) {
    var p = state.pattern;
    p.bpm = result.bpm;
    p.swing = 0;
    resizeCells(result.steps);
    clearRows(result.steps);
    // 每个识别出来的音高落到对应的行上（不再压缩成 8 条轨），
    // 同时把扒出来的时值和力度一起搬过来
    result.tracks.forEach(function (src) {
      var ri = rowIndex(src.midi);
      var tr = p.tracks[ri];
      if (!tr) return;
      var hit = false;
      for (var s = 0; s < result.steps && s < tr.cells.length; s++) {
        if (!src.cells[s]) continue;
        tr.cells[s] = true;
        hit = true;
        var key = noteKey(ri, s);
        var d = src.durs && src.durs[s];
        if (d && d > 1) p.durs[key] = Math.min(64, d);
        var v = src.vels && src.vels[s];
        if (typeof v === 'number') p.vels[key] = v;
      }
      if (hit) tr.gain = src.gain;
    });
    syncUIFromPattern();
    buildGrid();
  }

  $('#btn-arrange').addEventListener('click', function () {
    if (!state.musicBuffer) return;
    var btn = this;
    btn.disabled = true;
    $('#arrange-status').textContent = '分析中…';
    setTimeout(function () {
      try {
        var tempoMode = $('#arr-tempo').value;
        var result = window.BingAutoArrange.arrange(state.musicBuffer, {
          start: Math.max(0, parseFloat($('#arr-start').value) || 0),
          length: Math.max(2, parseFloat($('#arr-len').value) || 8),
          sensitivity: parseFloat($('#arr-sens').value) || 1.3,
          pitchMode: $('#arr-pitch').value,
          scale: $('#arr-scale').value,
          baseMidi: 72,
          maxTracks: state.pattern.tracks.length,
          tempoFold: (tempoMode === 'half' || tempoMode === 'double') ? tempoMode : 'auto',
          bpmOverride: tempoMode === 'manual' ? (parseFloat($('#arr-bpm').value) || 0) : 0,
          stepDiv: parseInt($('#arr-grid').value, 10) || 1
        });
        if (!result.ok) {
          $('#arrange-status').textContent = '没能生成';
          $('#arrange-detail').textContent = result.reason || '换一段音频，或把灵敏度调小一点再试';
          if ($('#arrange-score')) $('#arrange-score').textContent = '';
        } else {
          applyArrangement(result);
          var used = result.tracks.filter(function (t) {
            return t.cells.some(Boolean);
          }).length;
          $('#arrange-status').textContent = '已生成';
          if (tempoMode === 'auto') $('#arr-bpm').value = String(result.bpm);
          var bars = result.steps / 16;
          var pitchMode = $('#arr-pitch').value;
          var extra = '';
          if (pitchMode === 'melody' && used <= 2) {
            extra = ' · 只认出 ' + used + ' 个音高，这段多半是纯鼓点/环境音，建议换片段或改用「单调」模式';
          }
          $('#arrange-detail').textContent = '音高模式：' +
            (pitchMode === 'melody' ? '旋律（扒谱）' : '单调（纯节奏）') +
            ' · 检测到 ' + result.bpm + ' BPM · 抓到 ' + result.onsets +
            ' 个节奏点 · 落格 ' + result.notes + ' 个 · ' + used + ' 个不同音高 · ' + result.steps +
            ' 格（' + (result.steps % 16 === 0 ? bars : bars.toFixed(2)) + ' 小节，' +
            result.detectedFrom.toFixed(1) + 's 起，取 ' + result.analyzedLength.toFixed(1) + 's）' +
            (result.warnings.length ? ' · ' + result.warnings.join('；') : '') + extra;

          var scoreEl = $('#arrange-score');
          if (scoreEl) {
            if (pitchMode !== 'melody') {
              scoreEl.textContent = '现在是「单调」模式：' + result.notes + ' 个节奏点全部打在同一个音上，' +
                '所以谱子当然全是一样的音。想看真正的谱子，把上面的「音高」切到「旋律（扒谱，推荐）」再点一次「自动编曲」。';
            } else if (result.melody && result.melody.length) {
              var names = result.melody.slice(0, 40).map(function (m) { return A.midiToName(m); });
              scoreEl.textContent = '扒出来的谱子（' + result.melody.length + ' 个音，' +
                used + ' 个不同音高）：' + names.join(' ') +
                (result.melody.length > 40 ? ' …' : '');
            } else {
              scoreEl.textContent = '';
            }
          }
          if (grid.scrollIntoView) grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if ($('#chk-autoplay').checked) {
            stop();
            play();
          }
        }
      } catch (err) {
        $('#arrange-status').textContent = '分析出错';
        $('#arrange-detail').textContent = String((err && err.message) || err);
      }
      btn.disabled = false;
    }, 30);
  });

  /* ---------------- 存储 / 导出 ---------------- */

  function syncUIFromPattern() {
    $('#bpm').value = state.pattern.bpm;
    $('#bpm-val').textContent = state.pattern.bpm;
    $('#swing').value = state.pattern.swing;
    $('#swing-val').textContent = Math.round(state.pattern.swing * 100) + '%';
    $('#steps').value = String(state.pattern.steps);
  }

  function serialize() {
    return {
      version: 3,                 // v3：行 = 音高 + 每个音符带时值/力度
      rowBase: ROW_LOW,
      pattern: state.pattern,
      tone: state.tone,
      reverb: state.reverb
    };
  }

  function deserialize(data) {
    if (!data || !data.pattern) return false;
    var steps = data.pattern.steps || 16;
    var p = createPattern(steps);
    p.bpm = data.pattern.bpm || 120;
    p.swing = data.pattern.swing || 0;
    var isV2 = (data.version || 1) >= 2;
    var base = typeof data.rowBase === 'number' ? data.rowBase : ROW_LOW;
    (data.pattern.tracks || []).forEach(function (tr, i) {
      // v2 的行音高由位置决定；旧存档（v1，8 条轨）按它自带的音高映射过来
      var midi = isV2 ? (base + i) : (typeof tr.midi === 'number' ? tr.midi : base + i);
      var dst = p.tracks[rowIndex(midi)];
      if (!dst) return;
      dst.gain = typeof tr.gain === 'number' ? tr.gain : 0.85;
      dst.muted = !!tr.muted;
      dst.solo = !!tr.solo;
      for (var s = 0; s < steps; s++) if (tr.cells && tr.cells[s]) dst.cells[s] = true;
    });
    state.pattern = p;
    if (data.tone) state.tone = Object.assign({ brightness: 1, decay: 1, gain: 1, pitch: 0 }, data.tone);
    if (data.reverb) state.reverb = Object.assign({ size: 1.6, mix: 0.18 }, data.reverb);
    return true;
  }

  $('#btn-save').addEventListener('click', function () {
    try {
      localStorage.setItem('bingStudio.slot' + $('#slot').value, JSON.stringify(serialize()));
      $('#transport-status').textContent = '已保存到槽位 ' + $('#slot').value;
    } catch (e) {
      $('#transport-status').textContent = '保存失败：' + e.message;
    }
  });

  $('#btn-load').addEventListener('click', function () {
    var raw = localStorage.getItem('bingStudio.slot' + $('#slot').value);
    if (!raw) { $('#transport-status').textContent = '槽位 ' + $('#slot').value + ' 是空的'; return; }
    if (!deserialize(JSON.parse(raw))) { $('#transport-status').textContent = '数据损坏'; return; }
    syncUIFromPattern();
    syncSliders();
    applyTone();
    buildGrid();
    $('#transport-status').textContent = '已读取槽位 ' + $('#slot').value;
  });

  $('#btn-export-json').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    A.downloadBlob(blob, 'bingbingbing-pattern.json');
  });

  /* ---------------- MIDI 导入 / 导出 ---------------- */

  function midiStatus(msg) { $('#transport-status').textContent = msg; }

  function collectNotesForMidi() {
    var p = state.pattern;
    var notes = [];
    p.tracks.forEach(function (tr, ti) {
      for (var s = 0; s < p.steps; s++) {
        if (!tr.cells[s]) continue;
        notes.push({
          step: s,
          midi: tr.midi,
          len: Math.max(1, Math.round(noteDur(p, ti, s))),
          vel: noteVel(p, ti, s)
        });
      }
    });
    return notes;
  }

  $('#btn-export-midi').addEventListener('click', function () {
    var notes = collectNotesForMidi();
    if (!notes.length) {
      midiStatus('网格是空的，先画点东西或自动编曲一下');
      return;
    }
    var bytes = window.BingMidi.encode(notes, { bpm: state.pattern.bpm, name: 'bingbingbing-studio' });
    A.downloadBlob(new Blob([bytes], { type: 'audio/midi' }),
      'bingbingbing-' + state.pattern.bpm + 'bpm-' + Date.now() + '.mid');
    midiStatus('已导出 MIDI：' + notes.length + ' 个音符 · ' + state.pattern.bpm + ' BPM（可拖进 DAW）');
  });

  $('#file-midi').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var res;
      try {
        res = window.BingMidi.decode(reader.result);
      } catch (e) {
        midiStatus('MIDI 解析失败：' + e.message);
        return;
      }
      if (!res.ok) {
        midiStatus('MIDI 解析失败：' + res.reason);
        return;
      }
      prepareMidi(res, file.name);
    };
    reader.readAsArrayBuffer(file);
  });

  /** 解析完先不导入，只做分析并定位到有音符的段落 */
  function prepareMidi(res, name) {
    var tickPerStep = res.ppq / 4;
    var notes = [];
    var maxStep = 0, minStep = Infinity;
    res.notes.forEach(function (n) {
      var step = Math.round(n.startTick / tickPerStep);
      if (step < 0) return;
      notes.push({
        step: step,
        midi: n.midi,
        len: Math.max(1, Math.round(n.durTick / tickPerStep)),
        vel: n.vel
      });
      if (step > maxStep) maxStep = step;
      if (step < minStep) minStep = step;
    });
    if (!notes.length) {
      midiStatus('这个 MIDI 里没有音符');
      return;
    }
    // 对齐到小节（16 格）起点，直接跳到第一段有音符的位置，免得看到一片空白
    var startGuess = Math.max(0, Math.floor(minStep / 16) * 16);
    state.midiParsed = {
      name: name,
      bpm: res.bpm || state.pattern.bpm,
      notes: notes,
      minStep: minStep,
      maxStep: maxStep,
      firstBar: startGuess
    };
    $('#midi-start').value = String(startGuess);
    if ($('#btn-midi-import')) $('#btn-midi-import').disabled = false;
    if ($('#btn-midi-next')) $('#btn-midi-next').disabled = false;
    var info = $('#midi-info');
    if (info) {
      info.innerHTML = '已读取 <b>' + name + '</b>：' + notes.length + ' 个音符 · ' + state.midiParsed.bpm +
        ' BPM · 全长 <b>' + (maxStep + 1) + ' 格</b>（1/16 格，约 ' +
        ((maxStep + 1) * 60 / state.midiParsed.bpm / 4).toFixed(0) + ' 秒）· 第一个音在第 ' +
        minStep + ' 格。<br>已自动跳到第 ' + startGuess + ' 格，点「导入这一段」即可；' +
        '想听后面就点「下一段 ▶」，或直接改起点格。' +
        '<span style="color:#8fb3cc">（音高会整段按八度移调，好落进 C4~C6 的 25 行里）</span>';
    }
    importMidiRegion();
  }

  function midiRegionLen() {
    var el = $('#midi-len');
    return el ? Math.max(16, Math.min(256, parseInt(el.value, 10) || 64)) : 64;
  }

  function importMidiRegion() {
    var mp = state.midiParsed;
    if (!mp) return;
    var startInput = $('#midi-start');
    var start = Math.max(0, parseInt(startInput && startInput.value, 10) || 0);
    var steps = midiRegionLen();
    var end = start + steps;

    // 段落音高的中位数 → 决定整体移调几个八度，让旋律落进卷帘中间
    var inRegion = mp.notes.filter(function (n) { return n.step >= start && n.step < end; });
    if (!inRegion.length) {
      // 这一段没音符，自动往后找一段有音符的
      var nextNote = null;
      for (var i = 0; i < mp.notes.length; i++) {
        if (mp.notes[i].step >= start) { nextNote = mp.notes[i]; break; }
      }
      if (nextNote) {
        start = Math.max(0, Math.floor(nextNote.step / 16) * 16);
        end = start + steps;
        inRegion = mp.notes.filter(function (n) { return n.step >= start && n.step < end; });
        if (startInput) startInput.value = String(start);
      }
      if (!inRegion.length) {
        midiStatus('这一段（第 ' + start + '~' + end + ' 格）没有音符，改一下起点格试试');
        return;
      }
    }
    // 「只要主旋律」：同一格里只留最高的那个音（MIDI 里通常还有伴奏和低音）
    var monoBox = $('#chk-midi-mono');
    if (monoBox && monoBox.checked) {
      var byStep = {};
      inRegion.forEach(function (n) {
        var k = n.step;
        if (!byStep[k] || n.midi > byStep[k].midi) byStep[k] = n;
      });
      inRegion = Object.keys(byStep).map(function (k) { return byStep[k]; });
    }

    // 段落音高的中位数 → 决定整体移调几个八度，让旋律落进卷帘中间
    var pitches = inRegion.map(function (n) { return n.midi; }).sort(function (a, b) { return a - b; });
    var median = pitches[pitches.length >> 1];
    var target = (ROW_LOW + ROW_HIGH) / 2;                       // 72
    var shift = 12 * Math.round((target - median) / 12);

    var p = state.pattern;
    p.bpm = mp.bpm;
    p.swing = 0;
    resizeCells(steps);
    clearRows(steps);

    var placed = 0;
    inRegion.forEach(function (n) {
      var step = n.step - start;
      if (step < 0 || step >= steps) return;
      var ri = rowIndex(n.midi + shift);
      var tr = p.tracks[ri];
      if (!tr) return;
      tr.cells[step] = true;
      if (n.len > 1) p.durs[noteKey(ri, step)] = Math.min(64, n.len);
      p.vels[noteKey(ri, step)] = Math.min(1.5, Math.max(0.05, n.vel));
      placed++;
    });
    syncUIFromPattern();
    buildGrid();
    if (grid.scrollIntoView) grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    midiStatus('已导入第 ' + start + '~' + (end - 1) + ' 格：' + placed + ' 个音符 · ' + p.bpm +
      ' BPM' + (shift ? ' · 整段移调 ' + (shift > 0 ? '+' : '') + shift + ' 半音（约 ' +
        (shift / 12 > 0 ? '+' : '') + (shift / 12) + ' 个八度）' : '') +
      ' · 共 ' + (mp.maxStep + 1) + ' 格');
    if ($('#chk-autoplay').checked) {
      stop();
      play();
    }
  }

  if ($('#btn-midi-import')) $('#btn-midi-import').addEventListener('click', importMidiRegion);
  if ($('#btn-midi-next')) {
    $('#btn-midi-next').addEventListener('click', function () {
      var startInput = $('#midi-start');
      var next = (parseInt(startInput.value, 10) || 0) + midiRegionLen();
      startInput.value = String(next);
      importMidiRegion();
    });
  }

  $('#file-json').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        if (deserialize(JSON.parse(reader.result))) {
          syncUIFromPattern();
          syncSliders();
          applyTone();
          buildGrid();
          $('#transport-status').textContent = '已导入：' + file.name;
        }
      } catch (e) {
        $('#transport-status').textContent = 'JSON 解析失败';
      }
    };
    reader.readAsText(file);
  });

  $('#btn-export-wav').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = '渲染中…';
    exportWav().then(function () {
      btn.textContent = old;
      btn.disabled = false;
    }).catch(function (err) {
      $('#transport-status').textContent = '导出失败：' + err.message;
      btn.textContent = old;
      btn.disabled = false;
    });
  });

  function exportWav() {
    var p = state.pattern;
    var sr = 44100;
    var stepDur = 60 / p.bpm / 4;
    var total = p.steps * stepDur + 2.4;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error('浏览器不支持 OfflineAudioContext'));
    var offline = new OAC(2, Math.ceil(total * sr), sr);

    var eng = new A.BingEngine();
    eng.init(offline);
    eng.setTone(state.tone);
    eng.setReverb(state.reverb.size, state.reverb.mix);
    if (state.soundSource === 'sample' && state.sampleBuffer) {
      eng.setSample(state.sampleBuffer, state.sampleName, state.sampleRoot,
        state.sampleBounds, state.sampleSegments, state.sampleMode);
      eng.setSampleBody(engine.sampleBody, engine.sampleBodyDur);
    }

    var soloed = p.tracks.some(function (t) { return t.solo; });
    for (var s = 0; s < p.steps; s++) {
      var when = 0.06 + s * stepDur + ((s % 2 === 1) ? p.swing * stepDur * 0.5 : 0);
      for (var ti = 0; ti < p.tracks.length; ti++) {
        var tr = p.tracks[ti];
        if (!tr.cells[s] || tr.muted || (soloed && !tr.solo)) continue;
        var vel = tr.gain * noteVel(p, ti, s);
        var lenSec = Math.max(1, noteDur(p, ti, s)) * stepDur;
        eng.playNote(tr.midi, when, vel, lenSec);
        if (lenSec >= stepDur * 8) {
          eng.playNote(tr.midi, when + lenSec * 0.5, vel * 0.42, lenSec * 0.5);
          eng.playNote(tr.midi, when + lenSec * 0.78, vel * 0.3, lenSec * 0.22);
        }
      }
    }

    return offline.startRendering().then(function (rendered) {
      A.downloadBlob(A.encodeWav(rendered), 'bingbingbing-' + Date.now() + '.wav');
      $('#transport-status').textContent = 'WAV 已导出（' + rendered.duration.toFixed(1) + 's）';
    });
  }

  /* ---------------- 初始化 ---------------- */

  // 采样根音下拉：列出全部半音，载入素材后会自动选中识别出来的那个音
  (function fillRootOptions() {
    var sel = $('#sample-root');
    if (!sel) return;
    var html = '';
    for (var m = 36; m <= 96; m++) html += '<option value="' + m + '">' + A.midiToName(m) + '</option>';
    sel.innerHTML = html;
    sel.value = String(state.sampleRoot);
  })();

  buildKeys();
  buildGrid();
  syncUIFromPattern();
  applyTone();
  setSource('synth');
  loadEmbeddedSample();

  // 调试句柄：控制台里可以直接查看/修改状态，例如 BING_STUDIO.state.sampleMode
  window.BING_STUDIO = { engine: engine, state: state, analyzeSample: analyzeSample };
})();