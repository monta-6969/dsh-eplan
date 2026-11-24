using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class SelProbe2
{
    private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";
    private static readonly HashSet<string> Tried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    private static int Main()
    {
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string n = e.Name.Split(',')[0];
            if (!Tried.Add(n)) return null;
            string p = Path.Combine(Bin, n + ".dll");
            if (!File.Exists(p)) return null;
            try { return Assembly.LoadFrom(p); } catch { return null; }
        };
        return Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run()
    {
        Assembly hes = Assembly.LoadFrom(Path.Combine(Bin, "Eplan.EplApi.HEServicesu.dll"));
        Type t = hes.GetType("Eplan.EplApi.HEServices.SelectionSet");
        Console.WriteLine("=== SelectionSet 全部成员（含非公开）===");
        BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        foreach (MethodInfo m in t.GetMethods(flags))
        {
            if (m.IsSpecialName) continue;
            var ps = new List<string>();
            foreach (ParameterInfo p in m.GetParameters()) ps.Add(p.ParameterType.Name + " " + p.Name);
            Console.WriteLine((m.IsPublic ? "  pub " : "  pri ") + m.ReturnType.Name + " " + m.Name + "(" + string.Join(", ", ps.ToArray()) + ")");
        }
        foreach (PropertyInfo p in t.GetProperties(flags))
            Console.WriteLine("  prop " + p.PropertyType.Name + " " + p.Name + " (set=" + (p.SetMethod != null) + ")");
        return 0;
    }
}
