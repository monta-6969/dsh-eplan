# -*- coding: utf-8 -*-
"""照视频画「24V 电源分配」页。

视频里的结构（页 2 JQR2623）：
    L24 0V 电源符号在顶部
      │
      ├──────┬──────┬──────┐        水平母线
      │      │      │      │
     -F4    -F5    -F6    -F7      四个熔断器
      │      │      │      │
    L24-1  L24-2  L24-3  L24-4     四路出线
      PLC用  变频和伺服用  步进电机用  输入输出用

坐标约定：A3 420x297 mm，原点在左下角，Y 轴向上。
"""
import sys

sys.path.insert(0, r"D:\静静\任务（干活的文件分类放这里）\eplan-mcp\tools")
from ipc_call import call

PROJECT = "test"
PAGE = sys.argv[1] if len(sys.argv) > 1 else "=MCP/4"

# ── 布局参数（mm）───────────────────────────────────────────────
BUS_Y = 225.0           # 水平母线高度
TOP_Y = 250.0           # L24/0V 符号高度
FUSE_Y = 195.0          # 熔断器高度
BOTTOM_Y = 115.0        # 出线末端
TEXT_Y = 85.0           # 底部说明文字

# 四条支路的 X 坐标
BRANCH_X = [120.0, 165.0, 210.0, 255.0]
TAGS = ["-F4", "-F5", "-F6", "-F7"]
OUTLETS = ["L24-1", "L24-2", "L24-3", "L24-4"]
NOTES = ["PLC用", "变频和伺服用", "步进电机用", "输入输出用"]

POWER_X = 190.0         # L24 与 0V 的位置（母线中点附近）


def line(x1, y1, x2, y2, width=0.2):
    return {"kind": "line", "from": [x1, y1], "to": [x2, y2], "width": width}


def text(x, y, s, height=2.5):
    return {"kind": "text", "at": [x, y], "text": s, "height": height}


# ── 1. 建页 ────────────────────────────────────────────────────
print("建页 %s ..." % PAGE)
r = call("page_create", {"name": PAGE, "type": "Circuit", "project": PROJECT})
if not r.get("ok"):
    print("  建页失败:", r.get("error"))
    raise SystemExit(1)
print("  ->", r["result"]["page"]["name"])

# ── 2. 画线条和文字 ────────────────────────────────────────────
items = []

# 电源引下：从 L24 到母线
items.append(line(POWER_X, TOP_Y - 4, POWER_X, BUS_Y))

# 水平母线
items.append(line(BRANCH_X[0], BUS_Y, BRANCH_X[-1], BUS_Y))

# 四条支路：母线 → 熔断器上方 → 熔断器下方 → 出线末端
for x in BRANCH_X:
    items.append(line(x, BUS_Y, x, FUSE_Y + 8))
    items.append(line(x, FUSE_Y - 8, x, BOTTOM_Y))

# 顶部电源标识
items.append(text(POWER_X - 4, TOP_Y + 1, "L24", 3.0))
items.append(text(POWER_X + 6, TOP_Y + 1, "0V", 3.0))

# 母线处电位标注（和视频一致：L24 / L3 这类）
items.append(text(POWER_X - 4, TOP_Y - 5.5, "L24", 2.0))
items.append(text(POWER_X + 6, TOP_Y - 5.5, "L3", 2.0))

# 出线编号
for x, name in zip(BRANCH_X, OUTLETS):
    items.append(text(x - 4.5, BOTTOM_Y - 7, name, 2.5))

# 底部用途说明
for x, note in zip(BRANCH_X, NOTES):
    items.append(text(x - 6.5, TEXT_Y, note, 2.5))

print("画 %d 个图元 ..." % len(items))
r = call("draw", {"page": PAGE, "project": PROJECT, "items": items})
if not r.get("ok"):
    print("  画线失败:", r.get("error"))
    raise SystemExit(1)
print("  -> 已创建", r["result"]["created"], "个")

# ── 3. 插熔断器 ────────────────────────────────────────────────
for x, tag in zip(BRANCH_X, TAGS):
    r = call("symbol_insert", {
        "page": PAGE,
        "project": PROJECT,
        "symbol": "F1",
        "library": "GB_symbol",
        "at": [x, FUSE_Y],
        "deviceTag": tag,
    })
    if r.get("ok"):
        print("  熔断器 %s @ x=%g  ok" % (tag, x))
    else:
        print("  熔断器 %s 失败: %s" % (tag, r.get("error", {}).get("message")))

print("\n完成。导出预览：")
r = call("export", {"page": PAGE, "project": PROJECT, "kind": "png",
                    "outDir": "D:/静静/临时文件/eplan_out"})
if r.get("ok"):
    for f in r["result"]["files"]:
        print("  ", f["path"])
