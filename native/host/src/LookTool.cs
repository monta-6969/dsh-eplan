// look：一次调用同时拿到「图」和「结构化描述」。
//
// 为什么要有它：
//   之前靠截屏 + UIAutomation 点按钮，既慢又脆（模态框一弹就卡死）。
//   EPLAN 自带渲染引擎 Export.GraphicPageEx 可以直接把页面渲染成位图，
//   不依赖窗口是否可见、是否被对话框挡住，也不需要模拟任何输入。
//   这是唯一「从软件内部拿渲染结果」的正路。
//
// 一次返回三样东西：
//   1. imagePath  —— EPLAN 渲染出来的 PNG，模型直接 read_image 就能看
//   2. 结构化汇总 —— 元件清单、坐标、符号名，纯文本可推理
//   3. 渲染元信息 —— 尺寸、像素宽、耗时，便于判断是否成功
//
// 用法：
//   look {"project":"test","page":"=MCP/4"}
//   look {"project":"test","page":"=MCP/4","width":3000}     更高分辨率
//   look {"project":"test","page":"=MCP/4","image":false}     只要结构化数据
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.MasterData;
using Eplan.EplApi.HEServices;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class LookTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string pageName = args["page"].AsString(null);
            string projectName = args["project"].AsString(null);
            int width = args["width"].AsInt(2000);
            if (width < 400) width = 400;
            if (width > 8000) width = 8000;
            bool wantImage = args["image"].AsBool(true);

            Page page = Context.FindPage(pageName, projectName);
            Project project = page.Project;

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("project", project.ProjectName);
            result.Set("pageType", page.PageType.ToString());

            JsonValue size = JsonValue.NewArray();
            size.Add(JsonValue.NewNumber(page.Size.X));
            size.Add(JsonValue.NewNumber(page.Size.Y));
            result.Set("pageSize", size);

            // ── 1. 用 EPLAN 自己的渲染引擎出图 ──────────────────────
            if (wantImage)
            {
                string outDir = args["outDir"].AsString(null);
                if (string.IsNullOrEmpty(outDir))
                    outDir = Path.Combine(Path.GetTempPath(), "eplan-mcp", "look");
                if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir);

                string file = outDir;
                // 注意：GraphicPageEx 的第二个参数是**输出目录**，不是文件名。
                // 传 "...\x.png" 时 EPLAN 会把 "...\x.png" 当成目录建出来，
                // 再把 <页名>.png 放进去（实测结果：...2400.png\=MCP_4.png）。
                // 所以这里直接给目录，用返回值拿真实路径。

                Stopwatch watch = Stopwatch.StartNew();
                Export service = new Export();
                string produced = null;
                try
                {
                    // GraphicPageEx 的返回值才是真正写出的路径；
                    // 传进去的 fileName 只是"建议"，EPLAN 可能自行改写（加序号、换扩展名）。
                    produced = service.GraphicPageEx(
                        page, file, Export.Format.PNG, 24, width, Export.Compression.None, false);
                }
                catch (Exception ex)
                {
                    throw new HostException("RENDER_FAILED",
                        "EPLAN 渲染这一页失败：" + ex.Message, ex.ToString());
                }
                finally
                {
                    try { service.Dispose(); } catch { }
                }
                watch.Stop();

                string actual = FirstExisting(produced, file);
                if (actual == null)
                {
                    // 有的版本不返回路径也不按建议名写，扫一下目录里最新的 png。
                    actual = NewestPng(outDir, watch);
                }
                if (actual == null)
                    throw new HostException("RENDER_EMPTY",
                        "EPLAN 报告渲染成功，但没有生成文件。建议路径：" + file +
                        "；返回值：" + (produced == null ? "(null)" : produced));

                // 导出永远是 EPLAN 的打印配色（白底/蓝符号），用户屏幕是深色方案，按像素换色。
                string theme = args["theme"].AsString("dark").ToLowerInvariant();
                if (theme == "dark")
                {
                    try { DarkScheme.Apply(actual); }
                    catch (Exception themeError) { result.Set("themeError", themeError.Message); }
                }
                result.Set("theme", theme);
                result.Set("imagePath", actual);
                result.Set("imageBytes", new FileInfo(actual).Length);
                result.Set("renderMs", watch.ElapsedMilliseconds);
                if (produced != null && produced.Length > 0) result.Set("engineReturned", produced);
            }

            // ── 2. 结构化描述 ────────────────────────────────────────
            JsonValue functions = JsonValue.NewArray();
            Function[] allFunctions = page.Functions;
            int functionCount = 0;
            if (allFunctions != null)
            {
                functionCount = allFunctions.Length;
                foreach (Function function in allFunctions)
                {
                    functions.Add(DescribeFunction(function));
                }
            }

            Placement[] placements = page.AllPlacements;
            int placementCount = placements == null ? 0 : placements.Length;

            JsonValue counts = JsonValue.NewObject();
            counts.Set("functions", functionCount);
            counts.Set("placements", placementCount);
            result.Set("counts", counts);
            result.Set("functions", functions);

            // ── 3. EPLAN 自动生成的连接（红线）─────────────────────
            result.Set("graphicalConnections", DescribeGraphicalConnections(page));

            return result;
        }

        private static JsonValue DescribeFunction(Function function)
        {
            JsonValue item = JsonValue.NewObject();
            try { item.Set("name", function.Name); } catch { }
            try { item.Set("type", function.GetType().Name); } catch { }

            try
            {
                JsonValue at = JsonValue.NewArray();
                at.Add(JsonValue.NewNumber(function.Location.X));
                at.Add(JsonValue.NewNumber(function.Location.Y));
                item.Set("at", at);
            }
            catch { }

            // 符号名在 SymbolVariant 上，SymbolReference 本身没有。
            SymbolReference reference = function as SymbolReference;
            if (reference != null)
            {
                try
                {
                    SymbolVariant variant = reference.SymbolVariant;
                    if (variant != null)
                    {
                        try { item.Set("symbol", variant.SymbolName); } catch { }
                        try { item.Set("variant", JsonValue.NewNumber(variant.VariantNr)); } catch { }
                    }
                }
                catch { }
            }
            return item;
        }

        /// <summary>
        /// 每个符号上的 GraphicalConnections 就是 EPLAN 画出来的那几条线。
        /// 它们不是页面上的放置对象，而是随符号渲染的，所以从 AllPlacements 里看不到。
        /// </summary>
        private static JsonValue DescribeGraphicalConnections(Page page)
        {
            JsonValue summary = JsonValue.NewObject();
            int total = 0;
            JsonValue samples = JsonValue.NewArray();

            Placement[] placements = page.AllPlacements;
            if (placements == null) return summary;

            foreach (Placement placement in placements)
            {
                SymbolReference reference = placement as SymbolReference;
                if (reference == null) continue;
                try
                {
                    IEnumerable connections = reference.GraphicalConnections as IEnumerable;
                    if (connections == null) continue;
                    foreach (object connection in connections)
                    {
                        if (connection == null) continue;
                        total++;
                        if (samples.Count < 40)
                        {
                            JsonValue item = JsonValue.NewObject();
                            item.Set("from", reference.GetType().Name);
                            try { item.Set("objectId", reference.ObjectIdentifier.ToString()); } catch { }
                            samples.Add(item);
                        }
                    }
                }
                catch { }
            }

            summary.Set("count", total);
            summary.Set("samples", samples);
            return summary;
        }

        /// <summary>优先用 EPLAN 返回的路径，其次用建议路径。</summary>
        private static string FirstExisting(string produced, string suggested)
        {
            if (!string.IsNullOrEmpty(produced) && File.Exists(produced)) return produced;
            if (!string.IsNullOrEmpty(suggested) && File.Exists(suggested)) return suggested;
            return null;
        }

        /// <summary>兜底：找渲染开始之后新出现的 png。</summary>
        private static string NewestPng(string dir, Stopwatch watch)
        {
            try
            {
                DateTime edge = DateTime.Now.AddSeconds(-Math.Max(5, watch.Elapsed.TotalSeconds + 5));
                string best = null;
                DateTime bestTime = DateTime.MinValue;
                foreach (string candidate in Directory.GetFiles(dir, "*.png"))
                {
                    DateTime time = File.GetLastWriteTime(candidate);
                    if (time < edge) continue;
                    if (time <= bestTime) continue;
                    bestTime = time;
                    best = candidate;
                }
                return best;
            }
            catch { return null; }
        }

        /// <summary>文件名里不能有 = + / 这类字符。</summary>
        private static string Safe(string name)
        {
            if (string.IsNullOrEmpty(name)) return "_";
            char[] bad = { '=', '+', '/', '\\', ':', '*', '?', '"', '<', '>', '|' };
            string value = name;
            foreach (char c in bad) value = value.Replace(c, '_');
            return value.Trim();
        }
    }
}
