# -*- coding: utf-8 -*-
"""一次调用出一整页 —— 验证 page_create 的组合能力。"""
import sys, io, json, time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, r"D:\静静\任务（干活的文件分类放这里）\eplan-mcp\tools")
from ipc_call import call

XS = [72, 116, 160, 204]
Y_BUS, Y_FUSE = 236, 200
PAGE = sys.argv[1] if len(sys.argv) > 1 else "=MCP/9"

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

texts = []
for i, x in enumerate(XS):
    texts.append({"at": [x - 5, Y_FUSE - 22], "text": "L24-%d" % (i + 1), "height": 2.5})
for x, name in zip(XS, ["PLC用", "变频和伺服用", "步进电机用", "输入输出用"]):
    texts.append({"at": [x - 8, Y_FUSE - 36], "text": name, "height": 2.5})

start = time.time()
r = call("page_create", {"page": PAGE, "project": "test", "type": "Circuit",
                         "nodes": nodes, "texts": texts}, timeout=300)
elapsed = (time.time() - start) * 1000

if not r.get("ok"):
    print("FAIL", json.dumps(r.get("error"), ensure_ascii=False))
    raise SystemExit(1)

res = r["result"]
print("一次调用耗时 %.0f ms" % elapsed)
print("  创建:", res.get("created"), "| 节点成功:", len(res.get("nodesPlaced") or []),
      "| 节点失败:", len(res.get("nodesFailed") or []), "| 文字:", res.get("textsWritten"))
for f in (res.get("nodesFailed") or []):
    print("   失败:", f)
