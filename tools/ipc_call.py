#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""直接走文件 IPC 调宿主，绕开桥接器/MCP 层，用于快速验证单个操作。

为什么不直接用 MCP：MCP 那层要起 node 子进程、等 stdio 握手，一次调试要几秒。
这里直接写 request.json + 触发动作，几百毫秒就一轮。

用法: python tools/ipc_call.py <op> '<json args>'
      python tools/ipc_call.py page_create '{"name":"=MCP/1","type":"Circuit","dryRun":true}'
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IPC = r"C:\Users\Public\EPLAN\Data\eplan-mcp\ipc"
TRIGGER = os.path.join(ROOT, "test", "callaction.exe")


def call(op, args=None, timeout=120):
    os.makedirs(IPC, exist_ok=True)
    rid = "t%d" % int(time.time() * 1000)
    request_path = os.path.join(IPC, "request.json")
    reply_path = os.path.join(IPC, "reply-%s.json" % rid)

    with open(request_path, "w", encoding="utf-8") as f:
        json.dump({"id": rid, "op": op, "args": args or {}}, f, ensure_ascii=False)

    subprocess.run([TRIGGER, "EplanMcpRun"], capture_output=True)

    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(reply_path):
            with open(reply_path, encoding="utf-8-sig") as f:
                data = json.load(f)
            try:
                os.remove(reply_path)
            except OSError:
                pass
            return data
        time.sleep(0.05)

    return {"ok": False, "error": {"code": "TIMEOUT", "message": "等了 %d 秒没有响应" % timeout}}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    op = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

    started = time.time()
    reply = call(op, args)
    elapsed = (time.time() - started) * 1000

    # 强制 UTF-8 输出，否则 Windows 控制台会把中文变成乱码。
    out = json.dumps(reply, ensure_ascii=False, indent=2)
    sys.stdout.buffer.write(out.encode("utf-8"))
    sys.stdout.buffer.write(("\n\n(%.0f ms)\n" % elapsed).encode("utf-8"))
    return 0 if reply.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
