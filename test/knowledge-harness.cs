// 知识库的离线测试：不需要 EPLAN，直接把 KnowledgeTool 编译进一个控制台程序跑。
//
// 为什么能这么测：KnowledgeTool 只依赖 Json + HostException，一个 EPLAN 类型都没碰
// （几何不落盘这条铁律的副产品）。所以语义库这条链路可以完全脱离 EPLAN 验证。
//
//   csc -target:exe -out:test\knowledge-harness.exe -r:System.dll ^
//       bridge\src\Json.cs host\src\KnowledgeTool.cs test\stub-eplan.cs test\knowledge-harness.cs
//   test\knowledge-harness.exe
using System;
using System.IO;
using EplanMcp;
using EplanMcpHost;

internal static class KnowledgeHarness
{
    private static int failures;

    private static void Check(string name, bool condition, string detail)
    {
        if (condition)
        {
            Console.WriteLine("  [PASS] " + name);
        }
        else
        {
            failures++;
            Console.WriteLine("  [FAIL] " + name + "  → " + detail);
        }
    }

    public static int Main()
    {
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }
        string file = KnowledgeTool.FilePath;
        if (File.Exists(file)) File.Delete(file);

        Console.WriteLine("知识库文件: " + file);
        Console.WriteLine();

        // 1) 写入，并且尝试夹带几何 —— 必须被拒收
        JsonValue annotateArgs = JsonValue.NewObject();
        annotateArgs.Set("symbol", "F1");
        annotateArgs.Set("library", "GB_symbol");
        annotateArgs.Set("concept", "单极熔断器");
        annotateArgs.Set("usage", "24V 支路保护");
        annotateArgs.Set("pins", "应该被拒收");
        JsonValue saved = KnowledgeTool.Annotate(annotateArgs);

        Check("写入成功", saved["saved"].AsBool(false), "saved 不是 true");
        Check("geometry 键被拒收", saved["ignoredGeometryKeys"].Count == 1,
            "ignoredGeometryKeys 数量 = " + saved["ignoredGeometryKeys"].Count);
        Check("默认来源是 derived", saved["entry"]["source"].AsString("") == "derived",
            "source = " + saved["entry"]["source"].AsString(""));

        // 2) 读回来
        JsonValue getArgs = JsonValue.NewObject();
        getArgs.Set("symbol", "F1");
        getArgs.Set("library", "GB_symbol");
        JsonValue got = KnowledgeTool.Get(getArgs);

        Check("能读到", got["known"].AsBool(false), "known = false");
        Check("概念读回一致", got["entry"]["concept"].AsString("") == "单极熔断器",
            "concept = " + got["entry"]["concept"].AsString(""));
        Check("固定提醒查几何", got["note"].AsString("").IndexOf("pins") >= 0, "note 里没提 pins");

        // 3) 文件里确实没有几何字段
        string raw = File.ReadAllText(file);
        Check("磁盘上没有 pins 字段", raw.IndexOf("\"pins\"") < 0, "文件里出现了 pins");

        // 4) verified 覆盖
        JsonValue verifyArgs = JsonValue.NewObject();
        verifyArgs.Set("symbol", "F1");
        verifyArgs.Set("library", "GB_symbol");
        verifyArgs.Set("verified", true);
        KnowledgeTool.Annotate(verifyArgs);
        JsonValue again = KnowledgeTool.Get(getArgs);
        Check("verified 写回", again["entry"]["source"].AsString("") == "verified",
            "source = " + again["entry"]["source"].AsString(""));
        Check("没传的字段保留", again["entry"]["concept"].AsString("") == "单极熔断器",
            "concept 被清空了");

        // 5) 关键词搜索
        JsonValue searchArgs = JsonValue.NewObject();
        searchArgs.Set("query", "熔断");
        JsonValue searched = KnowledgeTool.Get(searchArgs);
        int matched = (int)searched["matchedCount"].NumberValue;
        int total = (int)searched["total"].NumberValue;
        Check("关键词能搜到", matched == 1 && total >= 1, "matchedCount = " + matched + ", total = " + total);

        // 6) 不存在的符号
        JsonValue missingArgs = JsonValue.NewObject();
        missingArgs.Set("symbol", "NOT_A_SYMBOL");
        JsonValue missing = KnowledgeTool.Get(missingArgs);
        Check("没记录时 known=false", !missing["known"].AsBool(true), "known 不该是 true");

        // 7) 缺 symbol 时必须报错
        bool threw = false;
        try { KnowledgeTool.Annotate(JsonValue.NewObject()); }
        catch (HostException) { threw = true; }
        Check("缺 symbol 抛 BAD_ARGUMENT", threw, "没有抛异常");

        Console.WriteLine();
        Console.WriteLine(failures == 0 ? "知识库离线测试：全部通过" : "知识库离线测试：" + failures + " 项失败");
        return failures == 0 ? 0 : 1;
    }
}
