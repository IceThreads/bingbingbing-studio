# -*- coding: utf-8 -*-
"""生成一首“像样”的测试歌：鼓组 + 贝斯 + 和弦 + 主旋律（100 BPM, 8 秒）

用法: py tools/make-demo-song.py [输出路径] [BPM] [秒数]
写出 16bit 单声道 WAV，用来端到端验证「导入音乐 → 自动编曲」。
"""

import math
import os
import struct
import sys
import wave

out = sys.argv[1] if len(sys.argv) > 1 else '_demo-song.wav'
bpm = float(sys.argv[2]) if len(sys.argv) > 2 else 100.0
seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
sr = 22050
n = int(sr * seconds)
buf = [0.0] * n
beat = 60.0 / bpm
rng = 12345


def rand():
    global rng
    rng = (rng * 1103515245 + 12345) & 0x7FFFFFFF
    return rng / float(0x7FFFFFFF)


def add(start, samples, gain=1.0):
    i0 = int(start * sr)
    for k, v in enumerate(samples):
        idx = i0 + k
        if 0 <= idx < n:
            buf[idx] += v * gain


def kick():
    return [0.75 * math.sin(2 * math.pi * (58 - 20 * k / sr) * (k / sr)) * math.exp(-k / sr * 16)
            for k in range(int(0.16 * sr))]


def snare():
    return [(0.35 * (rand() * 2 - 1) + 0.2 * math.sin(2 * math.pi * 190 * k / sr)) * math.exp(-k / sr * 26)
            for k in range(int(0.14 * sr))]


def hat(open_=False):
    d = 0.09 if open_ else 0.03
    return [0.16 * (rand() * 2 - 1) * math.exp(-k / sr / d) for k in range(int(0.12 * sr))]


def tone(freq, dur, gain, harm=(1.0, 0.35, 0.15)):
    out_ = []
    ln = int(dur * sr)
    for k in range(ln):
        t = k / sr
        env = min(1.0, t / 0.008) * math.exp(-t * 3.2)
        v = 0.0
        for h, a in enumerate(harm):
            v += a * math.sin(2 * math.pi * freq * (h + 1) * t)
        out_.append(gain * env * v / sum(harm))
    return out_


def midi_to_freq(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


# ---- 编排：4/4，每小节 4 拍 ----
bars = int(seconds / (beat * 4)) + 1
# Am - F - C - G 的简化级联（低音 + 和弦）
chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
# 主旋律（每拍一个音）
melody = [72, 74, 76, 74, 69, 72, 74, 72, 67, 69, 72, 69, 71, 74, 76, 74]

for bar in range(bars):
    base = bar * 4 * beat
    ch = chords[bar % 4]
    for b in range(4):
        t = base + b * beat
        if t >= seconds:
            break
        # 鼓
        if b in (0, 2):
            add(t, kick())
        if b in (1, 3):
            add(t, snare())
        add(t + beat / 2, hat(b == 3), 0.8)
        if b == 3:
            add(t + beat * 0.75, hat(True), 0.7)
        # 贝斯：根音
        add(t, tone(midi_to_freq(ch[0] - 12), beat * 0.85, 0.24, (1.0, 0.2)))
        # 和弦垫：每小节头两拍
        if b < 2:
            for m in ch:
                # 和弦垫刻意压得很轻：让主旋律成为最突出的声部（真实歌曲里人声也一样）
                add(t, tone(midi_to_freq(m), beat * 1.6, 0.02, (1.0, 0.3, 0.1)))
        # 主旋律
        note = melody[(bar * 4 + b) % len(melody)]
        add(t, tone(midi_to_freq(note), beat * 0.6, 0.45, (1.0, 0.4, 0.2)))

peak = max(1e-9, max(abs(v) for v in buf))
frames = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, v / peak * 0.92)) * 32000)) for v in buf)
with wave.open(out, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(frames)

print('%s | %.1f BPM | %.1fs | %.1f KB' % (os.path.abspath(out), bpm, seconds, os.path.getsize(out) / 1024.0))
