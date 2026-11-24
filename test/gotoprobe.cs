// 找出能让 EPLAN 界面跳到某一页的动作名。
//
// EPLAN 的界面跳转不是公开 API，是一堆内部 action。
// 这里批量试候选名字：ActionManager.FindAction 能判断动作是否存在。
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class GotoProbe
{
    private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";
    private static readonly HashSet<string> Tried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    private static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string n = e.Name.Split(',')[0];
            if (!Tried.Add(n)) return null;
            string p = Path.Combine(Bin, n + ".dll");
            if (!File.Exists(p)) return null;
            try { return Assembly.LoadFrom(p); } catch { return null; }
        };
        return Run(args);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string[] args)
    {
        string[] candidates = new string[]
        {
            "GotoPage", "GoToPage", "OpenPage", "ShowPage", "JumpToPage", "SelectPage",
            "PageNavigator", "GotoPageInEditor", "EditPage", "OpenPageInEditor",
            "ActivatePage", "NavigateToPage", "GotoPageNavigator", "DisplayPage",
            "OpenPageInNavigator", "PageOpen", "GotoPageNumber", "SetCurrentPage",
            "PageGoto", "NavigatePage", "Goto", "SelectPageInNavigator",
            "guiGotoPage", "GuiGotoPage", "GotoPageInView", "OpenPageInTree",
            "NavigateToGotoPage", "GotoPageDialog", "ShowPageInEditor",
        };

        var am = new Eplan.EplApi.ApplicationFramework.ActionManager();
        Console.WriteLine("### FindAction 探测 ###");
        int found = 0;
        foreach (string name in candidates)
        {
            Eplan.EplApi.ApplicationFramework.Action action = null;
            try
            {
                action = am.FindAction(name, true);
            }
            catch (Exception ex)
            {
                Console.WriteLine("  ? " + name + "  EX " + ex.GetType().Name);
                continue;
            }
            if (action == null) continue;
            found++;
            Console.WriteLine("  FOUND " + name + "  -> " + action.Name);
        }
        Console.WriteLine("命中 " + found + " / " + candidates.Length);
        return 0;
    }
}
