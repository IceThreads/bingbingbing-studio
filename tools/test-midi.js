/*
 * MIDI 编解码回归测试（Node 直接跑）
 *   node tools/test-midi.js
 * 验证：编码 → 解码 后音符（音高/起点/时值/力度）能对得上。
 */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'midi.js'), 'utf8'), sandbox);
var M = sandbox.window.BingMidi;

var src = [
  { step: 0, midi: 72, len: 2, vel: 1.0 },
  { step: 4, midi: 74, len: 1, vel: 0.6 },
  { step: 8, midi: 76, len: 4, vel: 0.8 },
  { step: 12, midi: 79, len: 3, vel: 0.45 }
];

var bytes = M.encode(src, { bpm: 96, name: 'test' });
console.log('编码字节数: ' + bytes.length);

var back = M.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
if (!back.ok) {
  console.log('❌ 解码失败: ' + back.reason);
  process.exit(1);
}
console.log('解码: ppq=' + back.ppq + ' bpm=' + back.bpm + ' 音符数=' + back.notes.length);

var fails = [];
if (back.bpm !== 96) fails.push('BPM 不对：' + back.bpm);
if (back.notes.length !== src.length) fails.push('音符数不对：' + back.notes.length + ' vs ' + src.length);

var tickPerStep = back.ppq / 4;
src.forEach(function (s, i) {
  var n = back.notes[i];
  if (!n) { fails.push('缺第 ' + i + ' 个音符'); return; }
  var startStep = n.startTick / tickPerStep;
  var lenSteps = n.durTick / tickPerStep;
  var velOk = Math.abs(n.vel - s.vel) < 0.02;
  var okRow = n.midi === s.midi && Math.abs(startStep - s.step) < 0.01 &&
    Math.abs(lenSteps - s.len) < 0.01 && velOk;
  console.log('  ' + (okRow ? '✓' : '✗') + ' midi=' + n.midi + ' step=' + startStep.toFixed(2) +
    ' len=' + lenSteps.toFixed(2) + ' vel=' + n.vel.toFixed(2));
  if (!okRow) fails.push('第 ' + i + ' 个音符不一致');
});

// 再跑一次「编码 → 解码 → 编码」看是否稳定
var again = M.encode(back.notes.map(function (n) {
  return { startTick: n.startTick, durTick: n.durTick, midi: n.midi, vel: n.vel };
}), { bpm: back.bpm, name: 'test' });
var same = again.length === bytes.length &&
  again.every(function (b, i) { return b === bytes[i]; });
console.log('二次编码一致: ' + (same ? '✓' : '✗'));
if (!same) fails.push('二次编码结果不一致');

console.log('');
if (fails.length) {
  console.log('❌ 未通过:');
  fails.forEach(function (f) { console.log('   - ' + f); });
  process.exit(1);
}
console.log('✅ 全部通过：MIDI 编解码往返一致，音高/起点/时值/力度都能保住');
