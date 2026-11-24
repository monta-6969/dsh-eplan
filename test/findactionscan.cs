// 把所有候选名直接丢给 ActionManager.FindAction，找出真实存在的动作。
//
// 上一步从 erx 里扫出 4 万多个 PascalCase 候选，但那是"字符串"，不是动作注册表。
// 这里用 FindAction 逐个验证，才是真的。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;

internal static class FindActionScan
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
            try { return System.Reflection.Assembly.LoadFrom(p); } catch { return null; }
        };
        return Run(args);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string[] args)
    {
        string filter = args.Length > 0 ? args[0].ToLowerInvariant() : "page";

        // 收集候选：erx 里所有 PascalCase 串 + 常见动作前缀组合。
        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(Bin, "*.erx"))
        {
            string text;
            try { text = ReadAsciiStrings(file); } catch { continue; }
            foreach (Match m in Regex.Matches(text, "[A-Z][A-Za-z0-9_]{3,40}"))
            {
                string word = m.Value;
                string lower = word.ToLowerInvariant();
                if (!lower.Contains(filter)) continue;
                names.Add(word);
            }
        }

        Console.WriteLine("候选 " + names.Count + " 个（含关键词 " + filter + "），开始 FindAction 验证…");

        var am = new Eplan.EplApi.ApplicationFramework.ActionManager();
        int hits = 0;
        foreach (string name in names)
        {
            try
            {
                Eplan.EplApi.ApplicationFramework.Action a = am.FindAction(name, true);
                if (a == null) continue;
                hits++;
                Console.WriteLine("  FOUND " + name);
            }
            catch { }
        }
        Console.WriteLine("\n真实存在 " + hits + " 个。");
        return 0;
    }

    private static string ReadAsciiStrings(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        StringBuilder sb = new StringBuilder(bytes.Length / 4);
        int run = 0;
        for (int i = 0; i < bytes.Length; i++)
        {
            byte b = bytes[i];
            if (b >= 0x20 && b < 0x7F) { sb.Append((char)b); run++; }
            else { if (run > 0) sb.Append('\n'); run = 0; }
        }
        return sb.ToString();
    }
}
