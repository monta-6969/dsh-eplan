// 反射看 SymbolReference 到底有没有「旋转」这一类成员。
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class RotProbe
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
        string[] wanted = { "SymbolReference", "Placement", "Function", "EplanObject" };
        foreach (string name in wanted)
        {
            Type t = dm.GetType("Eplan.EplApi.DataModel." + name);
            if (t == null) { Console.WriteLine("=== " + name + " NOT FOUND ==="); continue; }
            Console.WriteLine("=== " + t.FullName + " : " + (t.BaseType == null ? "-" : t.BaseType.Name) + " ===");
            foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                string mark = p.CanWrite ? " [set]" : "";
                Console.WriteLine("  P " + p.PropertyType.Name + " " + p.Name + mark);
            }
            foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                if (m.IsSpecialName) continue;
                var ps = new List<string>();
                foreach (ParameterInfo p in m.GetParameters()) ps.Add(p.ParameterType.Name + " " + p.Name);
                Console.WriteLine("  M " + m.ReturnType.Name + " " + m.Name + "(" + string.Join(", ", ps) + ")");
            }
        }
        return 0;
    }
}
