// page_create：新建一页。
//
// EPLAN 的页名不是自由字符串，而是结构标识 + 计数器：
//   "=EB3+ET1/1"
//    └ =高层功能  └ +安装位置  └ /页号
// 所以要拆开写进 PagePropertyList，而不是直接赋 Name。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class PageCreateTool
    {
        // =EB3+ET1/1 ; 各段都可省略
        private static readonly Regex PageNamePattern = new Regex(
            @"^\s*(?:=(?<plant>[^+/]*))?(?:\+(?<location>[^+/]*))?/(?<counter>[0-9]+)?\s*$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        public static JsonValue Run(JsonValue args)
        {
            string name = args["name"].AsString(args["page"].AsString(null));
            string typeName = args["type"].AsString("Schematic");
            bool dryRun = args["dryRun"].AsBool(false);

            if (string.IsNullOrEmpty(name))
                throw new HostException("BAD_ARGUMENT", "缺少页名（name），例如 \"=EB3+ET1/1\"。");

            Match match = PageNamePattern.Match(name);
            if (!match.Success)
                throw new HostException("BAD_PAGE_NAME",
                    "页名格式不对：「" + name + "」。\n" +
                    "正确的写法是 =高层功能+安装位置/页号，例如 \"=EB3+ET1/1\"、" +
                    "\"=EB3/5\" 或 \"+ET1/3\"。");

            DocumentTypeManager.DocumentType docType = ParseDocumentType(typeName, name);
            Project project = Context.Resolve(args["project"].AsString(null));

            // 已经存在就报错，不要悄悄覆盖；append=true 时接着用已有的页。
            bool append = args["append"].AsBool(false);
            Page existingPage = null;
            foreach (Page existing in project.Pages)
            {
                if (string.Equals(existing.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    existingPage = existing;
                    break;
                }
            }
            if (existingPage != null && !append)
                throw new HostException("PAGE_EXISTS", "页「" + name + "」已经存在，换个页号，或传 append=true 接着往上画。");

            PagePropertyList parts = new PagePropertyList();
            string plant = match.Groups["plant"].Success ? match.Groups["plant"].Value : null;
            string location = match.Groups["location"].Success ? match.Groups["location"].Value : null;
            string counterText = match.Groups["counter"].Success ? match.Groups["counter"].Value : null;
            int counter = 1;
            if (counterText != null) int.TryParse(counterText, NumberStyles.Integer, CultureInfo.InvariantCulture, out counter);

            if (!string.IsNullOrEmpty(plant)) parts.DESIGNATION_PRODUCT = plant;
            if (!string.IsNullOrEmpty(location)) parts.DESIGNATION_PLACEOFINSTALLATION = location;
            parts.PAGE_COUNTER = counter;

            JsonValue result = JsonValue.NewObject();
            result.Set("requestedName", name);
            result.Set("plant", plant);
            result.Set("location", location);
            result.Set("counter", counter);
            result.Set("type", docType.ToString());
            result.Set("project", project.ProjectName);
            result.Set("dryRun", dryRun);

            // dryRun 也要把「打算摆哪些东西」一并报出来，否则用户没法审。
            JsonValue nodesArg = args["nodes"];
            JsonValue textsArg = args["texts"];
            int nodeCount = (nodesArg != null && nodesArg.IsArray) ? nodesArg.Count : 0;
            int textCount = (textsArg != null && textsArg.IsArray) ? textsArg.Count : 0;

            if (dryRun)
            {
                result.Set("created", false);
                result.Set("wouldCreate", true);
                result.Set("wouldPlace", JsonValue.NewNumber(nodeCount));
                result.Set("wouldWrite", JsonValue.NewNumber(textCount));
                return result;
            }


            Page page;
            bool created = existingPage == null;
            if (created)
            {
                page = new Page();
                page.Create(project, docType, parts);

                // 实测：只把结构属性写进 PagePropertyList，EPLAN 不一定会拿来拼页名
                // （创建出来的页可能是 "/1" 而不是 "=MCP/1"）。Page.Name 是可写的，
                // 创建后按用户给的完整名字改一次，保证落地的名字就是他要的。
                if (!string.Equals(page.Name, name, StringComparison.Ordinal))
                {
                    try
                    {
                        page.Name = name;
                    }
                    catch (Exception ex)
                    {
                        result.Set("renameWarning",
                            "页已创建，但改成「" + name + "」失败：" + ex.Message +
                            "。当前页名是「" + page.Name + "」。");
                    }
                }
            }
            else
            {
                page = existingPage;
            }

            result.Set("created", created);

            // ---------------------------------------------------------------
            // 一次性把整页摆完。
            //
            // 为什么要这样：单个 symbol_insert 一次只放一个符号，画一页要点十几次工具，
            // 每一次都是一轮模型往返（实测一次调用 EPLAN 侧只要 130 ms，而模型往返要几秒）。
            // 真正的成本不是机器，是往返次数。所以这里允许一次调用把节点和文字全给齐。
            //
            // 一个节点失败不影响其它节点：失败项收集到 nodesFailed 里统一报出来。
            // 这样一次调用能尽量多出活，而不是第一个坏符号就把整页废掉。
            // ---------------------------------------------------------------
            // 栅格吸附：EPLAN 靠栅格对齐引脚，坐标差 0.5 mm 红线就连不出来。
            // 与其让调用方每次自己算 4 的倍数，不如这里统一吸，并把改过的坐标报回去 ——
            // 报回去很重要，否则调用方以为自己给的就是最终位置。
            double grid = args["grid"].AsDouble(4.0);
            if (grid <= 0) grid = 4.0;
            JsonValue layout = args["layout"];
            JsonValue snapped = JsonValue.NewArray();

            if (nodeCount > 0)
            {
                JsonValue placedNodes = JsonValue.NewArray();
                JsonValue failedNodes = JsonValue.NewArray();
                for (int i = 0; i < nodeCount; i++)
                {
                    JsonValue node = nodesArg[i];
                    JsonValue nodeArgs = JsonValue.NewObject();
                    if (node != null && node.IsObject)
                    {
                        foreach (string key in node.Keys) nodeArgs.Set(key, node[key]);
                    }

                    // 先把 "列/行" 引用解析成坐标，后面的吸附逻辑就能统一处理。
                    JsonValue rawAt = nodeArgs["at"];
                    if (rawAt != null && rawAt.Kind == JsonKind.String)
                    {
                        double lx, ly;
                        string layoutError;
                        if (TryResolveLayoutPoint(rawAt, layout, out lx, out ly, out layoutError))
                        {
                            JsonValue resolved = JsonValue.NewArray();
                            resolved.Add(JsonValue.NewNumber(lx));
                            resolved.Add(JsonValue.NewNumber(ly));
                            nodeArgs.Set("at", resolved);
                            rawAt = resolved;
                        }
                        else
                        {
                            throw new HostException("BAD_LAYOUT", layoutError, "node #" + i);
                        }
                    }

                    if (rawAt != null && rawAt.IsArray && rawAt.Count >= 2)
                    {
                        double rx = rawAt[0].AsDouble(double.NaN);
                        double ry = rawAt[1].AsDouble(double.NaN);
                        if (!double.IsNaN(rx) && !double.IsNaN(ry))
                        {
                            double sx = Math.Round(rx / grid) * grid;
                            double sy = Math.Round(ry / grid) * grid;
                            if (Math.Abs(sx - rx) > 1e-9 || Math.Abs(sy - ry) > 1e-9)
                            {
                                JsonValue fixedPoint = JsonValue.NewArray();
                                fixedPoint.Add(JsonValue.NewNumber(sx));
                                fixedPoint.Add(JsonValue.NewNumber(sy));
                                nodeArgs.Set("at", fixedPoint);

                                JsonValue entry = JsonValue.NewObject();
                                entry.Set("index", JsonValue.NewNumber(i));
                                entry.Set("symbol", nodeArgs["symbol"]);
                                entry.Set("from", rawAt);
                                entry.Set("to", fixedPoint);
                                snapped.Add(entry);
                            }
                        }
                    }
                    nodeArgs.Set("page", page.Name);
                    nodeArgs.Set("project", project.ProjectName);
                    if (nodeArgs["library"].AsString(null) == null)
                        nodeArgs.Set("library", "GB_symbol");
                    try
                    {
                        JsonValue one = SymbolInsertTool.Run(nodeArgs);
                        JsonValue brief = JsonValue.NewObject();
                        brief.Set("index", JsonValue.NewNumber(i));
                        brief.Set("symbol", one["symbol"]);
                        brief.Set("at", one["at"]);
                        brief.Set("deviceTag", one["deviceTag"]);
                        placedNodes.Add(brief);
                    }
                    catch (Exception ex)
                    {
                        JsonValue failure = JsonValue.NewObject();
                        failure.Set("index", JsonValue.NewNumber(i));
                        failure.Set("symbol", node == null ? null : node["symbol"]);
                        failure.Set("at", node == null ? null : node["at"]);
                        failure.Set("error", DescribeError(ex));
                        failedNodes.Add(failure);
                    }
                }
                result.Set("nodesPlaced", placedNodes);
                result.Set("nodesFailed", failedNodes);
            }

            if (snapped.Count > 0) result.Set("snapped", snapped);

            if (textCount > 0)
            {
                JsonValue drawArgs = JsonValue.NewObject();
                drawArgs.Set("page", page.Name);
                drawArgs.Set("project", project.ProjectName);
                JsonValue items = JsonValue.NewArray();
                for (int i = 0; i < textCount; i++)
                {
                    JsonValue text = textsArg[i];
                    JsonValue item = JsonValue.NewObject();
                    item.Set("kind", "text");
                    if (text != null && text.IsObject)
                    {
                        foreach (string key in text.Keys) item.Set(key, text[key]);
                    }

                    JsonValue textAt = item["at"];
                    if (textAt != null && textAt.Kind == JsonKind.String)
                    {
                        double lx, ly;
                        string layoutError;
                        if (!TryResolveLayoutPoint(textAt, layout, out lx, out ly, out layoutError))
                            throw new HostException("BAD_LAYOUT", layoutError, "text #" + i);
                        JsonValue resolved = JsonValue.NewArray();
                        resolved.Add(JsonValue.NewNumber(lx));
                        resolved.Add(JsonValue.NewNumber(ly));
                        item.Set("at", resolved);
                    }
                    items.Add(item);
                }
                drawArgs.Set("items", items);
                try
                {
                    JsonValue drawn = DrawTool.Run(drawArgs);
                    result.Set("textsWritten", drawn["created"]);
                }
                catch (Exception ex)
                {
                    result.Set("textsFailed", DescribeError(ex));
                }
            }

            result.Set("page", Describe(page));

            // 记一笔，好在事后撤回。往已有页追加（append=true）时不能记「删掉这页」——
            // 那会把用户本来就有的页连同内容一起删掉，比不改还糟。
            if (args["append"].AsBool(false))
            {
                OpJournal.Append("page_create", page.Project.ProjectName, page.Name, null, false,
                    "这是往已有页上追加内容，回退会把用户原有的页一起删掉，所以不记录回退方式。");
            }
            else
            {
                JsonValue undo = JsonValue.NewObject();
                undo.Set("kind", "delete_page");
                undo.Set("page", page.Name);
                OpJournal.Append("page_create", page.Project.ProjectName, page.Name, undo, true, null);
            }

            return result;

        }



        // ---------------------------------------------------------------
        // 声明式布局：把「算坐标」从调用方手里拿走。
        //
        // 手写绝对坐标是最容易出错的一步：改一个器件的 y，整列都要跟着改；
        // 算错 4 mm 红线就连不出来，而且错了很难看出来。
        // 所以允许 at 写成 "列/行" 的引用：
        //
        //   "layout": { "columns": [60, 100, 140], "rows": { "in": 264, "bus": 180 } }
        //   "at": "0/bus"     →  (columns[0], rows["bus"]) = (60, 180)
        //   "at": "2/1"       →  (columns[2], rows[1])     = (140, rows[1])
        //
        // 列只能按下标取（列本身没有名字），行既可以是对象（按名）也可以是数组（按下标）。
        // 写错了不静默兜底，抛出来 —— 布局写错却画出个东西，比报错难查得多。
        // ---------------------------------------------------------------
        private static bool TryResolveLayoutPoint(JsonValue expr, JsonValue layout, out double x, out double y, out string error)
        {
            x = 0; y = 0; error = null;
            if (expr == null || !(expr.Kind == JsonKind.String)) return false;
            if (layout == null || !layout.IsObject)
            {
                error = "用了 \"" + expr.AsString("") + "\" 这种布局引用，但没给 layout。";
                return false;
            }

            string text = expr.AsString("").Trim();
            string[] parts = text.Split('/');
            if (parts.Length != 2)
            {
                error = "布局引用要写成 \"列/行\"，例如 \"0/bus\"；收到的是 \"" + text + "\"。";
                return false;
            }

            JsonValue columns = layout["columns"];
            JsonValue rows = layout["rows"];

            double colValue;
            if (!ResolveAxis(columns, parts[0], true, out colValue, out error))
            {
                error = "列 \"" + parts[0] + "\"：" + error;
                return false;
            }

            double rowValue;
            if (!ResolveAxis(rows, parts[1], false, out rowValue, out error))
            {
                error = "行 \"" + parts[1] + "\"：" + error;
                return false;
            }

            x = colValue;
            y = rowValue;
            return true;
        }

        /// <summary>取一个轴上的值：数组按下标，对象按名字。</summary>
        private static bool ResolveAxis(JsonValue axis, string key, bool indexOnly, out double value, out string error)
        {
            value = 0; error = null;
            if (axis == null || axis.IsNull)
            {
                error = "layout 里没有 " + (indexOnly ? "columns" : "rows") + "。";
                return false;
            }

            if (axis.IsObject)
            {
                if (indexOnly)
                {
                    error = "列只能用下标（columns 是数组），不能按名字取。";
                    return false;
                }
                JsonValue named = axis[key];
                if (named == null || named.IsNull)
                {
                    // 把现有名字报出来。只写「没有这个名称」等于让调用方盲猜 ——
                    // 而它下一句就得再猜一次，多一次往返。
                    System.Text.StringBuilder available = new System.Text.StringBuilder();
                    foreach (string name in axis.Keys)
                    {
                        if (available.Length > 0) available.Append(" / ");
                        available.Append(name);
                    }
                    error = "没有这个名称。可用的是：" + (available.Length == 0 ? "(空)" : available.ToString()) +
                            "。也可以把 rows 写成数组来用下标。";
                    return false;
                }
                value = named.AsDouble(double.NaN);
                if (double.IsNaN(value))
                {
                    error = "这个名称对应的不是数字。";
                    return false;
                }
                return true;
            }

            if (axis.IsArray)
            {
                int index;
                if (!int.TryParse(key, out index))
                {
                    error = "要按下标取（数组），给的是名字。";
                    return false;
                }
                if (index < 0 || index >= axis.Count)
                {
                    error = "下标越界，只有 " + axis.Count + " 个。";
                    return false;
                }
                value = axis[index].AsDouble(double.NaN);
                if (double.IsNaN(value))
                {
                    error = "这个下标对应的不是数字。";
                    return false;
                }
                return true;
            }

            error = "既不是数组也不是对象。";
            return false;
        }

        /// <summary>把异常整理成给人看的一小段，宿主异常带错误码。</summary>
        private static JsonValue DescribeError(Exception ex)
        {
            JsonValue item = JsonValue.NewObject();
            HostException host = ex as HostException;
            item.Set("code", host != null ? host.Code : ex.GetType().Name);
            item.Set("message", ex.Message);
            return item;
        }

        private static JsonValue Describe(Page page)
        {
            JsonValue item = JsonValue.NewObject();
            item.Set("name", page.Name);
            item.Set("identifyingName", page.IdentifyingName);
            item.Set("type", page.PageTypeName);
            try
            {
                JsonValue size = JsonValue.NewArray();
                size.Add(JsonValue.NewNumber(page.Size.X));
                size.Add(JsonValue.NewNumber(page.Size.Y));
                item.Set("size", size);
            }
            catch { }
            return item;
        }

        private static DocumentTypeManager.DocumentType ParseDocumentType(string text, string originalName)
        {
            if (string.IsNullOrEmpty(text)) return DocumentTypeManager.DocumentType.Circuit;
            switch (text.Trim().ToLowerInvariant())
            {
                case "schematic":
                case "circuit":
                case "原理图":
                    return DocumentTypeManager.DocumentType.Circuit;
                case "overview":
                case "总览":
                    return DocumentTypeManager.DocumentType.Overview;
                case "panel":
                case "panellayout":
                case "布局图":
                    return DocumentTypeManager.DocumentType.PanelLayout;
                case "singleline":
                case "circuitsingleline":
                case "单线图":
                    return DocumentTypeManager.DocumentType.CircuitSingleLine;
                case "fluid":
                case "circuitfluid":
                case "流体图":
                    return DocumentTypeManager.DocumentType.CircuitFluid;
                case "graphics":
                case "图形":
                    return DocumentTypeManager.DocumentType.Graphics;
                case "title":
                case "titlepage":
                case "封面":
                    return DocumentTypeManager.DocumentType.TitlePage;
                default:
                    throw new HostException("BAD_ARGUMENT",
                        "不认识的页类型「" + text + "」。可用：schematic / overview / panel / singleline / fluid / graphics / title。");
            }
        }

        /// <summary>
        /// 删一页。用途：清理试画留下的过程页，别让用户的页树里堆一堆垃圾。
        ///
        /// 只删整页，不动页里的单个对象；页不存在时直接报 PAGE_NOT_FOUND，不静默成功。
        /// </summary>
        public static JsonValue Delete(JsonValue args)
        {
            string name = args["name"].AsString(args["page"].AsString(null));
            if (string.IsNullOrEmpty(name))
                throw new HostException("BAD_ARGUMENT", "缺少页名（name）。");

            Page page = Context.FindPage(name, args["project"].AsString(null));
            string projectName = page.Project.ProjectName;
            string pageName = page.Name;
            int functions = page.Functions == null ? 0 : page.Functions.Length;

            if (args["dryRun"].AsBool(false))
            {
                JsonValue plan = JsonValue.NewObject();
                plan.Set("page", pageName);
                plan.Set("project", projectName);
                plan.Set("wouldRemoveFunctions", JsonValue.NewNumber(functions));
                plan.Set("dryRun", true);
                return plan;
            }

            page.Remove();

            JsonValue result = JsonValue.NewObject();
            result.Set("page", pageName);
            result.Set("project", projectName);
            result.Set("removedFunctions", JsonValue.NewNumber(functions));
            result.Set("removed", true);

            // 删页不可回退：删之前没留快照，事后没有任何办法把那页复原。
            // 与其假装能撤，不如在历史里写清楚，让调用方知道这次操作是单向的。
            OpJournal.Append("page_delete", projectName, pageName, null, false,
                "删除页面没有留快照，撤回不了。要保留内容请事先用 export 导出该页。");

            return result;
        }

    }
}
