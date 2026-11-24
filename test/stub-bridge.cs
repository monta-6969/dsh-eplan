// 离线测试用的桥接器替身：只认 op，不解析 JSON。
//
// 为什么需要它：present 的 job 语义（立刻返回 jobId、同页复用、wait 轮询）
// 和改页的占用门都发生在 server.mjs 里，跟 EPLAN 无关。用真 EPLAN 测要
// 挪窗口、可能撞模态框；用替身可以让 present 慢 1.5 秒，把「等不到」这条路
// 也走一遍。
//
// 编译：csc /nologo /target:exe /out:test\stub-bridge.exe test\stub-bridge.cs
// 环境变量：
//   STUB_OPEN_DELAY_MS  page_open 延迟（默认 0）
//   STUB_LOOK_DELAY_MS  look 延迟（默认 0）
using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;

internal static class StubBridge
{
    private const string OnePixelPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    private static int Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        string dir = Path.Combine(Path.GetTempPath(), "eplan-stub");
        Directory.CreateDirectory(dir);
        string png = Path.Combine(dir, "stub-page.png");
        if (!File.Exists(png)) File.WriteAllBytes(png, Convert.FromBase64String(OnePixelPng));

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            string id = Pick(line, "\"id\"\\s*:\\s*\"([^\"]+)\"");
            string op = Pick(line, "\"op\"\\s*:\\s*\"([^\"]+)\"");
            string result;

            switch (op)
            {
                case "page_open":
                    Sleep("STUB_OPEN_DELAY_MS");
                    result = "{\"ok\":true,\"page\":\"=STUB/1\",\"focusRequested\":true,\"visibleInTitle\":true}";
                    break;
                case "look":
                    Sleep("STUB_LOOK_DELAY_MS");
                    result = "{\"imagePath\":" + Quote(png) + ",\"counts\":{\"symbols\":2,\"wires\":1},\"renderMs\":7}";
                    break;
                case "pages":
                    result = "{\"pages\":[{\"name\":\"=STUB/1\",\"size\":[420,297]}]}";
                    break;
                case "page_create":
                    Sleep("STUB_CREATE_DELAY_MS");
                    result = "{\"page\":\"=STUB/1\",\"created\":true,\"nodes\":2}";
                    break;
                case "page_delete":
                    result = "{\"deleted\":true,\"page\":\"=STUB/1\"}";
                    break;
                case "props":
                    result = "{\"values\":{\"PAGE_COUNTER\":\"1\"}}";
                    break;
                default:
                    result = "{\"ok\":true,\"op\":" + Quote(op) + "}";
                    break;
            }

            Console.WriteLine("{\"id\":" + Quote(id) + ",\"ok\":true,\"result\":" + result + "}");
            Console.Out.Flush();
        }
        return 0;
    }

    private static void Sleep(string name)
    {
        int delay;
        string raw = Environment.GetEnvironmentVariable(name);
        if (raw != null && int.TryParse(raw, out delay) && delay > 0) Thread.Sleep(delay);
    }

    private static string Pick(string text, string pattern)
    {
        Match match = Regex.Match(text, pattern);
        return match.Success ? match.Groups[1].Value : string.Empty;
    }

    private static string Quote(string text)
    {
        return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
