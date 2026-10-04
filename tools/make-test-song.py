# -*- coding: utf-8 -*-
"""生成一首已知速度与音高的测试曲，用来验证自动编曲的准确度。

用法: py tools/make-test-song.py [输出路径] [BPM] [秒数]
默认输出 _test-song.wav，120 BPM，8 秒：
  - 每拍一记底鼓（55Hz 衰减正弦）
  - 反拍一记 hi-hat（噪声）
  - 旋律每拍交替 C5 / E5（523.25 / 659.25 Hz）
"""

import math
import os
import random
import struct
import sys
import wave

out = sys.argv[1] if len(sys.argv) > 1 else '_test-song.wav'
bpm = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0
seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
sr = 44100
n = int(sr * seconds)
buf = [0.0] * n

beat = 60.0 / bpm
random.seed(7)


def add(start_sec, samples):
    i0 = int(start_sec * sr)
    for k, v in enumerate(samples):
        idx = i0 + k
        if 0 <= idx < n:
            buf[idx] += v


# 底鼓
t = 0.0
while t < seconds:
    length = int(0.12 * sr)
    add(t, [0.6 * math.sin(2 * math.pi * 55 * (k / sr)) * math.exp(-k / sr * 22) for k in range(length)])
    t += beat

# hi-hat（反拍）
t = beat / 2
while t < seconds:
    length = int(0.04 * sr)
    add(t, [0.12 * (random.random() * 2 - 1) * math.exp(-k / sr * 90) for k in range(length)])
    t += beat

# 旋律：每拍交替 C5 / E5
melody = [523.25, 659.25]
t = 0.0
idx = 0
while t < seconds:
    f = melody[idx % 2]
    length = int(0.30 * sr)
    add(t, [0.34 * math.sin(2 * math.pi * f * (k / sr)) * math.exp(-k / sr * 6) for k in range(length)])
    t += beat
    idx += 1

frames = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, v)) * 32000)) for v in buf)
with wave.open(out, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(frames)

print('%s | %.1f BPM | %.1fs | %.1f KB' % (os.path.abspath(out), bpm, seconds, os.path.getsize(out) / 1024.0))
