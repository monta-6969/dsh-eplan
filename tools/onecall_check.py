# -*- coding: utf-8 -*-
"""最终验证：一次 MCP 工具调用建出整页并拿回渲染图。"""
import sys, io, json, subprocess, os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = r"D:\静静\任务（干活的文件分类放这里）\eplan-mcp"
PAGE = sys.argv[1] if len(sys.argv) > 1 else "=MCP/10"

XS = [72, 116, 160, 204]
Y_BUS, Y_FUSE = 236, 200

nodes = [
    {"symbol": "CDPST", "library": "SPECIAL", "at": [XS[0], Y_BUS + 16], "deviceTag": "L24"},
    {"symbol": "CDPST", "library": "SPECIAL", "at": [XS[0] + 16, Y_BUS + 16], "deviceTag": "0V"},
    {"symbol": "TOUR", "library": "SPECIAL", "variant": 0, "at": [XS[0], Y_BUS], "showDeviceTag": False},
    {"symbol": "TLRU", "library": "SPECIAL", "variant": 8, "at": [XS[1], Y_BUS], "showDeviceTag": False},
    {"symbol": "TLRU", "library": "SPECIAL", "variant": 8, "at": [XS[2], Y_BUS], "showDeviceTag": False},
    {"symbol": "CO", "library": "SPECIAL", "variant": 3, "at": [XS[3], Y_BUS], "showDeviceTag": False},
]
for x, tag in zip(XS, ["-F4", "-F5", "-F6", "-F7"]):
    nodes.append({"symbol": "F1", "library": "GB_symbol", "at": [x, Y_FUSE], "deviceTag": tag})

texts = [{"at": [x - 5, Y_FUSE - 22], "text": "L24-%d" % (i + 1), "height": 2.5}
         for i, x in enumerate(XS)]
texts += [{"at": [x - 8, Y_FUSE - 36], "text": n, "height": 2.5}
          for x, n in zip(XS, ["PLC用", "变频和伺服用", "步进电机用", "输入输出用"])]

payload = {"name": PAGE, "project": "test", "type": "Schematic",
           "nodes": nodes, "texts": texts, "reveal": True, "width": 1800}

out = subprocess.run(["node", "test/call-tool.mjs", "page_create", json.dumps(payload, ensure_ascii=False)],
                     cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
lines = [l for l in (out.stdout or "").splitlines() if "已启动" not in l]
print("\n".join(lines[:24]))
if out.stderr.strip():
    print("STDERR:", out.stderr.strip()[:400])
