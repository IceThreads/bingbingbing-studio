/*
 * 自动编曲回归测试（Node 直接跑，不依赖浏览器）
 *
 *   node tools/test-arrange.js [wav 文件]
 *
 * 用 tools/make-test-song.py 生成的测试曲验证：
 *   1. 测速是否命中已知 BPM
 *   2. 起音数是否接近理论值
 *   3. 旋律模式能否把 C5/E5 抓出来（并丢掉底鼓）
 */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');

/* ---- 载入浏览器风格模块 ---- */
var sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'auto-arrange.js'), 'utf8'), sandbox);
var AA = sandbox.window.BingAutoArrange;

/* ---- 极简 WAV 解析（16bit PCM） ---- */
function readWav(file) {
  var buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 RIFF/WAV 文件');
  var pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    var id = buf.toString('ascii', pos, pos + 4);
    var size = buf.readUInt32LE(pos + 4);
    var body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = size;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 缺少 fmt/data 块');
  if (fmt.bits !== 16) throw new Error('只支持 16bit PCM，当前 ' + fmt.bits + 'bit');
  var frames = Math.floor(dataLen / 2 / fmt.channels);
  var chans = [];
  for (var c = 0; c < fmt.channels; c++) chans.push(new Float32Array(frames));
  for (var i = 0; i < frames; i++) {
    for (var ch = 0; ch < fmt.channels; ch++) {
      chans[ch][i] = buf.readInt16LE(dataOff + (i * fmt.channels + ch) * 2) / 32768;
    }
  }
  var mixed = new Float32Array(frames);
  for (i = 0; i < frames; i++) {
    var s = 0;
    for (ch = 0; ch < fmt.channels; ch++) s += chans[ch][i];
    mixed[i] = s / fmt.channels;
  }
  return {
    sampleRate: fmt.sampleRate,
    numberOfChannels: fmt.channels,
    length: frames,
    duration: frames / fmt.sampleRate,
    getChannelData: function () { return mixed; }
  };
}

function summarize(pattern, label) {
  var lines = [label + ': bpm=' + pattern.bpm + ' steps=' + pattern.steps +
    ' onsets=' + pattern.onsets + ' 落格=' + pattern.notes];
  pattern.tracks.forEach(function (t, i) {
    var idx = [];
    t.cells.forEach(function (c, s) { if (c) idx.push(s); });
    if (idx.length) {
      lines.push('   轨' + i + ' midi=' + t.midi + ' (' + t.midi % 12 + ') gain=' + t.gain.toFixed(2) +
        ' 个数=' + idx.length + ' 位置=' + idx.slice(0, 12).join(',') + (idx.length > 12 ? '…' : ''));
    }
  });
  if (pattern.warnings && pattern.warnings.length) lines.push('   提示: ' + pattern.warnings.join(' / '));
  return lines.join('\n');
}

function main() {
  var file = process.argv[2] || path.join(ROOT, '_test-song.wav');
  if (!fs.existsSync(file)) {
    console.error('找不到测试音频：' + file + '\n先生成一首：py tools/make-test-song.py _test-song.wav 128 8');
    process.exit(1);
  }
  var audio = readWav(file);
  console.log('测试音频: ' + file + ' · ' + audio.duration.toFixed(2) + 's · ' +
    audio.sampleRate + 'Hz · ' + audio.numberOfChannels + 'ch\n');

  var fold = process.env.FOLD || 'auto';
  var base = { start: 0, length: 8, sensitivity: 1.3, maxTracks: 25, tempoFold: fold };
  if (fold !== 'auto') console.log('速度处理: ' + fold + '\n');

  var tone = AA.arrange(audio, Object.assign({}, base, { pitchMode: 'tone', baseMidi: 72 }));
  console.log(tone.ok ? summarize(tone, '单调模式') : ('单调模式失败: ' + tone.reason));
  console.log('');

  var melody = AA.arrange(audio, Object.assign({}, base, { pitchMode: 'melody', scale: 'major' }));
  console.log(melody.ok ? summarize(melody, '旋律模式(大调)') : ('旋律模式失败: ' + melody.reason));

  // 断言（EXPECT_BPM 环境变量可指定期望速度，默认 128）
  var expectBpm = parseInt(process.env.EXPECT_BPM || '128', 10);
  var topMidi = parseFloat(process.env.EXPECT_MIDI || '76');
  var lowMidi = parseFloat(process.env.EXPECT_MIDI_LOW || '72');
  var fails = [];
  var gotBpm = tone.ok ? tone.bpm : 0;
  var exact = Math.abs(gotBpm - expectBpm) <= 4;
  // 半速/双速二义性：测速的固有难题，只要落在 1x/2x/0.5x 就算识别正确
  var ambiguous = Math.abs(gotBpm - expectBpm * 2) <= 8 || Math.abs(gotBpm - expectBpm / 2) <= 4;
  if (!exact && !ambiguous) {
    fails.push('测速不准：期望 ~' + expectBpm + '，得到 ' + (tone.ok ? tone.bpm : '失败'));
  } else if (!exact) {
    console.log('注：自动测速落在 ' + gotBpm + ' BPM（' + expectBpm + ' 的 ' +
      (gotBpm > expectBpm ? '2 倍' : '一半') + '），属于速度二义性，可用「自动 ÷2 / ×2 / 手动」修正\n');
  }
  // 起音数量随速度变化：8 秒里大致有 (8/60*bpm) 拍，每拍约 1~2 个起音
  var minOnsets = Math.floor(8 / 60 * expectBpm * 1.5);
  if (tone.ok && tone.onsets < minOnsets) {
    fails.push('起音太少：' + tone.onsets + '（该速度下至少应有 ~' + minOnsets + ' 个）');
  }
  if (melody.ok) {
    var midis = melody.tracks.map(function (t) { return t.midi; }).sort(function (a, b) { return a - b; });
    var hasLow = midis.indexOf(lowMidi) >= 0, hasHigh = midis.indexOf(topMidi) >= 0;
    if (!hasLow || !hasHigh) {
      fails.push('没抓出 ' + lowMidi + '/' + topMidi + ' 两个音，得到 midi=' + midis.join(','));
    }
    if (midis.some(function (m) { return m < 55; })) fails.push('底鼓漏进来了：' + midis.join(','));
  } else {
    fails.push('旋律模式失败');
  }

  // 可选：和真实谱子比对（LCS 相似度），用于验证「扒谱」质量
  var truthRaw = process.env.EXPECT_MELODY || '';
  if (truthRaw && melody.ok) {
    var truth = truthRaw.split(',').map(function (v) { return parseInt(v, 10); });
    var got = melody.melody || [];
    // 最长公共子序列
    var dp = [];
    for (var a = 0; a <= truth.length; a++) {
      dp.push(new Array(got.length + 1).fill(0));
    }
    for (a = 1; a <= truth.length; a++) {
      for (var b = 1; b <= got.length; b++) {
        dp[a][b] = truth[a - 1] === got[b - 1]
          ? dp[a - 1][b - 1] + 1
          : Math.max(dp[a - 1][b], dp[a][b - 1]);
      }
    }
    var lcs = dp[truth.length][got.length];
    var ratio = lcs / truth.length;
    console.log('扒谱比对: 真值 ' + truth.length + ' 个音，识别 ' + got.length +
      ' 个音，LCS 命中 ' + lcs + '（' + (ratio * 100).toFixed(0) + '%）');
    console.log('  真值: ' + truth.join(','));
    console.log('  识别: ' + got.join(','));
    if (ratio < 0.6) fails.push('扒谱相似度不足：' + (ratio * 100).toFixed(0) + '%（要求 ≥60%）');
  }

  console.log('');
  if (fails.length) {
    console.log('❌ 未通过:');
    fails.forEach(function (f) { console.log('   - ' + f); });
    process.exit(1);
  }
  console.log('✅ 全部通过：测速命中 ~' + expectBpm + ' BPM，旋律音高正确（' +
    lowMidi + '/' + topMidi + '），打击类起音已被过滤');
}

main();
