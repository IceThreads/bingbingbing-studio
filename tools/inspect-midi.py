# -*- coding: utf-8 -*-
"""独立的 SMF 解析器（Python），用来交叉校验 JS 解码结果。
用法: py tools/inspect-midi.py <文件.mid>
"""
import struct
import sys


def read_varlen(data, pos):
    value = 0
    while True:
        b = data[pos]
        pos += 1
        value = (value << 7) | (b & 0x7F)
        if not (b & 0x80):
            return value, pos


def main(path):
    data = open(path, 'rb').read()
    assert data[:4] == b'MThd', '不是 MIDI 文件'
    hlen, fmt, ntrks, div = struct.unpack('>IHHH', data[4:14])
    print('format=%d ntrks=%d division=%d' % (fmt, ntrks, div))

    pos = 8 + hlen
    total_notes = 0
    tempo = None
    all_pitches = []
    last_tick = 0
    for t in range(ntrks):
        assert data[pos:pos + 4] == b'MTrk', '轨道 %d 找不到 MTrk' % t
        tlen = struct.unpack('>I', data[pos + 4:pos + 8])[0]
        end = pos + 8 + tlen
        p = pos + 8
        tick = 0
        running = None
        notes = 0
        name = ''
        on_events = 0
        while p < end:
            delta, p = read_varlen(data, p)
            tick += delta
            st = data[p]
            if st & 0x80:
                running = st
                p += 1
            else:
                st = running
            if st == 0xFF:
                mt = data[p]
                p += 1
                ml, p = read_varlen(data, p)
                if mt == 0x51 and ml >= 3:
                    us = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]
                    tempo = round(60000000 / us) if us else None
                if mt == 0x03:
                    name = data[p:p + ml].decode('utf-8', 'ignore')
                p += ml
            elif st in (0xF0, 0xF7):
                ml, p = read_varlen(data, p)
                p += ml
            elif st & 0xF0 in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                d1, d2 = data[p], data[p + 1]
                p += 2
                if st & 0xF0 == 0x90 and d2 > 0:
                    notes += 1
                    on_events += 1
                    all_pitches.append(d1)
            elif st & 0xF0 in (0xC0, 0xD0):
                p += 1
            else:
                print('  ! 未知状态 0x%02X @ %d' % (st, p))
                p += 1
        print('  轨道%d: 名字=%r 音符on=%d 结束tick=%d' % (t, name, notes, tick))
        total_notes += notes
        last_tick = max(last_tick, tick)
        pos = end

    tick_per_step = div / 4.0
    print('合计: 音符on=%d bpm=%s 最后一tick=%d = 第 %.0f 格(1/16)' %
          (total_notes, tempo, last_tick, last_tick / tick_per_step))
    if all_pitches:
        print('音域: %d~%d 中位=%d' % (min(all_pitches), max(all_pitches),
                                      sorted(all_pitches)[len(all_pitches) // 2]))
        # 第一个有音符的格
        print('提示: 这份文件很长，导入时要选区间')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'song.mid')
