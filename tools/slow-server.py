# -*- coding: utf-8 -*-
"""带 /slow 慢响应的静态服务器：给无头浏览器测试留出真实的异步解码时间。

用法: py tools/slow-server.py [端口] [延迟秒数]
      页面里放一个 <img src="/slow.png"> 就能把 load 事件拖后 N 秒（真实时间）。
"""

import http.server
import os
import socketserver
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
DELAY = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082'
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.startswith('/slow'):
            time.sleep(DELAY)
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
    httpd.daemon_threads = True
    print('serving %s at http://127.0.0.1:%d (slow=%ss)' % (ROOT, PORT, DELAY), flush=True)
    httpd.serve_forever()
