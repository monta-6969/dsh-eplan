// 找「把某页变成当前编辑页」的 API。
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

internal static class SelProbe
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
        foreach (string dll in new string[] { "Eplan.EplApi.DataModelu.dll", "Eplan.EplApi.HEServicesu.dll", "Eplan.EplApi.Guiu.dll", "Eplan.EplApi.Baseu.dll" })
        {
            Assembly asm;
            try { asm = Assembly.LoadFrom(Path.Combine(Bin, dll)); } catch { continue; }
            Type[] types;
            try { types = asm.GetTypes(); } catch { continue; }
            foreach (Type t in types)
            {
                if (!t.IsPublic) continue;
                if (t.Name.IndexOf("Select", StringComparison.OrdinalIgnoreCase) < 0 &&
                    t.Name.IndexOf("Focus", StringComparison.OrdinalIgnoreCase) < 0 &&
                    t.Name.IndexOf("Activ", StringComparison.OrdinalIgnoreCase) < 0) continue;
                Console.WriteLine("=== " + t.FullName + " (" + dll + ") ===");
                foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                {
                    if (m.IsSpecialName) continue;
                    var ps = new List<string>();
                    foreach (ParameterInfo p in m.GetParameters()) ps.Add(p.ParameterType.Name + " " + p.Name);
                    Console.WriteLine("   " + m.ReturnType.Name + " " + m.Name + "(" + string.Join(", ", ps.ToArray()) + ")");
                }
            }
        }
        return 0;
    }
}
