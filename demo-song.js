/*
 * 内置示例曲：用代码现场合成一首 100 BPM 的小曲（鼓组 + 贝斯 + 和弦 + 主旋律）
 * 用途：不需要任何文件，点一下就能验证「导入音乐 → 自动编曲」整条链路。
 * 经典脚本，暴露 window.BingDemoSong
 */
(function (global) {
  'use strict';

  function mulberry(seed) {
    var a = seed;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  /**
   * @param ctx    AudioContext（用来建 AudioBuffer）
   * @param opts   { bpm, seconds, sampleRate }
   * @returns AudioBuffer
   */
  function create(ctx, opts) {
    var o = opts || {};
    var bpm = o.bpm || 100;
    var seconds = o.seconds || 8;
    var sr = o.sampleRate || 22050;
    var n = Math.round(sr * seconds);
    var buf = ctx.createBuffer(1, n, sr);
    var data = buf.getChannelData(0);
    var rnd = mulberry(12345);
    var beat = 60 / bpm;

    function add(startSec, samples, gain) {
      var i0 = Math.round(startSec * sr);
      var g = gain === undefined ? 1 : gain;
      for (var k = 0; k < samples.length; k++) {
        var idx = i0 + k;
        if (idx >= 0 && idx < n) data[idx] += samples[k] * g;
      }
    }

    function kick() {
      var len = Math.round(0.16 * sr), out = new Float32Array(len);
      for (var k = 0; k < len; k++) {
        var t = k / sr;
        out[k] = 0.75 * Math.sin(2 * Math.PI * (58 - 20 * t) * t) * Math.exp(-t * 16);
      }
      return out;
    }

    function snare() {
      var len = Math.round(0.14 * sr), out = new Float32Array(len);
      for (var k = 0; k < len; k++) {
        var t = k / sr;
        out[k] = (0.35 * (rnd() * 2 - 1) + 0.2 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 26);
      }
      return out;
    }

    function hat(open) {
      var d = open ? 0.09 : 0.03;
      var len = Math.round(0.12 * sr), out = new Float32Array(len);
      for (var k = 0; k < len; k++) {
        out[k] = 0.16 * (rnd() * 2 - 1) * Math.exp(-(k / sr) / d);
      }
      return out;
    }

    function tone(freq, dur, gain, harm) {
      var hs = harm || [1, 0.35, 0.15];
      var len = Math.round(dur * sr), out = new Float32Array(len), sum = 0;
      for (var h = 0; h < hs.length; h++) sum += hs[h];
      for (var k = 0; k < len; k++) {
        var t = k / sr;
        var env = Math.min(1, t / 0.008) * Math.exp(-t * 3.2);
        var v = 0;
        for (h = 0; h < hs.length; h++) {
          v += hs[h] * Math.sin(2 * Math.PI * freq * (h + 1) * t);
        }
        out[k] = gain * env * v / sum;
      }
      return out;
    }

    var chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    var melody = [72, 74, 76, 74, 69, 72, 74, 72, 67, 69, 72, 69, 71, 74, 76, 74];
    var bars = Math.ceil(seconds / (beat * 4));

    for (var bar = 0; bar < bars; bar++) {
      var base = bar * 4 * beat;
      var ch = chords[bar % 4];
      for (var b = 0; b < 4; b++) {
        var t = base + b * beat;
        if (t >= seconds) break;
        if (b === 0 || b === 2) add(t, kick());
        if (b === 1 || b === 3) add(t, snare());
        add(t + beat / 2, hat(b === 3), 0.8);
        if (b === 3) add(t + beat * 0.75, hat(true), 0.7);
        add(t, tone(midiToFreq(ch[0] - 12), beat * 0.85, 0.24, [1, 0.2]));
        if (b < 2) {
          for (var m = 0; m < ch.length; m++) {
            // 和弦垫刻意压得很轻：让主旋律成为最突出的声部
            add(t, tone(midiToFreq(ch[m]), beat * 1.6, 0.02, [1, 0.3, 0.1]));
          }
        }
        var note = melody[(bar * 4 + b) % melody.length];
        add(t, tone(midiToFreq(note), beat * 0.6, 0.45, [1, 0.4, 0.2]));
      }
    }

    // 归一化到 0.92
    var peak = 1e-9;
    for (var i = 0; i < n; i++) {
      var a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    var k2 = 0.92 / peak;
    for (i = 0; i < n; i++) data[i] *= k2;

    return buf;
  }

  global.BingDemoSong = { create: create, midiToFreq: midiToFreq };
})(window);
