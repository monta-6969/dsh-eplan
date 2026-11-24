# -*- coding: utf-8 -*-
"""用 UI 自动化把 EPLAN 切到指定页。

思路：页导航器里双击页节点 = EPLAN 自己的「打开这一页」。
这比找内部 action 稳，因为它走的就是用户点鼠标的同一条路径。

依赖 uiautomation（pip install uiautomation），只用 GET/SET 和双击，不注入。
"""
import sys
import time

try:
    import uiautomation as auto
except ImportError:
    print("需要 uiautomation：pip install uiautomation")
    sys.exit(1)

PAGE_TITLE = sys.argv[1] if len(sys.argv) > 1 else "=MCP/2"


def find_eplan():
    win = auto.WindowControl(searchDepth=1, ClassName="EplanFrame")
    if not win.Exists(3):
        # 类名可能不同，退到按标题找
        win = auto.WindowControl(searchDepth=1, RegexName=r".*EPLAN Electric P8.*")
    if not win.Exists(3):
        return None
    return win


def dump_tree(win, depth=0, maxdepth=3):
    """把控件树打出来，找页导航器在哪。"""
    for child in win.GetChildren():
        indent = "  " * depth
        print("%s[%s] name=%r auto=%r" % (indent, child.ControlTypeName, child.Name[:60], child.AutomationId[:40]))
        if depth < maxdepth:
            dump_tree(child, depth + 1, maxdepth)


win = find_eplan()
if not win:
    print("找不到 EPLAN 窗口")
    sys.exit(1)

print("窗口:", win.Name)
print("树:")
dump_tree(win, 0, 2)
