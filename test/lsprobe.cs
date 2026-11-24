// 确认 LockingStep 有没有 Commit/Rollback/Dispose，以及构造失败时的表现。
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class LsProbe
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
            try { return System.Reflection.Assembly.LoadFrom(p); } catch { return null; }
        };
        return Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run()
    {
        Assembly dm = Assembly.LoadFrom(Path.Combine(Bin, "Eplan.EplApi.DataModelu.dll"));
        Type t = dm.GetType("Eplan.EplApi.DataModel.LockingStep");
        if (t == null) { Console.WriteLine("LockingStep NOT FOUND"); return 1; }
        Console.WriteLine("TYPE " + t.FullName + "  base=" + t.BaseType);
        foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
        {
            if (m.IsSpecialName) continue;
            Console.WriteLine("  M " + m.ReturnType.Name + " " + m.Name + "(" + ParamList(m) + ")");
        }
        foreach (ConstructorInfo c in t.GetConstructors())
            Console.WriteLine("  C .ctor(" + ParamList(c) + ")");
        foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            Console.WriteLine("  P " + p.PropertyType.Name + " " + p.Name);
        return 0;
    }

    private static string ParamList(MethodBase m)
    {
        var parts = new List<string>();
        foreach (ParameterInfo p in m.GetParameters())
            parts.Add(p.ParameterType.Name + (p.IsOut ? "&" : "") + " " + p.Name);
        return string.Join(", ", parts.ToArray());
    }
}
