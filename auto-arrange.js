/*
 * 自动编曲：把任意歌曲变成冰冰冰网格
 *
 * 流程：
 *   1. 多声道混单声道 + 线性重采样到 22050Hz
 *   2. 短时傅里叶变换（1024 点 / hop 256）算谱通量 → 起音包络
 *   3. 自适应阈值 + 峰值挑选 → 节奏点（起音）
 *   4. 起音包络自相关 + 梳状加权 + 120BPM 对数正态先验 → 速度
 *   5. 每个节奏点做归一化自相关（含抗混叠降采样）→ 基频 → MIDI
 *   6. 按音阶吸附、按音高聚成最多 8 条轨道、量化到 1/16 格
 *
 * 纯计算，不依赖 Web Audio 节点，经典脚本，暴露 window.BingAutoArrange
 */
(function (global) {
  'use strict';

  var ANALYSIS_RATE = 22050;   // 分析采样率
  var FFT_SIZE = 1024;         // 46ms 窗
  var HOP = 256;               // 11.6ms 步进
  var PITCH_RATE = 5512;       // 音高分析采样率（22050 / 4）

  var SCALES = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9]
  };

  /* ---------------- 基础工具 ---------------- */

  function mixdownMono(buffer, targetRate) {
    var chs = buffer.numberOfChannels;
    var srcRate = buffer.sampleRate;
    var srcLen = buffer.length;
    var ratio = targetRate / srcRate;
    var outLen = Math.max(1, Math.floor(srcLen * ratio));
    var out = new Float32Array(outLen);
    var chans = [];
    for (var c = 0; c < chs; c++) chans.push(buffer.getChannelData(c));
    for (var i = 0; i < outLen; i++) {
      var pos = i / ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(srcLen - 1, i0 + 1);
      var frac = pos - i0;
      var s = 0;
      for (var k = 0; k < chs; k++) {
        var d = chans[k];
        s += d[i0] * (1 - frac) + d[i1] * frac;
      }
      out[i] = s / chs;
    }
    return out;
  }

  /** 原地迭代基 2 FFT */
  function fft(re, im) {
    var n = re.length;
    var i, j, bit, t;
    for (i = 1, j = 0; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        var half = len >> 1;
        for (var k = 0; k < half; k++) {
          var ur = re[i + k], ui = im[i + k];
          var xr = re[i + k + half], xi = im[i + k + half];
          var vr = xr * cr - xi * ci;
          var vi = xr * ci + xi * cr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + half] = ur - vr;
          im[i + k + half] = ui - vi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  /**
   * 谱通量起音包络
   * 顺带统计每帧的“低频占比”，用来判断这个起音更像鼓点还是乐音
   */
  function spectralFlux(x, sr) {
    var hann = new Float32Array(FFT_SIZE);
    for (var i = 0; i < FFT_SIZE; i++) {
      hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
    }
    var nFrames = Math.max(1, Math.floor((x.length - FFT_SIZE) / HOP) + 1);
    var bins = FFT_SIZE >> 1;
    var flux = new Float32Array(nFrames);
    var lowRatio = new Float32Array(nFrames);
    var centroid = new Float32Array(nFrames);
    var energy = new Float32Array(nFrames);
    var re = new Float64Array(FFT_SIZE);
    var im = new Float64Array(FFT_SIZE);
    var prev = new Float64Array(bins);
    var binHz = sr / FFT_SIZE;
    var lowBin = Math.max(1, Math.round(250 / binHz));

    for (var f = 0; f < nFrames; f++) {
      var off = f * HOP;
      for (var n = 0; n < FFT_SIZE; n++) {
        re[n] = x[off + n] * hann[n];
        im[n] = 0;
      }
      fft(re, im);
      var sum = 0, lowE = 0, totalE = 0, weighted = 0;
      for (var k = 0; k < bins; k++) {
        var mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        var d = mag - prev[k];
        if (d > 0) sum += d;
        prev[k] = mag;
        var e = mag * mag;
        totalE += e;
        weighted += e * k * binHz;
        if (k < lowBin) lowE += e;
      }
      flux[f] = sum;
      lowRatio[f] = totalE > 0 ? lowE / totalE : 0;
      centroid[f] = totalE > 0 ? weighted / totalE : 0;
      energy[f] = Math.sqrt(totalE / bins);
    }
    // 对数压缩，压制超强鼓点
    var maxF = 0;
    for (i = 0; i < nFrames; i++) { if (flux[i] > maxF) maxF = flux[i]; }
    if (maxF > 0) {
      var c = 40 / maxF;
      for (i = 0; i < nFrames; i++) flux[i] = Math.log(1 + flux[i] * c);
      var m2 = 0;
      for (i = 0; i < nFrames; i++) { if (flux[i] > m2) m2 = flux[i]; }
      if (m2 > 0) for (i = 0; i < nFrames; i++) flux[i] /= m2;
    }
    return {
      flux: flux, nFrames: nFrames, fps: sr / HOP,
      lowRatio: lowRatio, centroid: centroid, energy: energy
    };
  }

  /** 自适应阈值挑峰 */
  function pickOnsets(flux, fps, sensitivity) {
    var n = flux.length;
    var win = Math.max(2, Math.round(fps * 0.15));
    var onsets = [];
    var minGap = Math.max(1, Math.round(fps * 0.055));
    var delta = 0.012;
    var lastIdx = -1e9;

    for (var i = 0; i < n; i++) {
      // 只取局部峰（首尾帧用 -1 占位，这样开头第一拍也不会漏）
      var left = i > 0 ? flux[i - 1] : -1;
      var right = i < n - 1 ? flux[i + 1] : -1;
      if (flux[i] < left || flux[i] < right) continue;
      var lo = Math.max(0, i - win), hi = Math.min(n, i + win + 1);
      var sum = 0, sum2 = 0, cnt = 0;
      for (var j = lo; j < hi; j++) { sum += flux[j]; sum2 += flux[j] * flux[j]; cnt++; }
      var mean = sum / cnt;
      var std = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
      var thr = mean + sensitivity * std + delta;
      if (flux[i] <= thr) continue;
      if (i - lastIdx < minGap) {
        if (onsets.length && flux[i] > onsets[onsets.length - 1].strength) {
          onsets[onsets.length - 1] = { frame: i, time: i / fps, strength: flux[i] };
          lastIdx = i;
        }
        continue;
      }
      onsets.push({ frame: i, time: i / fps, strength: flux[i] });
      lastIdx = i;
    }
    // 起音包络峰值经常滞后几毫秒，往前微调 8ms 更贴合听感
    for (i = 0; i < onsets.length; i++) onsets[i].time = Math.max(0, onsets[i].time - 0.008);
    return onsets;
  }

  /** 自相关 + 梳状加权 + 先验 选速度 */
  function detectTempo(flux, fps) {
    var n = flux.length;
    var mean = 0;
    for (var i = 0; i < n; i++) mean += flux[i];
    mean /= Math.max(1, n);

    var minLag = Math.max(2, Math.floor(fps * 60 / 220));
    var maxLag = Math.min(n - 2, Math.floor(fps * 60 / 50));
    if (maxLag <= minLag) return 120;

    var ac = new Float32Array(maxLag + 1);
    for (var lag = minLag; lag <= maxLag; lag++) {
      var s = 0, cnt = n - lag;
      for (i = 0; i + lag < n; i++) s += (flux[i] - mean) * (flux[i + lag] - mean);
      ac[lag] = cnt > 0 ? s / cnt : 0;
    }

    var bestLag = minLag, bestScore = -Infinity;
    for (lag = minLag; lag <= maxLag; lag++) {
      var score = ac[lag];
      for (var m = 2; m <= 4; m++) {
        if (lag * m <= maxLag) score += ac[lag * m] * 0.5;
      }
      var bpm = 60 * fps / lag;
      var prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
      score *= prior;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }

    var out = 60 * fps / bestLag;
    while (out < 70) out *= 2;
    while (out > 180) out /= 2;
    return Math.round(out);
  }

  /**
   * 生成音高分析信号：先去低频（滑动均值相减 ≈ 一阶高通，压掉底鼓/贝斯），
   * 再抽取到目标采样率（顺带做了抗混叠的盒式平均）。
   */
  function pitchSignal(x, srcRate, dstRate) {
    var factor = Math.max(1, Math.round(srcRate / dstRate));
    var avgWin = Math.max(2, Math.round(srcRate / 220));   // 平均窗 ≈ 220Hz 周期
    var prefix = new Float64Array(x.length + 1);
    for (var i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i];
    var outLen = Math.floor(x.length / factor);
    var out = new Float32Array(outLen);
    for (var o = 0; o < outLen; o++) {
      var s = 0;
      var base = o * factor;
      for (var k = 0; k < factor; k++) {
        var idx = base + k;
        var lo = Math.max(0, idx - avgWin);
        var hi = Math.min(x.length, idx + avgWin + 1);
        var mean = (prefix[hi] - prefix[lo]) / (hi - lo);
        s += x[idx] - mean;
      }
      out[o] = s / factor;
    }
    return out;
  }

  /** 归一化自相关求基频（取第一个足够强的峰，避免低八度错误） */
  function estimateF0(x, sr, fromSample, lenSample) {
    var len = Math.min(lenSample, x.length - fromSample);
    if (len < sr * 0.02) return 0;
    var buf = new Float32Array(len);
    var mean = 0;
    for (var i = 0; i < len; i++) { buf[i] = x[fromSample + i]; mean += buf[i]; }
    mean /= len;
    for (i = 0; i < len; i++) buf[i] -= mean;
    // 二次滑动平均，压掉高频谐波
    for (var pass = 0; pass < 2; pass++) {
      var prev = buf[0];
      for (i = 1; i < len; i++) {
        var cur = buf[i];
        buf[i] = 0.5 * (cur + prev);
        prev = cur;
      }
    }

    var minLag = Math.max(2, Math.floor(sr / 900));
    var maxLag = Math.min(len - 2, Math.floor(sr / 70));
    if (maxLag <= minLag + 1) return { f0: 0, clarity: 0 };

    var vals = new Float32Array(maxLag + 1);
    var peak = 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var s = 0, e1 = 0, e2 = 0, cnt = len - lag;
      for (i = 0; i < cnt; i++) {
        var a = buf[i], b = buf[i + lag];
        s += a * b; e1 += a * a; e2 += b * b;
      }
      var v = s / (Math.sqrt(e1 * e2) + 1e-9);
      vals[lag] = v;
      if (v > peak) peak = v;
    }
    if (peak < 0.25) return { f0: 0, clarity: 0 };
    // 第一个 >= 0.86 * 全局峰 的局部峰
    for (lag = minLag + 1; lag < maxLag; lag++) {
      if (vals[lag] >= vals[lag - 1] && vals[lag] > vals[lag + 1] && vals[lag] >= peak * 0.86) {
        // 抛物线插值
        var y0 = vals[lag - 1], y1 = vals[lag], y2 = vals[lag + 1];
        var denom = (y0 - 2 * y1 + y2);
        var off = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
        return { f0: sr / (lag + off), clarity: vals[lag] };
      }
    }
    return { f0: 0, clarity: 0 };
  }

  function freqToMidi(f) {
    return 69 + 12 * Math.log(f / 440) / Math.LN2;
  }

  /** 把音高折进一个可用音域（默认 C4~C6），避免整首歌落在贝斯音区 */
  function foldToRange(midi, lo, hi) {
    var v = midi;
    while (v < lo) v += 12;
    while (v > hi) v -= 12;
    return v;
  }

  var PITCH_FFT = 4096;

  /**
   * 频域求主旋律基频（谐波求和 HPS）
   *   - 只在 200Hz 以上找：贝斯/底鼓的基频直接落在搜索范围之外，不再被当成旋律
   *   - 谐波加权求和，再在“分数接近最高”的候选里取最高音：符合“主旋律通常是最高声部”的常识
   *   - 返回 clarity = 该基频解释了多少频段能量，用来判断这段是不是乐音
   */
  function estimateF0Spectral(x, sr, fromSample, lenSample) {
    var avail = Math.min(lenSample, x.length - fromSample);
    if (avail < sr * 0.04) return { f0: 0, clarity: 0 };
    var N = PITCH_FFT;
    while (N > 512 && N > avail) N >>= 1;
    if (N < 512) return { f0: 0, clarity: 0 };

    var re = new Float64Array(N);
    var im = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      var v = i < avail ? x[fromSample + i] : 0;
      re[i] = v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);

    var bins = N >> 1;
    var binHz = sr / N;
    var mag = new Float64Array(bins);
    for (var k = 0; k < bins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);

    var loBin = Math.max(2, Math.round(200 / binHz));
    var hiBin = Math.min(bins - 2, Math.round(1200 / binHz));
    var magAt = function (kh) {
      if (kh < 1 || kh >= bins - 1) return 0;
      return Math.max(mag[kh - 1], mag[kh], mag[kh + 1]);
    };

    var total = 0;
    var eLo = Math.max(0, Math.round(200 / binHz)), eHi = Math.min(bins - 1, Math.round(5000 / binHz));
    for (k = eLo; k <= eHi; k++) total += mag[k];

    var best = 0, bestScore = 0, sumScore = 0, cnt = 0;
    var scores = new Float64Array(hiBin + 1);
    for (k = loBin; k <= hiBin; k++) {
      var f0 = k * binHz;
      var score = 0;
      for (var h = 1; h <= 6; h++) {
        var fh = f0 * h;
        if (fh > 5000) break;
        score += magAt(Math.round(fh / binHz)) / h;
      }
      scores[k] = score;
      sumScore += score;
      cnt++;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best === 0 || bestScore <= 0 || !cnt) return { f0: 0, clarity: 0, contrast: 0 };

    // 在接近最高的候选里挑最高的 f0（主旋律通常是最高声部）
    var pick = best;
    for (k = best + 1; k <= hiBin; k++) {
      if (scores[k] >= bestScore * 0.85) pick = k;
    }
    var meanScore = sumScore / cnt;
    return {
      f0: pick * binHz,
      clarity: total > 0 ? Math.min(1, bestScore / total) : 0,
      contrast: meanScore > 0 ? bestScore / meanScore : 0
    };
  }

  function snapToScale(midi, scaleName) {
    var scale = SCALES[scaleName] || SCALES.chromatic;
    if (scale.length === 12) return Math.round(midi);
    var base = Math.floor(midi);
    var best = base, bestDist = Infinity;
    for (var oct = -1; oct <= 1; oct++) {
      for (var i = 0; i < scale.length; i++) {
        var cand = Math.floor(midi / 12) * 12 + oct * 12 + scale[i];
        var d = Math.abs(cand - midi);
        if (d < bestDist) { bestDist = d; best = cand; }
      }
    }
    return best;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /** 窗口中值，窗口强制取奇数个，避免“平均出”一个不存在的音高 */
  function medianWindow(arr, center, radius) {
    var lo = Math.max(0, center - radius);
    var hi = Math.min(arr.length, center + radius + 1);
    var win = arr.slice(lo, hi);
    if (win.length % 2 === 0) win.pop();
    return median(win);
  }

  /* ---------------- 主入口 ---------------- */

  /**
   * @param buffer  AudioBuffer（整首歌）
   * @param options {
   *   start: 截取起点（秒）
   *   length: 截取长度（秒）
   *   sensitivity: 起音灵敏度（越大越严格），默认 1.3
   *   pitchMode: 'tone' 全部同一个音 / 'melody' 提旋律
   *   scale: 'chromatic' | 'major' | 'minor' | 'pentatonic'
   *   baseMidi: 'tone' 模式使用的音
   *   maxTracks: 默认 8
   *   tempoFold: 'half' | 'double' | 其它=不处理（速度二义性）
   *   bpmOverride: 手动指定速度，>20 时生效
   * }
   */
  function arrange(buffer, options) {
    var opt = options || {};
    var warnings = [];
    var mono = mixdownMono(buffer, ANALYSIS_RATE);
    var sr = ANALYSIS_RATE;
    var total = mono.length / sr;

    var start = Math.max(0, Math.min(opt.start || 0, Math.max(0, total - 0.5)));
    var length = Math.max(1, Math.min(opt.length || 8, total - start));
    var from = Math.floor(start * sr);
    var to = Math.min(mono.length, from + Math.floor(length * sr));
    var x = mono.subarray(from, to);

    var sf = spectralFlux(x, sr);
    var flux = sf.flux, fps = sf.fps;
    var onsets = pickOnsets(flux, fps, typeof opt.sensitivity === 'number' ? opt.sensitivity : 1.3);
    if (!onsets.length) {
      return { ok: false, reason: '这段音频里没抓到节奏点，试试换一段或把灵敏度调小', warnings: warnings };
    }

    var bpm = detectTempo(flux, fps);
    // 速度二义性（半速/双速）是测速的固有难题，给用户留出口子
    if (opt.tempoFold === 'half') bpm = Math.max(30, Math.round(bpm / 2));
    else if (opt.tempoFold === 'double') bpm = Math.min(300, Math.round(bpm * 2));
    if (typeof opt.bpmOverride === 'number' && opt.bpmOverride > 20) {
      bpm = Math.round(opt.bpmOverride);
    }
    var stepDur = 60 / bpm / 4;                 // 1/16 音符
    var stepFrames = stepDur * fps;

    // 音高分析信号（去低频 + 抽取）
    var pitchSig = pitchSignal(x, sr, PITCH_RATE);
    var pitchRate = PITCH_RATE;

    var pitchMode = opt.pitchMode === 'melody' ? 'melody' : 'tone';
    var scaleName = opt.scale || 'major';
    var baseMidi = typeof opt.baseMidi === 'number' ? opt.baseMidi : 72;

    var raw = [];
    var dropped = 0;
    var usedTracker = false;

    // 旋律模式优先走「音高轨迹 → 切音符」：真歌里一堆鼓/镲/词起音，
    // 一个起音一个音会扒成密集的八分音符串，反而是轨迹法才对得上歌的旋律。
    if (pitchMode === 'melody') {
      var tracked = melodyFromTrack(x, sr, stepDur, scaleName, 4);
      if (tracked && tracked.length) {
        raw = tracked;
        usedTracker = true;
        warnings.push('音高轨迹法：从连续基频轨迹切出 ' + tracked.length + ' 个音符');
      }
    }

    // 轨迹法不可用时，退回“每个起音估一次音高”的老办法
    for (var i = 0; !usedTracker && i < onsets.length; i++) {
      var o = onsets[i];
      var midi = baseMidi;
      var f0 = 0, clarity = 0, low = sf.lowRatio[o.frame] || 0;
      var cent = sf.centroid[o.frame] || 0;
      if (pitchMode === 'melody') {
        var winEnd = (i + 1 < onsets.length) ? Math.min(onsets[i + 1].time, o.time + 0.25) : o.time + 0.25;
        var lenS = Math.max(0.03, winEnd - o.time);
        // 主旋律用频域谐波求和（不会被贝斯带跑）；窗口太短时退回自相关
        var est = estimateF0Spectral(x, sr, Math.floor(o.time * sr), Math.floor(lenS * sr));
        if (!est.f0) {
          est = estimateF0(pitchSig, pitchRate,
            Math.floor(o.time * pitchRate), Math.floor(lenS * pitchRate));
        }
        f0 = est.f0;
        clarity = est.clarity;
        var contrast = est.contrast || 0;
        // 乐音判定：谐波结构要“冒尖”（contrast = 最佳候选分数 / 平均候选分数），
        // 噪声帧里所有候选分数都差不多，contrast 会很低，正好被挡掉
        var isPercussive = cent > 5200 && contrast < 3.5;
        var isTonal = f0 >= 180 && f0 <= 1300 && clarity >= 0.02 &&
          contrast >= 3 && !isPercussive;
        if (isTonal) {
          midi = foldToRange(snapToScale(freqToMidi(f0), scaleName), 60, 84);
        } else {
          dropped++;
          midi = null;
        }
      }
      raw.push({
        time: o.time, strength: o.strength, f0: f0, clarity: clarity,
        energy: sf.energy[o.frame] || 0, low: low, midi: midi,
        step: Math.round(o.time / stepDur)
      });
    }

    if (pitchMode === 'melody') {
      if (!usedTracker) {
        var keptTonal = raw.filter(function (r) { return r.midi !== null; });
        var tonalRatio = raw.length ? keptTonal.length / raw.length : 0;
        // 判不出音高的起音一律丢掉，而不是塞成同一个音——
        // 填成同一个音会让整首“谱子”变成一排同样的音名，看着就像没扒出来任何东西
        raw = keptTonal;
        if (!raw.length) {
          return {
            ok: false,
            reason: '这段音频里没找到能确认音高的旋律（可能是纯鼓点/环境音，或截取片段里没人声旋律）。' +
              '可以换个片段、把灵敏度调低，或把「音高」切到「单调（纯节奏）」——那模式只扒节奏，不需要音高',
            warnings: warnings
          };
        }
        if (tonalRatio < 0.35) {
          warnings.push('能确认音高的起音偏少（' + keptTonal.length + '/' +
            (keptTonal.length + dropped) + '），旋律可能不完整');
        } else {
          warnings.push('已跳过 ' + dropped + ' 个打击类节奏点');
        }

        // 同音高且挨得很近的重复起音，只留更响的那个：
        // 收拾“上一个音的余韵里混进来的镲片/伴奏影子起音”
        // （轨迹法扒出来的音符不适用这条：旋律里本来就会有重复音）
        var pruned = [];
        var shadow = 0;
        for (i = 0; i < raw.length; i++) {
          var prevNote = pruned[pruned.length - 1];
          // 音高允许差 1 个半音（同一句余韵的音高估计会轻微飘）
          if (prevNote && Math.abs(prevNote.midi - raw[i].midi) <= 1 &&
              (raw[i].time - prevNote.time) < 0.35) {
            if (raw[i].energy < prevNote.energy * 0.55) { shadow++; continue; }
            if (prevNote.energy < raw[i].energy * 0.55) { pruned.pop(); shadow++; }
          }
          pruned.push(raw[i]);
        }
        raw = pruned;
        if (shadow) warnings.push('合并 ' + shadow + ' 个余韵中的重复起音');
      }

      // 只清理“孤立跳音”：前后都跟它差 6 个半音以上、而前后彼此很接近的那种
      // （不能用中值滤波，否则会把 C5/E5 交替的旋律抹平成同音）
      var mids = raw.map(function (r) { return r.midi; });
      for (i = 1; i < raw.length - 1; i++) {
        var a = mids[i - 1], b = mids[i], c = mids[i + 1];
        if (Math.abs(b - a) >= 6 && Math.abs(b - c) >= 6 && Math.abs(a - c) <= 2) {
          raw[i].midi = Math.abs(a - b) <= Math.abs(c - b) ? a : c;
          mids[i] = raw[i].midi;
        }
      }

      // 八度跳音修正：旋律大多是级进，跨度超过 9 个半音时试试 ±12 能不能靠拢上一个音
      // （谐波求和偶尔会锁到二次谐波，表现就是整条旋律突然跳高/跳低八度）
      var octaveFix = 0;
      for (i = 1; i < raw.length; i++) {
        var prevMid = raw[i - 1].midi;
        var curMid = raw[i].midi;
        if (Math.abs(curMid - prevMid) <= 9) continue;
        var candidates = [curMid - 12, curMid + 12];
        var pickMidi = curMid, pickDist = Math.abs(curMid - prevMid);
        for (var ci = 0; ci < candidates.length; ci++) {
          var candMidi = candidates[ci];
          if (candMidi < 48 || candMidi > 96) continue;
          var dist = Math.abs(candMidi - prevMid);
          if (dist < pickDist) { pickDist = dist; pickMidi = candMidi; }
        }
        if (pickMidi !== curMid) {
          raw[i].midi = foldToRange(pickMidi, 60, 84);
          mids[i] = raw[i].midi;
          octaveFix++;
        }
      }
      if (octaveFix) warnings.push('修正 ' + octaveFix + ' 处八度跳动');
      // 极端音高（可能是噪声）向中值收敛
      var med = Math.round(median(raw.map(function (r) { return r.midi; })));
      for (i = 0; i < raw.length; i++) {
        if (raw[i].midi > med + 24) raw[i].midi = med + 12;
        if (raw[i].midi < med - 24) raw[i].midi = med - 12;
      }
    }

    // 轨道分配（钢琴卷帘里一行一个音高，默认给到 25 行，不做音高压缩）
    var maxTracks = opt.maxTracks || 25;
    var trackMidis;
    if (pitchMode === 'tone') {
      trackMidis = [baseMidi];
      for (i = 0; i < raw.length; i++) raw[i].track = 0;
    } else {
      var counts = {};
      for (i = 0; i < raw.length; i++) counts[raw[i].midi] = (counts[raw[i].midi] || 0) + 1;
      trackMidis = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
      if (trackMidis.length > maxTracks) {
        // 保留出现最多的若干个音，其余归到最近的保留音
        var keep = Object.keys(counts).map(Number)
          .sort(function (a, b) { return counts[b] - counts[a]; })
          .slice(0, maxTracks).sort(function (a, b) { return a - b; });
        warnings.push('旋律用到 ' + trackMidis.length + ' 个音，已压缩到 ' + keep.length + ' 条轨道');
        for (i = 0; i < raw.length; i++) {
          var nearest = keep[0], nd = Infinity;
          for (var q = 0; q < keep.length; q++) {
            var dd = Math.abs(keep[q] - raw[i].midi);
            if (dd < nd) { nd = dd; nearest = keep[q]; }
          }
          raw[i].midi = nearest;
        }
        trackMidis = keep;
      }
      for (i = 0; i < raw.length; i++) {
        raw[i].track = Math.max(0, trackMidis.indexOf(raw[i].midi));
      }
    }

    // 节奏密度：只保留落在 1/8 或 1/4 格上的起音，避免糊成一片
    var stepDiv = (typeof opt.stepDiv === 'number' && opt.stepDiv >= 1) ? Math.round(opt.stepDiv) : 1;
    if (stepDiv > 1) {
      var beforeN = raw.length;
      raw = raw.filter(function (r) { return r.step >= 0 && r.step % stepDiv === 0; });
      warnings.push('按 1/' + (16 / stepDiv) + ' 密度保留 ' + raw.length + '/' + beforeN + ' 个起音');
    }

    // 同一格同一轨只留最强的
    var cellBest = {};
    var kept = [];
    for (i = 0; i < raw.length; i++) {
      var r = raw[i];
      if (r.step < 0) continue;
      var key = r.track + ':' + r.step;
      if (cellBest[key] === undefined || cellBest[key] < r.strength) {
        cellBest[key] = r.strength;
        kept.push(r);
      }
    }
    // 去掉被更强同格顶替的
    var finalNotes = [];
    var bestMap = {};
    for (i = 0; i < kept.length; i++) {
      var n = kept[i];
      var k2 = n.track + ':' + n.step;
      if (bestMap[k2] === undefined || bestMap[k2] < n.strength) bestMap[k2] = n.strength;
    }
    for (i = 0; i < kept.length; i++) {
      var note = kept[i];
      if (note.strength === bestMap[note.track + ':' + note.step]) finalNotes.push(note);
    }

    var lastStep = 0;
    for (i = 0; i < finalNotes.length; i++) {
      if (finalNotes[i].step > lastStep) lastStep = finalNotes[i].step;
    }
    var steps = 8;
    while (steps < lastStep + 1 && steps < 128) steps *= 2;
    if (lastStep + 1 > 128) {
      warnings.push('节奏点太多，只保留了前 128 格的内容');
    }

    // 每个音符的时值（格）与力度：轨迹法能给出真实时值，起音法只有 1 格
    var maxEnergy = 0;
    for (i = 0; i < finalNotes.length; i++) {
      if (finalNotes[i].energy > maxEnergy) maxEnergy = finalNotes[i].energy;
    }
    for (i = 0; i < finalNotes.length; i++) {
      var fn0 = finalNotes[i];
      var durSec = fn0.dur || 0;
      fn0.durSteps = durSec > 0 ? Math.max(1, Math.round(durSec / stepDur)) : 1;
      if (fn0.tracked) {
        // 轨迹法：能量越大越响（0.65~1.0）
        var rel = maxEnergy > 0 ? fn0.energy / maxEnergy : 1;
        fn0.vel = Math.max(0.65, Math.min(1, 0.7 + 0.3 * rel));
      } else {
        // 起音法：用起音强度当力度（0.55~1.0）
        fn0.vel = Math.max(0.55, Math.min(1, 0.55 + 0.45 * (fn0.strength || 0)));
      }
    }

    var tracks = [];
    for (i = 0; i < trackMidis.length; i++) {
      tracks.push({
        midi: trackMidis[i], gain: 0.85,
        cells: new Array(steps).fill(false),
        durs: {}, vels: {}, strengths: []
      });
    }
    for (i = 0; i < finalNotes.length; i++) {
      var fn = finalNotes[i];
      if (fn.step >= steps) continue;
      var tr = tracks[fn.track];
      if (!tr) continue;
      tr.cells[fn.step] = true;
      tr.durs[fn.step] = fn.durSteps;
      tr.vels[fn.step] = Math.round(fn.vel * 100) / 100;
      tr.strengths.push(fn.strength);
    }
    for (i = 0; i < tracks.length; i++) {
      var st = tracks[i].strengths;
      // 用平均强度决定该轨力度，让响的地方更亮
      tracks[i].gain = st.length
        ? Math.min(1, Math.max(0.45, 0.55 + 0.45 * (st.reduce(function (a, b) { return a + b; }, 0) / st.length)))
        : 0.85;
      delete tracks[i].strengths;
    }

    var usedNotes = finalNotes.filter(function (n) { return n.step < steps; }).length;

    // 扒出来的谱子：按时间顺序的音高序列（用于界面展示）
    var inRange = finalNotes.filter(function (n) { return n.step < steps; });
    inRange.sort(function (x, y) { return x.step - y.step || x.midi - y.midi; });
    var melody = inRange.map(function (n) { return n.midi; });

    return {
      ok: true,
      bpm: bpm,
      stepDur: stepDur,
      steps: steps,
      tracks: tracks,
      melody: melody,
      notes: usedNotes,
      onsets: onsets.length,
      detectedFrom: start,
      analyzedLength: length,
      sourceDuration: total,
      warnings: warnings
    };
  }

  function midi_round(v) { return Math.round(v); }

  /* ---------------- 逐帧音高轨迹 + 音符切分 ----------------
   * 真歌里每 0.25s 就有一堆鼓/镲/词的起音，“一个起音一个音”会扒出一串密集的八分音符，
   * 还大量重复同一个音。这里改成主流做法：
   *   1. 每 11.6ms 算一帧谐波求和，并在“分数接近最高”的候选里选离上一帧最近的那个（连续性约束）
   *   2. 用 contrast 判断这一帧是不是乐音（噪声帧直接标为无音高）
   *   3. 中值平滑后，把音高稳定的连续帧合并成一个音符（音高变化或断开就切分）
   * 这样得到的是真正的旋律线：音符有长度、有起伏，而不是一堆瞬时击点。
   */

  var TRACK_FFT = 2048;
  var TRACK_HOP = 256;

  function pitchTrack(x, sr) {
    var nFrames = Math.max(1, Math.floor((x.length - TRACK_FFT) / TRACK_HOP) + 1);
    var bins = TRACK_FFT >> 1;
    var binHz = sr / TRACK_FFT;
    var loBin = Math.max(2, Math.round(200 / binHz));
    var hiBin = Math.min(bins - 2, Math.round(1300 / binHz));
    var hann = new Float32Array(TRACK_FFT);
    for (var i = 0; i < TRACK_FFT; i++) {
      hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (TRACK_FFT - 1));
    }
    var f0 = new Float32Array(nFrames);
    var voiced = new Uint8Array(nFrames);
    var energy = new Float32Array(nFrames);
    var re = new Float64Array(TRACK_FFT);
    var im = new Float64Array(TRACK_FFT);
    var mag = new Float64Array(bins);
    var scores = new Float64Array(hiBin + 2);
    var prevF = 0;
    var hist = [];

    for (var fr = 0; fr < nFrames; fr++) {
      var off = fr * TRACK_HOP;
      var acc = 0;
      for (i = 0; i < TRACK_FFT; i++) {
        var v = x[off + i];
        acc += v * v;
        re[i] = v * hann[i];
        im[i] = 0;
      }
      energy[fr] = Math.sqrt(acc / TRACK_FFT);
      fft(re, im);
      for (var k = 0; k < bins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      var magAt = function (kh) {
        if (kh < 1 || kh >= bins - 1) return 0;
        return Math.max(mag[kh - 1], mag[kh], mag[kh + 1]);
      };
      var best = 0, bestScore = 0, sumScore = 0, cnt = 0;
      for (k = loBin; k <= hiBin; k++) {
        var f = k * binHz, sc = 0;
        for (var h = 1; h <= 6; h++) {
          var fh = f * h;
          if (fh > 5000) break;
          sc += magAt(Math.round(fh / binHz)) / h;
        }
        scores[k] = sc;
        sumScore += sc;
        cnt++;
        if (sc > bestScore) { bestScore = sc; best = k; }
      }
      if (!best || bestScore <= 0 || !cnt) continue;
      // 在“分数够高”的候选里综合两件事挑一个：
      //   a) 靠近最近 15 帧的音高中值（用中值而不是上一帧，避免一滑到低声部就一直卡在那）
      //   b) 音越高越优先（主旋律通常是最上声部）
      // 0.55 倍门限把弱候选和纯泛音挡在门外（二次谐波的谐波求和分数会被压得很低）
      var pick = 0;
      var bestCost = Infinity;
      var ref = 0;
      if (hist.length) {
        var hs = hist.slice().sort(function (a, b) { return a - b; });
        ref = hs[hs.length >> 1];
      }
      for (k = loBin; k <= hiBin; k++) {
        if (scores[k] < bestScore * 0.55) continue;
        var fk = k * binHz;
        var jump = 0;
        if (ref > 0) {
          // 旋律不会在一百毫秒内大跳：离最近的中值超过 7 个半音的候选直接排除，
          // 这样换音瞬间就不会掉到伴奏声部去（那是假音的主要来源）
          jump = Math.abs(Math.log2(fk / ref));
          if (jump * 12 > 7) continue;
        }
        var cost = -0.6 * Math.log2(fk / 200) + jump;
        if (cost < bestCost) { bestCost = cost; pick = k; }
      }
      if (!pick) {
        // 没有候选既够分又符合旋律连续性 → 这一帧不算有效音高，
        // 交给后面的“短空档保持前一个音高”处理
        f0[fr] = 0;
        voiced[fr] = 0;
        continue;
      }
      // 候选是按 FFT 频点取的（这里 10.8Hz 一格），真值常落在两格之间，
      // 直接取整会偏半个半音（G4 392Hz 读成 409Hz → 变成 G#4）。
      // 用基频附近的幅度谱峰做抛物线插值，把精度拉回 1Hz 级。
      var kLo = Math.max(1, pick - 2);
      var kHi = Math.min(bins - 2, pick + 2);
      var pk = kLo;
      for (k = kLo; k <= kHi; k++) { if (mag[k] > mag[pk]) pk = k; }
      var y1 = mag[pk - 1], y2 = mag[pk], y3 = mag[pk + 1];
      var den = y1 - 2 * y2 + y3;
      var off = den !== 0 ? 0.5 * (y1 - y3) / den : 0;
      if (off > 0.5) off = 0.5;
      if (off < -0.5) off = -0.5;
      var fRefined = (pk + off) * binHz;

      var contrast = bestScore / (sumScore / cnt + 1e-12);
      if (contrast >= 4.5) {
        f0[fr] = fRefined;
        voiced[fr] = 1;
        prevF = f0[fr];
        hist.push(f0[fr]);
        if (hist.length > 15) hist.shift();
      } else {
        f0[fr] = 0;
        voiced[fr] = 0;
      }
    }

    // 能量门：太轻的帧不算旋律（间奏、尾音底噪）
    var ve = [];
    for (i = 0; i < nFrames; i++) if (voiced[i]) ve.push(energy[i]);
    var medE = 0;
    if (ve.length) {
      ve.sort(function (a, b) { return a - b; });
      medE = ve[ve.length >> 1];
      for (i = 0; i < nFrames; i++) {
        if (voiced[i] && energy[i] < medE * 0.25) { voiced[i] = 0; f0[i] = 0; }
      }
    }

    // 换音瞬间的分析窗里混着前后两个音的频谱，音高会短暂掉到伴奏声部（假音）。
    // 处理办法：这种短空档如果有一定能量，就保持前一个有效音高（延音），
    // 而不是让它变成一个低八度的假音符。
    var holdMax = Math.max(2, Math.round((sr / TRACK_HOP) * 0.18));
    var energyFloor = medE * 0.25;
    var lastVoiced = 0;
    i = 0;
    while (i < nFrames) {
      if (voiced[i]) {
        lastVoiced = f0[i];
        i++;
        continue;
      }
      var j = i;
      while (j < nFrames && !voiced[j]) j++;
      var runLen = j - i;
      if (runLen <= holdMax && lastVoiced > 0 && i > 0) {
        var loudEnough = true;
        for (var q = i; q < j; q++) {
          if (medE > 0 && energy[q] < energyFloor) { loudEnough = false; break; }
        }
        if (loudEnough) {
          for (q = i; q < j; q++) { f0[q] = lastVoiced; voiced[q] = 1; }
        }
      }
      i = j;
    }
    return { f0: f0, voiced: voiced, fps: sr / TRACK_HOP, nFrames: nFrames };
  }

  function hzToMidi(hz) {
    return 69 + 12 * Math.log(hz / 440) / Math.LN2;
  }

  /** 把逐帧轨迹切成音符 */
  function segmentNotes(track, opts) {
    var f0 = track.f0, voiced = track.voiced, fps = track.fps, n = track.nFrames;
    var win = 3;
    var med = new Float32Array(n);
    var tmp = [];
    for (var i = 0; i < n; i++) {
      tmp.length = 0;
      for (var j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
        if (voiced[j]) tmp.push(f0[j]);
      }
      if (!tmp.length) { med[i] = 0; continue; }
      tmp.sort(function (a, b) { return a - b; });
      med[i] = tmp[tmp.length >> 1];
    }

    var minFrames = Math.max(3, Math.round(fps * (opts.minNoteMs || 70) / 1000));
    var gapTol = Math.max(2, Math.round(fps * 0.05));
    var notes = [];
    var cur = null;
    var flush = function () {
      if (cur && cur.end - cur.start + 1 >= minFrames) {
        var frames = cur.frames.slice().sort(function (a, b) { return a - b; });
        notes.push({
          start: cur.start / fps,
          end: (cur.end + 1) / fps,
          midiRaw: frames[frames.length >> 1],
          energy: cur.energy / cur.count
        });
      }
      cur = null;
    };
    for (i = 0; i < n; i++) {
      if (med[i] <= 0) {
        if (cur) {
          cur.gap++;
          if (cur.gap > gapTol) flush();
        }
        continue;
      }
      var m = hzToMidi(med[i]);
      if (cur && Math.abs(m - cur.mean) <= 0.7) {
        cur.frames.push(m);
        cur.count++;
        cur.mean += (m - cur.mean) / cur.count;
        cur.energy += track.voiced[i] ? 1 : 0;
        cur.end = i;
        cur.gap = 0;
      } else {
        flush();
        cur = { start: i, end: i, frames: [m], mean: m, count: 1, energy: 1, gap: 0 };
      }
    }
    flush();
    return notes;
  }

  /** 用轨迹法扒旋律；返回 null 表示这条音频不适合（音符太少） */
  function melodyFromTrack(x, sr, stepDur, scaleName, minNotes) {
    var track = pitchTrack(x, sr);
    var segs = segmentNotes(track, {});
    if (segs.length < (minNotes || 4)) return null;
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      out.push({
        time: s.start,
        step: Math.round(s.start / stepDur),
        midi: foldToRange(snapToScale(s.midiRaw, scaleName), 60, 84),
        f0: 440 * Math.pow(2, (s.midiRaw - 69) / 12),
        clarity: 1,
        contrast: 10,
        energy: s.energy,
        strength: 1,
        dur: s.end - s.start,
        tracked: true
      });
    }
    return out;
  }



  global.BingAutoArrange = {
    arrange: arrange,
    SCALES: SCALES,
    _internals: {
      mixdownMono: mixdownMono,
      pitchSignal: pitchSignal,
      spectralFlux: spectralFlux,
      pickOnsets: pickOnsets,
      detectTempo: detectTempo,
      estimateF0: estimateF0,
      estimateF0Spectral: estimateF0Spectral,
      pitchTrack: pitchTrack,
      segmentNotes: segmentNotes,
      melodyFromTrack: melodyFromTrack,
      foldToRange: foldToRange,
      snapToScale: snapToScale,
      freqToMidi: freqToMidi
    }
  };
})(window);
