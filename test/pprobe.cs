// 探 PropertyPlacement：让设备标识（-F4）真正显示在图上。
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class PProbe
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
        Assembly dm = Assembly.LoadFrom(Path.Combine(Bin, "Eplan.EplApi.DataModelu.dll"));
        string[] wanted = { "Graphics.PropertyPlacement", "Graphics.Placement", "Graphics.TextBase", "Graphics.Text", "Graphics.Line" };
        foreach (string full in wanted)
        {
            Type t = dm.GetType("Eplan.EplApi.DataModel." + full);
            if (t == null) { Console.WriteLine("=== " + full + " NOT FOUND ==="); continue; }
            Console.WriteLine("=== " + t.FullName + " : " + (t.BaseType == null ? "-" : t.BaseType.Name) + " ===");
            foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            {
                if (m.IsSpecialName) continue;
                var ps = new List<string>();
                foreach (ParameterInfo p in m.GetParameters()) ps.Add(p.ParameterType.Name + " " + p.Name);
                Console.WriteLine("   " + m.ReturnType.Name + " " + m.Name + "(" + string.Join(", ", ps.ToArray()) + ")");
            }
            foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                Console.WriteLine("   prop " + p.PropertyType.Name + " " + p.Name + " (set=" + (p.SetMethod != null) + ")");
        }
        return 0;
    }
}
