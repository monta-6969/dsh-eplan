// check：把「这页画得规不规范」变成可验收的检查，而不是靠眼看。
//
// 为什么需要它：EPLAN 不会因为你摆错位置就报错。元件歪了、引脚没对齐、
// 设备标识重复、拿画笔画了条绿线冒充导线 —— 这些都能存盘、都能导出，
// 但在真正的电气设计里全是错的。这个工具把这类问题逐条挑出来。
using System;
using System.Collections.Generic;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class CheckTool
    {
        public static JsonValue Run(JsonValue args)
        {
            Page page = Context.FindPage(args["page"].AsString(null), args["project"].AsString(null));
            Project project = page.Project;

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("project", project.ProjectName);

            double grid = args["grid"].AsDouble(4.0);

            List<string> problems = new List<string>();
            List<string> warnings = new List<string>();
            List<string> info = new List<string>();

            // ── 1. 手绘线：draw 画出来的绿线不是电气连接，EPLAN 不会把它当导线 ──
            int handDrawn = 0;
            JsonValue handDrawnSample = JsonValue.NewArray();
            foreach (Placement placement in page.AllPlacements)
            {
                if (!(placement is Line)) continue;
                handDrawn++;
                if (handDrawnSample.Count < 6)
                {
                    Line line = (Line)placement;
                    handDrawnSample.Add(JsonValue.NewString(
                        "(" + line.StartPoint.X + "," + line.StartPoint.Y + ") → (" +
                        line.EndPoint.X + "," + line.EndPoint.Y + ")"));
                }
            }
            if (handDrawn > 0)
                problems.Add("有 " + handDrawn + " 条手绘线。红线应由符号引脚自动生成，手绘线不会形成连接关系。");

            // ── 2. 元件：设备标识、栅格、引脚 ──
            List<SymbolReference> symbols = new List<SymbolReference>();
            foreach (Placement placement in page.AllPlacements)
            {
                SymbolReference reference = placement as SymbolReference;
                if (reference != null) symbols.Add(reference);
            }

            Dictionary<string, int> tagCounts = new Dictionary<string, int>();
            JsonValue offGrid = JsonValue.NewArray();
            JsonValue noTag = JsonValue.NewArray();
            int pinTotal = 0;

            foreach (SymbolReference reference in symbols)
            {
                Function function = reference as Function;

                string tag = function == null ? null : function.Name;
                if (IsPlaceholderTag(tag))
                {
                    if (noTag.Count < 10)
                        noTag.Add(JsonValue.NewString(
                            "(" + reference.Location.X + "," + reference.Location.Y + ")"));
                }
                else
                {
                    if (!tagCounts.ContainsKey(tag)) tagCounts[tag] = 0;
                    tagCounts[tag]++;
                }

                double x = reference.Location.X;
                double y = reference.Location.Y;
                if (Math.Abs(x / grid - Math.Round(x / grid)) > 0.001 ||
                    Math.Abs(y / grid - Math.Round(y / grid)) > 0.001)
                {
                    if (offGrid.Count < 10)
                        offGrid.Add(JsonValue.NewString("(" + x + "," + y + ")"));
                }

                try
                {
                    PinBase[] pins = reference.GraphicalConnectionPoints;
                    if (pins != null) pinTotal += pins.Length;
                }
                catch { }
            }

            JsonValue duplicates = JsonValue.NewArray();
            foreach (KeyValuePair<string, int> pair in tagCounts)
            {
                if (pair.Value > 1)
                    duplicates.Add(JsonValue.NewString(pair.Key + " ×" + pair.Value));
            }
            if (duplicates.Count > 0)
                warnings.Add("设备标识重复：" + duplicates.Count + " 组。同一个设备分多个部件、或跨页引用时会这样；确认不是重复插入即可，不必为此重建整页。");

            if (offGrid.Count > 0)
                warnings.Add("有元件不在 " + grid + " mm 栅格上。EPLAN 靠栅格对齐，偏离后引脚对不上，红线连不出来。");

            // 没有设备标识不一定是错：T 节点、连接点这类纯结构符号本来就不该有编号。
            // 所以只作为信息报出来，让模型自己判断是不是漏了。
            if (noTag.Count > 0)
                info.Add("有 " + noTag.Count + " 个符号没有设备标识。T 节点 / 连接点属于正常情况；如果是器件，说明漏了编号。");

            // ── 3. 孤立引脚：同一坐标上没有别的引脚，就连不出线 ──
            Dictionary<string, int> pinAt = new Dictionary<string, int>();
            foreach (SymbolReference reference in symbols)
            {
                try
                {
                    PinBase[] pins = reference.GraphicalConnectionPoints;
                    if (pins == null) continue;
                    foreach (PinBase pin in pins)
                    {
                        string key = Math.Round(pin.Location.X, 2) + "|" + Math.Round(pin.Location.Y, 2);
                        if (!pinAt.ContainsKey(key)) pinAt[key] = 0;
                        pinAt[key]++;
                    }
                }
                catch { }
            }
            int shared = 0;
            foreach (KeyValuePair<string, int> pair in pinAt) if (pair.Value > 1) shared++;

            JsonValue resultSummary = JsonValue.NewObject();
            resultSummary.Set("symbols", symbols.Count);
            resultSummary.Set("pins", pinTotal);
            resultSummary.Set("sharedPinPoints", shared);
            resultSummary.Set("handDrawnLines", handDrawn);
            resultSummary.Set("distinctDeviceTags", tagCounts.Count);
            result.Set("summary", resultSummary);

            if (handDrawnSample.Count > 0) result.Set("handDrawnSample", handDrawnSample);
            if (offGrid.Count > 0) result.Set("offGridSample", offGrid);
            if (noTag.Count > 0) result.Set("noTagSample", noTag);
            if (duplicates.Count > 0) result.Set("duplicateTags", duplicates);

            JsonValue problemsJson = JsonValue.NewArray();
            foreach (string text in problems) problemsJson.Add(JsonValue.NewString(text));
            JsonValue warningsJson = JsonValue.NewArray();
            foreach (string text in warnings) warningsJson.Add(JsonValue.NewString(text));
            JsonValue infoJson = JsonValue.NewArray();
            foreach (string text in info) infoJson.Add(JsonValue.NewString(text));
            result.Set("info", infoJson);

            result.Set("problems", problemsJson);
            result.Set("warnings", warningsJson);
            result.Set("ok", problems.Count == 0);

            // 给模型一句结论，省得它自己从数字里推。
            string verdict;
            if (problems.Count == 0 && warnings.Count == 0)
                verdict = "这页没问题，可以交付。";
            else if (problems.Count == 0)
                verdict = "没有硬伤，但有 " + warnings.Count + " 处值得看一眼。";
            else
                verdict = "有 " + problems.Count + " 个必须修的问题。";
            result.Set("verdict", verdict);

            return result;
        }

        // EPLAN 对没有编号的连接点（DCP / CO / 中断点）返回的是结构分隔符本身，
        // 常见 "=+"、"+"、"-"。它们不是设备标识，不能算「同名重复」——
        // 8023dacf 里 11 个这样的占位符被误报成重复，害得整页重建过两次。
        private static bool IsPlaceholderTag(string tag)
        {
            if (string.IsNullOrEmpty(tag)) return true;
            string trimmed = tag.Trim();
            if (trimmed.Length == 0) return true;
            foreach (char c in trimmed)
            {
                if (c != '=' && c != '+' && c != '-') return false;
            }
            return true;
        }
    }
}
