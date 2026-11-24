# -*- coding: utf-8 -*-
"""第 2 页 =MI/2：220V 控制电源回路（QF2 -> 隔离变压器 T1 -> QF3 -> 插座）。

两根竖线 L/N 相隔 16 mm，正好对上 Q2（两极断路器）和 TS11（单相变压器）的
两个引脚间距，所以整页不需要画任何线，红线由 EPLAN 按引脚位置自动生成。
"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, r"D:\静静\任务（干活的文件分类放这里）\eplan-mcp\tools")
from ipc_call import call

PROJECT, PAGE = "三菱变频器", "=MI/2"
L, N = 60, 76          # 两根竖线的 x

call("page_delete", {"page": PAGE, "project": PROJECT}, timeout=200)

nodes = [
    {"symbol": "CDPST", "library": "SPECIAL", "at": [L, 252], "deviceTag": "L220"},
    {"symbol": "CDPST", "library": "SPECIAL", "at": [N, 252], "deviceTag": "0V"},
    {"symbol": "Q2", "at": [L, 220], "deviceTag": "-QF2", "showDeviceTag": False},          # 两极断路器
    {"symbol": "TS11", "at": [L, 180], "deviceTag": "-T1", "showDeviceTag": False},          # 单相隔离变压器
    {"symbol": "Q2", "at": [L, 140], "deviceTag": "-QF3", "showDeviceTag": False},
    {"symbol": "CDPST", "library": "SPECIAL", "at": [L, 100], "deviceTag": "-C21", "showDeviceTag": False},
    {"symbol": "CDPST", "library": "SPECIAL", "at": [N, 100], "showDeviceTag": False},
]

texts = [
    {"at": [L - 10, 272], "text": "220V 控制电源  L / N", "height": 3.5},
    {"at": [L - 8, 232], "text": "-QF2  2P 6A", "height": 2.5},
    {"at": [L - 8, 190], "text": "隔离变压器 380/220V 1kVA", "height": 2.5},
    {"at": [L - 8, 152], "text": "-QF3  2P 6A", "height": 2.5},
    {"at": [L - 8, 88], "text": "-C21  调试电源三孔插座 10A", "height": 2.5},
    {"at": [L - 10, 56], "text": "220V 控制电源回路", "height": 5.0},
]

r = call("page_create", {
    "page": PAGE, "project": PROJECT, "append": True,
    "nodes": nodes, "texts": texts, "grid": 4,
}, timeout=400)
res = r.get("result") or {}
print("ok:", r.get("ok"), "| 元件:", len(res.get("nodesPlaced") or []),
      "| 失败:", res.get("nodesFailed"), "| 吸附:", len(res.get("snapped") or []))

r2 = call("look", {"page": PAGE, "project": PROJECT, "width": 1500}, timeout=220)
print("图:", (r2.get("result") or {}).get("imagePath"))
c = call("check", {"page": PAGE, "project": PROJECT}, timeout=200)
cr = c.get("result") or {}
print("检查:", cr.get("verdict"), "|", cr.get("summary"))
