# -*- coding: utf-8 -*-
"""用真正的 EPLAN 符号搭 24V 电源分配页，让 EPLAN 自己画红线。

关键认识（用户指出来的）：
  红色连接线不是画出来的，是 EPLAN 根据「连接点是否对齐、是否面对面」
  自动生成的。所以这一页一个 Graphics.Line 都不画，只摆符号和文字。

几何依据（symbol_info 实测，单位 mm，坐标是相对符号原点的偏移）：
  CO    v0 [Right(0,0), Down(0,0)]   v3 [Left(0,0), Down(0,0)]
  TLRU  v8 [Right(0,0), Left(0,0), Down(0,0)]      ← 用户截图里的 T 节点
  TOUR  v0 [Down(0,0), Up(0,0), Right(2,0)]        ← 带上支路的 T 节点
  F1    [Up(0,+4), Down(0,-4)]                     ← 熔断器（8 mm 高，符号库里就这么大）
  CDPST [Up(0,+4), Down(0,-4)]                     ← 电源引入点

布局：
  总线 y=236，支路 x = 72 / 116 / 160 / 204
  同一竖直线上、朝向相对的两个引脚之间，EPLAN 自动补红线。
"""
import sys

sys.path.insert(0, r"D:\静静\任务（干活的文件分类放这里）\eplan-mcp\tools")
from ipc_call import call

PAGE = "=MCP/8"
PRJ = "test"
XS = [72, 116, 160, 204]
Y_BUS = 236
Y_FUSE = 200


def must(rep, what):
    if not rep.get("ok"):
        err = rep.get("error") or {}
        raise SystemExit("%s 失败: %s %s" % (what, err.get("code"), err.get("message")))
    return rep.get("result") or {}


def sym(symbol, at, variant=0, tag=None, lib="SPECIAL"):
    args = {
        "page": PAGE, "project": PRJ, "library": lib, "symbol": symbol,
        "variant": variant, "at": at, "showDeviceTag": bool(tag),
    }
    if tag:
        args["deviceTag"] = tag
    return must(call("symbol_insert", args), "插 %s@%s" % (symbol, at))


# ── 先看看各候选熔断器符号有多大 ─────────────────────────────
info = call("symbol_info", {"library": "GB_symbol", "project": PRJ,
                            "symbols": ["F1", "FA1", "FA2", "FS", "FT1", "F_AB_1P", "F_SNH_1P"]},
            timeout=150)
if info.get("ok"):
    for s in info["result"]["symbols"]:
        if s.get("error"):
            continue
        pts = [(tuple(p.get("location") or []), p.get("direction"))
               for p in ((s.get("variants") or [{}])[0].get("points") or [])]
        if pts:
            span = max(abs(p[0][1]) for p in pts if p[0]) if any(p[0] for p in pts) else 0
            print("  %-10s 半高=%-4s %s" % (s["name"], span, pts[:4]))

print("建页", PAGE)
must(call("page_create", {"name": PAGE, "type": "Circuit", "project": PRJ}), "建页")

# ── 电源引入：L24 有引下线，0V 只是电位标记（和视频一致）──────
sym("CDPST", [XS[0], Y_BUS + 16], tag="L24")
sym("CDPST", [XS[0] + 16, Y_BUS + 16], tag="0V")

# ── 总线 ────────────────────────────────────────────────────
sym("TOUR", [XS[0], Y_BUS], variant=0)          # 左端：Up(接引入) + Down(支路1) + Right(总线)
sym("TLRU", [XS[1], Y_BUS], variant=8)          # 中间 T 节点
sym("TLRU", [XS[2], Y_BUS], variant=8)
sym("CO", [XS[3], Y_BUS], variant=3)            # 右端转角：Left + Down

# ── 四条支路上的熔断器 ──────────────────────────────────────
for x, tag in zip(XS, ["-F4", "-F5", "-F6", "-F7"]):
    sym("F1", [x, Y_FUSE], tag=tag, lib="GB_symbol")

# ── 文字标注 ────────────────────────────────────────────────
texts = []
for i, x in enumerate(XS):
    texts.append({"at": [x - 5, Y_FUSE - 22], "text": "L24-%d" % (i + 1), "height": 2.5})
for x, name in zip(XS, ["PLC用", "变频和伺服用", "步进电机用", "输入输出用"]):
    texts.append({"at": [x - 8, Y_FUSE - 36], "text": name, "height": 2.5})

must(call("draw", {"page": PAGE, "project": PRJ,
                   "items": [dict(t, kind="text") for t in texts]}), "写字")

print("渲染检查 ...")
result = must(call("look", {"page": PAGE, "project": PRJ, "width": 2200}), "渲染")
print("image:", result.get("imagePath"))
print("counts:", result.get("counts"))
print("functions:", [(f.get("name"), f.get("symbol")) for f in result.get("functions", [])])
