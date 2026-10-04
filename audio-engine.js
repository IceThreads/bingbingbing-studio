/*
 * 冰冰冰音频引擎
 * - 合成“冰”音色（音高包络 + 泛音 + 冰裂噪声瞬间 + 双共振峰）
 * - 采样音源：可载入真实的 冰冰冰.wav，按音高变调播放
 * - 程序生成混响 + 总线压缩
 * - WAV 编码（44.1kHz / 16bit / 立体声）
 * 经典脚本，直接 <script> 引入即可，暴露 window.BingAudio
 */
(function (global) {
  'use strict';

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function midiToName(midi) {
    var m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function createImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }

  function createNoise(ctx, seconds) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(1, len, rate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ---------------- 引擎 ---------------- */

  function BingEngine() {
    this.ctx = null;
    this.sampleBuffer = null;
    this.sampleName = '';
    this.sampleRoot = 60;              // 采样根音（原素材对应的音高）
    this.sampleBounds = null;          // 裁掉前后静音后的区间
    this.sampleSegments = null;        // 每个“冰”字的区间
    this.sampleMode = 'single';        // single = 只发第一个“冰”；whole = 整段“冰冰冰”
    this.sampleBody = 0.35;            // 音高感：叠一层按音符频率衰减的正弦体，让旋律听得清
    this.sampleBodyDur = 0.5;          // 这层体的衰减时间（秒）
    this.tone = { brightness: 1, decay: 1, gain: 1, pitch: 0 };
    this.reverb = { size: 1.6, mix: 0.18 };
    this._noise = null;
  }

  BingEngine.prototype.init = function (ctx) {
    if (this.ctx) return this.ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    ctx = ctx || new AC();

    var master = ctx.createGain();
    master.gain.value = 0.9;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 14;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    master.connect(comp);
    comp.connect(ctx.destination);

    var bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(master);

    var conv = ctx.createConvolver();
    conv.buffer = createImpulse(ctx, this.reverb.size, 3);
    var wet = ctx.createGain();
    wet.gain.value = this.reverb.mix;
    bus.connect(conv);
    conv.connect(wet);
    wet.connect(master);

    this.ctx = ctx;
    this.master = master;
    this.comp = comp;
    this.bus = bus;
    this.conv = conv;
    this.wet = wet;
    this._noise = createNoise(ctx, 0.4);
    return ctx;
  };

  BingEngine.prototype.now = function () {
    return this.ctx ? this.ctx.currentTime : 0;
  };

  BingEngine.prototype.setTone = function (tone) {
    if (!tone) return;
    for (var k in tone) if (Object.prototype.hasOwnProperty.call(tone, k)) this.tone[k] = tone[k];
  };

  BingEngine.prototype.setReverb = function (size, mix) {
    if (typeof size === 'number') this.reverb.size = size;
    if (typeof mix === 'number') {
      this.reverb.mix = mix;
      if (this.wet) this.wet.gain.value = mix;
    }
    if (this.conv) this.conv.buffer = createImpulse(this.ctx, this.reverb.size, 3);
  };

  /**
   * @param buffer    AudioBuffer
   * @param name      显示名
   * @param root      采样根音 MIDI
   * @param bounds    {start,end} 裁掉前后静音后的区间（秒）
   * @param segments  [[start,end], ...] 每个“冰”字的区间（秒）
   * @param mode      'single' 只发第一个“冰”（琴键手感）/ 'whole' 整段“冰冰冰”
   */
  BingEngine.prototype.setSample = function (buffer, name, root, bounds, segments, mode) {
    this.sampleBuffer = buffer || null;
    this.sampleName = name || '';
    if (typeof root === 'number') this.sampleRoot = root;
    this.sampleBounds = bounds || null;
    this.sampleSegments = segments || null;
    if (mode) this.sampleMode = mode;
  };

  BingEngine.prototype.clearSample = function () {
    this.sampleBuffer = null;
    this.sampleName = '';
    this.sampleBounds = null;
    this.sampleSegments = null;
  };

  BingEngine.prototype._sampleRange = function () {
    if (!this.sampleBuffer) return null;
    if (this.sampleMode === 'single' && this.sampleSegments && this.sampleSegments.length) {
      var seg = this.sampleSegments[0];
      return { start: Math.max(0, seg[0] - 0.004), end: Math.min(this.sampleBuffer.duration, seg[1]) };
    }
    if (this.sampleBounds) return this.sampleBounds;
    return { start: 0, end: this.sampleBuffer.duration };
  };

  /**
   * 播放一个“冰”
   * @param bodyDur 这个音的时值（秒）。给了就让“音高感”那层体跟着音符长度走，
   *                长音听起来才是真的长音，而不是全都一样长的短促一击。
   */
  BingEngine.prototype.playNote = function (midi, when, velocity, bodyDur) {
    if (!this.ctx) return;
    var t = Math.max(when || 0, this.ctx.currentTime);
    var vel = clamp(typeof velocity === 'number' ? velocity : 0.85, 0, 2);
    if (vel <= 0) return;
    if (this.sampleBuffer) this._playSample(midi, t, vel, bodyDur);
    else this._playSynth(midi, t, vel, bodyDur);
  };

  BingEngine.prototype.setSampleBody = function (amount, dur) {
    if (typeof amount === 'number') this.sampleBody = clamp(amount, 0, 1.5);
    if (typeof dur === 'number') this.sampleBodyDur = clamp(dur, 0.1, 2);
  };

  BingEngine.prototype._playSample = function (midi, when, velocity, bodyDur) {
    var rate = clamp(Math.pow(2, (midi + this.tone.pitch - this.sampleRoot) / 12), 0.25, 4);
    var gain = clamp(0.9 * velocity * this.tone.gain, 0, 2);
    var range = this._sampleRange();
    if (!range) return;
    this._playRange(range.start, range.end, rate, gain, when);
    // 素材本身很短（“冰”只有一百多毫秒），单靠它音高感太弱、旋律听不出来。
    // 叠一层按音符频率衰减的正弦体补上音高与余韵，仍保留冰块撞击的质感。
    if (this.sampleBody > 0) {
      var dur = this.sampleBodyDur;
      if (typeof bodyDur === 'number' && bodyDur > 0) {
        dur = clamp(bodyDur, 0.15, 6);
      }
      this._playBody(midiToFreq(midi + this.tone.pitch), gain * this.sampleBody * 0.5, when, dur);
    }
  };

  /** 音高体：基频 + 二次泛音，指数衰减，让短促的“冰”有明确音高和尾巴 */
  BingEngine.prototype._playBody = function (freq, amp, when, durOverride) {
    var ctx = this.ctx;
    var dur = typeof durOverride === 'number' ? durOverride : this.sampleBodyDur;
    var out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), when + 0.01);
    if (dur > 0.25) {
      // 长音：起音后“按住”到 70%，最后 30% 再收尾。
      // 直接用一条指数衰减到底的话，音符前三分之一就没声了，长音听起来还是短音。
      var hold = Math.max(0.0002, amp * 0.62);
      out.gain.exponentialRampToValueAtTime(hold, when + Math.min(0.12, dur * 0.2));
      out.gain.setValueAtTime(hold, when + dur * 0.7);
      out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    } else {
      out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    }
    out.connect(this.bus);

    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var g1 = ctx.createGain();
    g1.gain.value = 0.75;
    osc.connect(g1);
    g1.connect(out);

    var osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2.01;
    var g2 = ctx.createGain();
    g2.gain.value = 0.22;
    osc2.connect(g2);
    g2.connect(out);

    var stop = when + dur + 0.05;
    osc.start(when); osc2.start(when);
    osc.stop(stop); osc2.stop(stop);
  };

  BingEngine.prototype._playRange = function (start, end, rate, gain, when) {
    var src = this.ctx.createBufferSource();
    src.buffer = this.sampleBuffer;
    src.playbackRate.value = rate;
    var g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.bus);
    src.start(when, Math.max(0, start), Math.max(0.02, end - start));
  };

  /** 原样播放整段素材（含前后静音），用于“试听原素材” */
  BingEngine.prototype.playRawSample = function (when, velocity) {
    if (!this.ctx || !this.sampleBuffer) return;
    var t = Math.max(when || 0, this.ctx.currentTime);
    this._playRange(0, this.sampleBuffer.duration, 1,
      clamp(0.9 * (velocity || 0.9) * this.tone.gain, 0, 2), t);
  };

  BingEngine.prototype._playSynth = function (midi, when, velocity, bodyDur) {
    var ctx = this.ctx;
    var tone = this.tone;
    var f = midiToFreq(midi + tone.pitch);
    var dur = 0.34 * tone.decay;
    if (typeof bodyDur === 'number' && bodyDur > 0) {
      // 合成冰音本身有音高，直接按音符时值延长衰减即可
      dur = Math.max(dur, clamp(bodyDur * 0.9, 0.1, 6));
    }
    var bright = clamp(tone.brightness, 0.2, 2.2);
    var peak = clamp(0.5 * velocity * tone.gain, 0.0002, 2);

    // 输出 + 共振峰（“冰”字的发音感）
    var out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(peak, when + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 160;

    var f1 = ctx.createBiquadFilter();
    f1.type = 'peaking';
    f1.frequency.value = 820;
    f1.Q.value = 4.5;
    f1.gain.value = 7 * bright;

    var f2 = ctx.createBiquadFilter();
    f2.type = 'peaking';
    f2.frequency.value = 2350;
    f2.Q.value = 6;
    f2.gain.value = 6 * bright;

    out.connect(hp);
    hp.connect(f1);
    f1.connect(f2);
    f2.connect(this.bus);

    // 主体：下滑音头的三角波
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f * 1.55, when);
    osc.frequency.exponentialRampToValueAtTime(f, when + 0.05);
    var og = ctx.createGain();
    og.gain.value = 0.8;
    osc.connect(og);
    og.connect(out);

    // 泛音层：一点点“叮”的金属感
    var osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(f * 3.02, when);
    osc2.frequency.exponentialRampToValueAtTime(f * 2.01, when + 0.045);
    var og2 = ctx.createGain();
    og2.gain.value = 0.28 * bright;
    osc2.connect(og2);
    og2.connect(out);

    // 冰裂瞬间：短噪声
    var noise = ctx.createBufferSource();
    noise.buffer = this._noise || createNoise(ctx, 0.4);
    var nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 4200;
    nf.Q.value = 1.1;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(clamp(0.26 * velocity * bright, 0.0001, 1), when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
    noise.connect(nf);
    nf.connect(ng);
    ng.connect(out);

    var stop = when + dur + 0.06;
    osc.start(when); osc2.start(when); noise.start(when);
    osc.stop(stop); osc2.stop(stop); noise.stop(stop);
  };

  /** 节拍器“嘀” */
  BingEngine.prototype.click = function (when, accent) {
    if (!this.ctx || !this.master) return;
    var when2 = Math.max(when || 0, this.ctx.currentTime);
    var osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1650 : 1120;
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when2);
    g.gain.exponentialRampToValueAtTime(accent ? 0.1 : 0.05, when2 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when2 + 0.05);
    osc.connect(g);
    g.connect(this.master);
    osc.start(when2);
    osc.stop(when2 + 0.08);
  };

  /* ---------------- WAV 编码 ---------------- */

  function encodeWav(buffer) {
    var numCh = buffer.numberOfChannels;
    var len = buffer.length;
    var dataBytes = len * numCh * 2;
    var ab = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(ab);
    var off = 0;

    function str(s) { for (var i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); }
    function u32(v) { view.setUint32(off, v, true); off += 4; }
    function u16(v) { view.setUint16(off, v, true); off += 2; }

    str('RIFF'); u32(36 + dataBytes); str('WAVE');
    str('fmt '); u32(16); u16(1); u16(numCh);
    u32(buffer.sampleRate); u32(buffer.sampleRate * numCh * 2); u16(numCh * 2); u16(16);
    str('data'); u32(dataBytes);

    var chans = [];
    for (var c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    for (var i = 0; i < len; i++) {
      for (var ch = 0; ch < numCh; ch++) {
        var s = clamp(chans[ch][i], -1, 1);
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /** blob 下载 */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  global.BingAudio = {
    BingEngine: BingEngine,
    midiToFreq: midiToFreq,
    midiToName: midiToName,
    encodeWav: encodeWav,
    downloadBlob: downloadBlob,
    clamp: clamp
  };
})(window);
