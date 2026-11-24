// 从 erx 里把 EPLAN 的动作名统统挖出来，再筛出和「页面跳转」有关的。
//
// EPLAN 的动作名是 C 字符串常量写在各个 .erx 里的，
// 所以直接在二进制里按可打印 ASCII 串扫，再按关键词过滤就够了。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class ErxActions
{
    private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";

    private static readonly string[] Keywords = new string[]
    {
        "page", "goto", "gotonavigate", "navigate", "navigator", "jump", "activate", "show", "open", "select", "view", "editor",
    };

    private static int Main(string[] args)
    {
        string filter = args.Length > 0 ? args[0].ToLowerInvariant() : null;

        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
        string[] files = Directory.GetFiles(Bin, "*.erx");
        Console.WriteLine("扫描 " + files.Length + " 个 erx …");

        foreach (string file in files)
        {
            string text;
            try { text = ReadAsciiStrings(file); }
            catch { continue; }

            foreach (Match m in Regex.Matches(text, "[A-Za-z][A-Za-z0-9_]{3,40}"))
            {
                string word = m.Value;
                if (!LooksLikeAction(word)) continue;
                names.Add(word);
            }
        }

        Console.WriteLine("候选动作名 " + names.Count + " 个\n");
        List<string> sorted = new List<string>(names);
        sorted.Sort(StringComparer.OrdinalIgnoreCase);

        int shown = 0;
        foreach (string name in sorted)
        {
            string lower = name.ToLowerInvariant();
            if (!lower.Contains("page")) continue;
            if (filter != null && !lower.Contains(filter)) continue;
            if ((lower.Contains("goto") || lower.Contains("navigat") || lower.Contains("open")
                 || lower.Contains("show") || lower.Contains("jump") || lower.Contains("activ"))
                && shown < 80)
            {
                Console.WriteLine("  " + name);
                shown++;
            }
        }
        Console.WriteLine("\n上面 " + shown + " 个是与跳转相关的。");
        return 0;
    }

    /// <summary>EPLAN 的动作名习惯是 PascalCase 且首字母大写，借此粗筛。</summary>
    private static bool LooksLikeAction(string word)
    {
        if (word.Length < 5) return false;
        if (!char.IsUpper(word[0])) return false;
        // 全大写的多半是常量/枚举值，动作名是 PascalCase。
        int upper = 0;
        foreach (char c in word) if (char.IsUpper(c)) upper++;
        if (upper * 2 > word.Length) return false;
        return true;
    }

    /// <summary>把文件里的可打印 ASCII 串拼起来（不是严格解析，够用）。</summary>
    private static string ReadAsciiStrings(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        StringBuilder sb = new StringBuilder(bytes.Length / 4);
        int run = 0;
        for (int i = 0; i < bytes.Length; i++)
        {
            byte b = bytes[i];
            if (b >= 0x20 && b < 0x7F)
            {
                sb.Append((char)b);
                run++;
            }
            else
            {
                if (run > 0) sb.Append('\n');
                run = 0;
            }
        }
        return sb.ToString();
    }
}
