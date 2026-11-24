// 离线检查：宿主 DLL 能否被加载、Entry.Run 是否存在。
// 只做反射，不调用任何 EPLAN API，所以不会碰 EPLAN 进程。
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

internal static class HostCheck
{
    private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";
    private static readonly HashSet<string> Tried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    private static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string name = e.Name.Split(',')[0];
            if (!Tried.Add(name)) return null;
            string path = Path.Combine(Bin, name + ".dll");
            if (!File.Exists(path)) return null;
            try { return Assembly.LoadFrom(path); }
            catch { return null; }
        };

        string hostPath = args.Length > 0 ? args[0] : @"host\bin\EplanMcpHost.dll";
        if (!File.Exists(hostPath)) { Console.WriteLine("MISSING " + hostPath); return 1; }

        Assembly asm = Assembly.LoadFrom(Path.GetFullPath(hostPath));
        Console.WriteLine("LOADED " + asm.FullName);

        Type entry = asm.GetType("EplanMcpHost.Entry");
        if (entry == null) { Console.WriteLine("FAIL 找不到 EplanMcpHost.Entry"); return 2; }

        MethodInfo run = entry.GetMethod("Run");
        if (run == null) { Console.WriteLine("FAIL Entry 没有 Run 方法"); return 3; }
        Console.WriteLine("OK Entry.Run(" + run.GetParameters()[0].ParameterType.Name + ") -> " + run.ReturnType.Name);

        object instance = Activator.CreateInstance(entry);
        Console.WriteLine("OK 可实例化");

        // 逐个确认各个工具类型都在（不调用，只看类型存在）。
        string[] expected = { "Context", "Dispatcher", "StatusTool", "PagesTool", "PageCreateTool",
                              "DrawTool", "SymbolsTool", "SymbolInsertTool", "PropsTool", "ExportTool",
                              "DiagnoseTool", "HostException" };
        int missing = 0;
        foreach (string name in expected)
        {
            if (asm.GetType("EplanMcpHost." + name) == null) { Console.WriteLine("  缺少 " + name); missing++; }
        }
        Console.WriteLine(missing == 0 ? "OK 全部 " + expected.Length + " 个类型齐备" : "FAIL 缺 " + missing + " 个类型");
        return missing == 0 ? 0 : 4;
    }
}
