// 只看类型：BoxedDevice 的继承链与成员，以及 Function 的连接点 API。
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class BoxProbe
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
        return Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run()
    {
        Assembly dm = Assembly.LoadFrom(Path.Combine(Bin, "Eplan.EplApi.DataModelu.dll"));
        Type box = dm.GetType("Eplan.EplApi.DataModel.BoxedDevice");
        Console.WriteLine("=== 继承链 ===");
        for (Type t = box; t != null; t = t.BaseType) Console.WriteLine("  " + t.FullName);
        Console.WriteLine();
        Dump(box);
        foreach (string name in new[] { "ConnectionPointPosition", "Function" })
        {
            Type t = dm.GetType("Eplan.EplApi.DataModel." + name);
            Console.WriteLine();
            Console.WriteLine("=== " + name + " ===");
            foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                Console.WriteLine("  P " + p.PropertyType.Name + " " + p.Name + (p.CanWrite ? " [set]" : ""));
            foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                string ps = "";
                foreach (ParameterInfo pi in m.GetParameters()) ps += pi.ParameterType.Name + " " + pi.Name + ", ";
                Console.WriteLine("  M " + m.ReturnType.Name + " " + m.Name + "(" + ps.TrimEnd(' ', ',') + ")");
            }
        }
        return 0;
    }

    private static void Dump(Type t)
    {
        Console.WriteLine("=== " + t.FullName + " 成员 ===");
        foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            Console.WriteLine("  P " + p.PropertyType.Name + " " + p.Name + (p.CanWrite ? " [set]" : ""));
        foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
        {
            string ps = "";
            foreach (ParameterInfo pi in m.GetParameters()) ps += pi.ParameterType.Name + " " + pi.Name + ", ";
            Console.WriteLine("  M " + m.ReturnType.Name + " " + m.Name + "(" + ps.TrimEnd(' ', ',') + ")");
        }
    }
}
