// 从 erx / 菜单配置里挖出所有像动作名的候选，输出成 JSON 数组，供 actions 工具批量探测。
//
// 为什么要在进程内探：ActionManager.FindAction 在 EPLAN 外面调用对任何名字都返回 null，
// 只有把候选名送进 EPLAN 进程里问才有意义。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class CollectCandidates
{
    private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";
    private const string Cfg = @"D:\EPLAN\Platform\2.9.4\Cfg";

    private static int Main(string[] args)
    {
        string outPath = args.Length > 0 ? args[0] : "candidates.json";
        string filter = args.Length > 1 ? args[1].ToLowerInvariant() : null;

        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);

        // 1. 二进制资源里的 PascalCase 串
        foreach (string file in Directory.GetFiles(Bin, "*.erx"))
            Harvest(file, names, true);

        // 2. 菜单/配置 XML 里的动作名（这些是**确实被菜单引用**的，命中率高得多）
        if (Directory.Exists(Cfg))
        {
            foreach (string file in Directory.GetFiles(Cfg, "*.xml"))
                Harvest(file, names, false);
        }

        List<string> sorted = new List<string>(names);
        if (filter != null)
            sorted = sorted.FindAll(delegate (string s) { return s.ToLowerInvariant().Contains(filter); });
        sorted.Sort(StringComparer.OrdinalIgnoreCase);

        StringBuilder sb = new StringBuilder();
        sb.Append('[');
        for (int i = 0; i < sorted.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"').Append(sorted[i].Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"');
        }
        sb.Append(']');
        File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false));

        Console.WriteLine("候选 " + sorted.Count + " 个 -> " + outPath);
        return 0;
    }

    private static void Harvest(string file, HashSet<string> names, bool binary)
    {
        string text;
        try
        {
            if (binary) text = ReadAsciiStrings(file);
            else text = File.ReadAllText(file);
        }
        catch { return; }

        foreach (Match m in Regex.Matches(text, "[A-Z][A-Za-z0-9_]{3,40}"))
        {
            string word = m.Value;
            if (!LooksLikeAction(word)) continue;
            names.Add(word);
        }
    }

    private static bool LooksLikeAction(string word)
    {
        if (word.Length < 5) return false;
        if (!char.IsUpper(word[0])) return false;
        int upper = 0;
        foreach (char c in word) if (char.IsUpper(c)) upper++;
        if (upper * 2 > word.Length) return false;
        return true;
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
