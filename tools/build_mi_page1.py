# -*- coding: utf-8 -*-
"""主供电回路第 1 页：进线 -> QF0 -> 母线 -> 四路熔断器 -> 隔离变压器 T1。

坐标全部落在 4 mm 栅格上。竖列靠「引脚同轴相对」让 EPLAN 自己生成红色连接线，
不用 draw 画线。
"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, r"D:\静静\任务（干活的文件分类放这里）\eplan-mcp\tools")
from ipc_call import call

PROJECT, PAGE = "三菱变频器", "=MI/1"

# 清掉旧内容（删页失败也不影响，后面 append 会追加）
call("page_delete", {"page": PAGE, "project": PROJECT}, timeout=200)

COLS = [60, 100, 140, 180]
Y_IN, Y_QF, Y_BUS, Y_FUSE, Y_T1 = 264, 220, 180, 150, 110

nodes = [
    # 进线端子（三相）
    {"symbol": "CDPST", "library": "SPECIAL", "at": [COLS[0], Y_IN], "showDeviceTag": False},
    # 电源切断开关：三极带熔断器
    {"symbol": "QSF3", "at": [COLS[0], Y_QF], "deviceTag": "-QF0"},
    # 母线：左端 T 接、中间两个 T 接、右端收尾
    {"symbol": "TLRO", "library": "SPECIAL", "variant": 8, "at": [COLS[0], Y_BUS], "showDeviceTag": False},
    {"symbol": "TLRU", "library": "SPECIAL", "variant": 8, "at": [COLS[1], Y_BUS], "showDeviceTag": False},
    {"symbol": "TLRU", "library": "SPECIAL", "variant": 8, "at": [COLS[2], Y_BUS], "showDeviceTag": False},
    {"symbol": "CO", "library": "SPECIAL", "variant": 3, "at": [COLS[3], Y_BUS], "showDeviceTag": False},
    # 四路熔断器
    {"symbol": "F1", "at": [COLS[0], Y_FUSE], "deviceTag": "-F4"},
    {"symbol": "F1", "at": [COLS[1], Y_FUSE], "deviceTag": "-F5"},
    {"symbol": "F1", "at": [COLS[2], Y_FUSE], "deviceTag": "-F6"},
    {"symbol": "F1", "at": [COLS[3], Y_FUSE], "deviceTag": "-F7"},
    # 第 1 路经隔离变压器出 220V
    {"symbol": "TS11", "at": [COLS[0], Y_T1], "deviceTag": "-T1"},
]

texts = [
    {"at": [COLS[0] - 8, Y_IN + 10], "text": "主电源进线 L1 L2 L3", "height": 3.5},
    {"at": [COLS[0] - 6, Y_QF - 20], "text": "-QF0 电源切断开关 32A", "height": 2.5},
    {"at": [COLS[0] - 6, Y_T1 - 20], "text": "隔离变压器 380/220V 1kVA", "height": 2.5},
    {"at": [COLS[0] - 8, 60], "text": "工业机器人系统 主供电回路", "height": 5.0},
]

r = call("page_create", {
    "page": PAGE, "project": PROJECT, "append": True,
    "nodes": nodes, "texts": texts, "grid": 4,
}, timeout=400)
res = r.get("result") or {}
print("ok:", r.get("ok"), "| 元件:", len(res.get("nodesPlaced") or []),
      "| 失败:", res.get("nodesFailed"), "| 吸附:", len(res.get("snapped") or []))

r2 = call("look", {"page": PAGE, "project": PROJECT, "width": 1800}, timeout=220)
print("图:", (r2.get("result") or {}).get("imagePath"))
print("计数:", (r2.get("result") or {}).get("counts"))
c = call("check", {"page": PAGE, "project": PROJECT}, timeout=200)
cr = c.get("result") or {}
print("检查:", cr.get("verdict"), "|", cr.get("summary"))
for p in (cr.get("problems") or []):
    print("  问题:", p)
