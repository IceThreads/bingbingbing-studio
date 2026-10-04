/*
 * 看一眼一个 MIDI 文件到底长什么样（不依赖浏览器）
 *   node tools/inspect-midi.js "某个.mid"
 * 打印：头信息、每个轨道的名字、事件统计、音符数、速度范围
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

var file = process.argv[2];
if (!file) {
  console.error('用法: node tools/inspect-midi.js <文件.mid>');
  process.exit(2);
}
var buf = fs.readFileSync(file);
console.log('文件: ' + file + ' · ' + buf.length + ' 字节');
console.log('头 14 字节: ' + Array.prototype.map.call(buf.slice(0, 14), function (b) {
  return b.toString(16).padStart(2, '0');
}).join(' '));
console.log('MThd=' + (buf.toString('ascii', 0, 4) === 'MThd') +
  ' format=' + buf.readUInt16BE(8) +
  ' ntrks=' + buf.readUInt16BE(10) +
  ' division=' + buf.readUInt16BE(12));

var res = M.decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
if (!res.ok) {
  console.log('❌ 解码失败: ' + res.reason);
  process.exit(1);
}
console.log('✅ 解码成功: ppq=' + res.ppq + ' bpm=' + res.bpm +
  ' format=' + res.format + ' 音符数=' + res.notes.length);

if (res.notes.length) {
  var lo = 999, hi = -1, totalDur = 0, velMin = 2, velMax = -1;
  res.notes.forEach(function (n) {
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
    totalDur += n.durTick;
    if (n.vel < velMin) velMin = n.vel;
    if (n.vel > velMax) velMax = n.vel;
  });
  var tickPerStep = res.ppq / 4;
  var lastTick = res.notes[res.notes.length - 1].startTick;
  console.log('音域: ' + lo + '~' + hi + '  力度: ' + velMin.toFixed(2) + '~' + velMax.toFixed(2) +
    '  平均时值: ' + (totalDur / res.notes.length / tickPerStep).toFixed(2) + ' 格');
  console.log('最后一音在第 ' + Math.round(lastTick / tickPerStep) + ' 格（1/16 格）');
  console.log('前 12 个音符:');
  res.notes.slice(0, 12).forEach(function (n) {
    console.log('   step=' + (n.startTick / tickPerStep).toFixed(2) +
      ' midi=' + n.midi + ' len=' + (n.durTick / tickPerStep).toFixed(2) + ' vel=' + n.vel.toFixed(2));
  });
}
