# -*- coding: utf-8 -*-
"""
把本地音频素材内嵌成 sample-data.js，让工作室在 file:// 直接打开时也能自动加载真实音源。

用法：
    py tools/embed-sample.py "C:\\Users\\Lenovo\\Desktop\\冰冰冰音效 - audio.m4a"
    py tools/embed-sample.py <音频文件> --name 冰冰冰 --root 60
    py tools/embed-sample.py --reset            # 清空内嵌素材，恢复占位

说明：
- 不做转码，直接 base64 内嵌原文件；浏览器（Edge/Chrome）原生支持解码 m4a/aac/mp3/wav/ogg。
- 同时把原文件复制到 samples/ 目录留档。
- 生成的文件：sample-data.js（被 index.html 直接引入）
"""

import argparse
import base64
import json
import os
import shutil
import sys
import wave

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES_DIR = os.path.join(PROJECT_DIR, 'samples')
OUT_FILE = os.path.join(PROJECT_DIR, 'sample-data.js')

MIME = {
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.aac': 'audio/aac',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
}

PLACEHOLDER = (
    '/* 占位文件：还没有内嵌音源。\n'
    ' * 执行 `py tools/embed-sample.py <你的音频文件>` 后会被自动覆盖为真实素材。\n'
    ' */\n'
    'window.BING_SAMPLE = null;\n'
)


def wav_duration(path):
    try:
        with wave.open(path, 'rb') as f:
            return f.getnframes() / float(f.getframerate())
    except Exception:
        return None


def mp4_duration(path):
    """极简 mvhd 解析，只为打印时长提示。"""
    try:
        with open(path, 'rb') as f:
            data = f.read()
        idx = data.find(b'mvhd')
        if idx < 0:
            return None
        version = data[idx + 4]
        if version == 1:
            timescale = int.from_bytes(data[idx + 24:idx + 28], 'big')
            duration = int.from_bytes(data[idx + 28:idx + 36], 'big')
        else:
            timescale = int.from_bytes(data[idx + 16:idx + 20], 'big')
            duration = int.from_bytes(data[idx + 20:idx + 24], 'big')
        return duration / float(timescale) if timescale else None
    except Exception:
        return None


def probe_duration(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.wav':
        return wav_duration(path)
    if ext in ('.m4a', '.mp4', '.aac'):
        return mp4_duration(path)
    return None


def reset():
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write(PLACEHOLDER)
    print('[ok] 已恢复占位：%s' % OUT_FILE)


def main():
    parser = argparse.ArgumentParser(description='把音频素材内嵌为 sample-data.js')
    parser.add_argument('audio', nargs='?', help='音频文件路径')
    parser.add_argument('--name', default='冰冰冰', help='显示名称，默认 冰冰冰')
    parser.add_argument('--root', type=int, default=60, help='采样根音 MIDI，默认 60 (C4)')
    parser.add_argument('--reset', action='store_true', help='清空内嵌素材')
    args = parser.parse_args()

    if args.reset:
        reset()
        return 0

    if not args.audio:
        parser.print_help()
        return 2

    src = os.path.abspath(args.audio)
    if not os.path.isfile(src):
        print('[error] 找不到文件：%s' % src)
        return 1

    ext = os.path.splitext(src)[1].lower()
    if ext not in MIME:
        print('[warn] 未识别的扩展名 %s，仍按 audio/mpeg 处理' % ext)

    size = os.path.getsize(src)
    duration = probe_duration(src)

    if not os.path.isdir(SAMPLES_DIR):
        os.makedirs(SAMPLES_DIR)
    kept = os.path.join(SAMPLES_DIR, os.path.basename(src))
    shutil.copyfile(src, kept)

    with open(src, 'rb') as f:
        raw = f.read()
    payload = base64.b64encode(raw).decode('ascii')

    data = {
        'name': args.name,
        'file': os.path.basename(src),
        'mime': MIME.get(ext, 'audio/mpeg'),
        'root': args.root,
        'data': payload,
    }

    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write('/* 由 tools/embed-sample.py 自动生成，请勿手工编辑。\n')
        f.write(' * 源文件：%s\n * 大小：%.1f KB%s\n */\n' % (
            os.path.basename(src),
            size / 1024.0,
            ('，时长约 %.2fs' % duration) if duration else '',
        ))
        f.write('window.BING_SAMPLE = ')
        f.write(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
        f.write(';\n')

    print('[ok] 源文件      : %s (%.1f KB%s)' % (
        src, size / 1024.0, ('，约 %.2fs' % duration) if duration else ''))
    print('[ok] 留档副本    : %s' % kept)
    print('[ok] 内嵌数据    : %s (%.1f KB)' % (OUT_FILE, os.path.getsize(OUT_FILE) / 1024.0))
    print('[i ] 采样根音    : MIDI %d' % args.root)
    print('现在直接双击 index.html 就会自动加载这段素材。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
