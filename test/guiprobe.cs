// 探 EPLAN 的「把某页显示出来」能力。
//
// 目标：让用户在 EPLAN 窗口里实时看到我在改哪一页。
// 思路有三条，一次全查：
//   1. ActionManager 能不能枚举动作名（找一个"打开页/跳转页"的动作）
//   2. Gui 程序集里有没有 CommandLineInterpreter / PageNavigator
//   3. SelectionSet 能不能选中并跳转
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class GuiProbe
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
        // ── 1. ActionManager：能不能列出所有动作名 ──
        Assembly af = Assembly.LoadFrom(Path.Combine(Bin, "Eplan.EplApi.AFu.dll"));
        Console.WriteLine("### AF 里带 Action 的类型 ###");
        foreach (Type t in af.GetTypes())
        {
            if (t.Name.IndexOf("Action", StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (!t.IsPublic) continue;
            Console.WriteLine("  " + t.FullName);
        }

        Type am = af.GetType("Eplan.EplApi.ApplicationFramework.ActionManager");
        if (am != null)
        {
            Console.WriteLine("\n### ActionManager 公开成员 ###");
            foreach (MethodInfo m in am.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            {
                if (m.IsSpecialName) continue;
                Console.WriteLine("  " + m.ReturnType.Name + " " + m.Name + "(" + Params(m) + ")");
            }
            foreach (PropertyInfo p in am.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                Console.WriteLine("  P " + p.PropertyType.Name + " " + p.Name);
        }

        // ── 2. Gui 程序集 ──
        Assembly gui = Assembly.LoadFrom(Path.Combine(Bin, "Eplan.EplApi.Guiu.dll"));
        Console.WriteLine("\n### Gui 里的公开类型 ###");
        foreach (Type t in gui.GetTypes())
        {
            if (!t.IsPublic) continue;
            Console.WriteLine("  " + t.FullName);
        }

        Type cli = gui.GetType("Eplan.EplApi.Gui.CommandLineInterpreter");
        if (cli != null)
        {
            Console.WriteLine("\n### CommandLineInterpreter ###");
            foreach (MethodInfo m in cli.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            {
                if (m.IsSpecialName) continue;
                Console.WriteLine("  " + m.ReturnType.Name + " " + m.Name + "(" + Params(m) + ")");
            }
        }

        return 0;
    }

    private static string Params(MethodBase m)
    {
        var parts = new List<string>();
        foreach (ParameterInfo p in m.GetParameters())
            parts.Add(p.ParameterType.Name + (p.IsOut ? "&" : "") + " " + p.Name);
        return string.Join(", ", parts.ToArray());
    }
}
