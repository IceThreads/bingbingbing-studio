/*
 * 标准 MIDI 文件（SMF）编解码
 * 只做音符相关的最小子集：tempo、note on/off、时值、力度。
 * 编码：format 0（单轨），480 ticks/四分音符
 * 解码：支持 format 0/1，带 running status，多轨合并
 * 经典脚本，暴露 window.BingMidi（Node 下也能通过 vm 加载测试）
 */
(function (global) {
  'use strict';

  var PPQ = 480;   // ticks per quarter note

  /* ---------------- 编码 ---------------- */

  function writeVarLen(bytes, value) {
    var buf = [value & 0x7F];
    value >>= 7;
    while (value > 0) {
      buf.unshift((value & 0x7F) | 0x80);
      value >>= 7;
    }
    for (var i = 0; i < buf.length; i++) bytes.push(buf[i]);
  }

  function pushStr(bytes, str) {
    for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xFF);
  }

  function pushU32(bytes, v) {
    bytes.push((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
  }

  function pushU16(bytes, v) {
    bytes.push((v >> 8) & 0xFF, v & 0xFF);
  }

  /**
   * @param notes [{ startTick, durTick, midi, vel }] vel 0~1
   * @param opts  { bpm, name }
   * @returns Uint8Array
   */
  function encode(notes, opts) {
    var o = opts || {};
    var bpm = o.bpm || 120;
    var ticksPerStep = PPQ / 4;

    var evts = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var start = n.startTick !== undefined ? n.startTick : Math.round(n.step * ticksPerStep);
      var dur = n.durTick !== undefined ? n.durTick : Math.round(Math.max(1, n.len || 1) * ticksPerStep);
      var vel = Math.max(1, Math.min(127, Math.round((n.vel === undefined ? 0.85 : n.vel) * 127)));
      var midi = Math.max(0, Math.min(127, Math.round(n.midi)));
      evts.push({ tick: start, off: false, midi: midi, vel: vel });
      evts.push({ tick: start + Math.max(1, dur), off: true, midi: midi, vel: 0 });
    }
    // 同一 tick 先关后开，避免叠音
    evts.sort(function (a, b) {
      if (a.tick !== b.tick) return a.tick - b.tick;
      if (a.off !== b.off) return a.off ? -1 : 1;
      return a.midi - b.midi;
    });

    var track = [];
    var microPerQuarter = Math.round(60000000 / bpm);
    // tempo meta
    writeVarLen(track, 0);
    track.push(0xFF, 0x51, 0x03,
      (microPerQuarter >> 16) & 0xFF, (microPerQuarter >> 8) & 0xFF, microPerQuarter & 0xFF);
    // 拍号 4/4
    writeVarLen(track, 0);
    track.push(0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
    // 曲名
    if (o.name) {
      var nameBytes = [];
      for (var c = 0; c < o.name.length; c++) nameBytes.push(o.name.charCodeAt(c) & 0xFF);
      writeVarLen(track, 0);
      track.push(0xFF, 0x03, nameBytes.length);
      for (c = 0; c < nameBytes.length; c++) track.push(nameBytes[c]);
    }

    var last = 0;
    for (i = 0; i < evts.length; i++) {
      var e = evts[i];
      writeVarLen(track, Math.max(0, e.tick - last));
      last = e.tick;
      if (e.off) track.push(0x80, e.midi, 0x40);
      else track.push(0x90, e.midi, e.vel);
    }
    // end of track
    writeVarLen(track, 0);
    track.push(0xFF, 0x2F, 0x00);

    var out = [];
    pushStr(out, 'MThd');
    pushU32(out, 6);
    pushU16(out, 0);        // format 0
    pushU16(out, 1);        // 单轨
    pushU16(out, PPQ);
    pushStr(out, 'MTrk');
    pushU32(out, track.length);
    for (i = 0; i < track.length; i++) out.push(track[i]);
    return new Uint8Array(out);
  }

  /* ---------------- 解码 ---------------- */

  function readVarLen(data, pos) {
    var value = 0, b;
    do {
      b = data[pos++];
      value = (value << 7) | (b & 0x7F);
    } while (b & 0x80);
    return { value: value, pos: pos };
  }

  /**
   * @returns { ok, ppq, bpm, notes:[{startTick,durTick,midi,vel}], reason? }
   */
  function decode(arrayBuffer) {
    var data = new Uint8Array(arrayBuffer);
    if (data.length < 14) return { ok: false, reason: '文件太短，不是 MIDI' };
    if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'MThd') {
      return { ok: false, reason: '不是标准 MIDI 文件（缺少 MThd）' };
    }
    var pos = 4;
    var headerLen = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
    var format = (data[8] << 8) | data[9];
    var nTracks = (data[10] << 8) | data[11];
    var division = (data[12] << 8) | data[13];
    if (division & 0x8000) return { ok: false, reason: '暂不支持 SMPTE 时间格式的 MIDI' };
    pos = 8 + headerLen;

    var bpm = 0;
    var notes = [];
    var active = {};   // key "ch:midi" -> {startTick, vel}

    for (var t = 0; t < nTracks && pos + 8 <= data.length; t++) {
      if (String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]) !== 'MTrk') break;
      var len = (data[pos + 4] << 24) | (data[pos + 5] << 16) | (data[pos + 6] << 8) | data[pos + 7];
      var end = pos + 8 + len;
      var p = pos + 8;
      var tick = 0;
      var running = 0;

      while (p < end) {
        var vl = readVarLen(data, p);
        tick += vl.value;
        p = vl.pos;
        var status = data[p];
        if (status & 0x80) {
          // meta / sysex 不能作为 running status 继续沿用（规范如此，
          // 但很多文件仍在 meta 之后用 running status，所以这里只记通道消息）
          if (status < 0xF0) running = status;
          p++;
        } else {
          status = running;   // running status
        }
        var type = status & 0xF0;

        if (status === 0xFF) {
          var metaType = data[p++];
          var ml = readVarLen(data, p);
          p = ml.pos;
          if (metaType === 0x51 && ml.value >= 3) {
            var us = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
            if (us > 0) bpm = Math.round(60000000 / us);
          }
          p += ml.value;
        } else if (status === 0xF0 || status === 0xF7) {
          var sl = readVarLen(data, p);
          p = sl.pos + sl.value;
        } else if (type === 0x90 || type === 0x80) {
          var note = data[p++];
          var vel = data[p++];
          var key = (status & 0x0F) + ':' + note;
          if (type === 0x90 && vel > 0) {
            active[key] = { startTick: tick, vel: vel };
          } else if (active[key]) {
            notes.push({
              startTick: active[key].startTick,
              durTick: Math.max(1, tick - active[key].startTick),
              midi: note,
              vel: active[key].vel / 127
            });
            delete active[key];
          }
        } else if (type === 0xC0 || type === 0xD0) {
          p += 1;
        } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) {
          p += 2;
        } else {
          // 无法识别的状态，停下以免死循环
          p++;
        }
      }
      pos = end;
    }

    // 没收尾的音符给个默认长度
    Object.keys(active).forEach(function (k) {
      var a = active[k];
      notes.push({
        startTick: a.startTick, durTick: 120,
        midi: parseInt(k.split(':')[1], 10), vel: a.vel / 127
      });
    });

    notes.sort(function (a, b) { return a.startTick - b.startTick || a.midi - b.midi; });
    return { ok: true, ppq: division, bpm: bpm || 120, notes: notes, format: format };
  }

  global.BingMidi = {
    encode: encode,
    decode: decode,
    PPQ: PPQ
  };
})(typeof window !== 'undefined' ? window : globalThis);
