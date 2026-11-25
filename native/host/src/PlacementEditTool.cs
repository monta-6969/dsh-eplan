// 增量改页：移动 / 改名 / 删除单个对象。
//
// 为什么需要它：以前改一个标签或挪一个元件，只能删页重建整页（审计里同一页
// 被重建 6 次、其中三次输出字节级相同）。这三个动作在 API 里都只是一行赋值，
// 但 Location 和 Name 都不是「属性」，所以 props 工具改不了，必须单独做 op。
//
// 选对象：objectId（page_inspect 会返回）> deviceTag（Function.Name）> index
// （AllPlacements 下标，用于没有名字的文字/图形）。三选一，且必须唯一命中。
using System;
using System.Collections.Generic;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class PlacementEditTool
    {
        public static JsonValue Move(JsonValue args)
        {
            Page page;
            Placement target;
            Resolve(args, out page, out target);

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("type", target.GetType().Name);
            result.Set("from", Context.PointJson(target.Location));
            try { result.Set("objectId", target.ObjectIdentifier.ToString()); } catch { }

            JsonValue at = args["at"];
            JsonValue offset = args["offset"];
            PointD to;
            if (at != null && at.IsArray)
            {
                to = Context.Point(at, "at");
            }
            else if (offset != null && offset.IsArray)
            {
                PointD delta = Context.Point(offset, "offset");
                to = new PointD(target.Location.X + delta.X, target.Location.Y + delta.Y);
            }
            else
            {
                throw new HostException("BAD_ARGUMENT",
                    "要给 at [x, y]（绝对坐标）或 offset [dx, dy]（相对位移）。");
            }
            result.Set("to", Context.PointJson(to));

            bool dryRun = args["dryRun"].AsBool(false);
            result.Set("dryRun", dryRun);
            if (dryRun)
            {
                result.Set("moved", false);
                return result;
            }

            target.Location = to;
            result.Set("moved", true);
            return result;
        }

        public static JsonValue Relabel(JsonValue args)
        {
            Page page;
            Function function;
            ResolveFunction(args, out page, out function);

            string to = args["to"].AsString(null);
            if (string.IsNullOrEmpty(to))
                throw new HostException("BAD_ARGUMENT", "要给 to（新的设备标识），例如 \"-K2\"。");

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("from", function.Name);
            result.Set("to", to);
            try { result.Set("objectId", function.ObjectIdentifier.ToString()); } catch { }

            bool dryRun = args["dryRun"].AsBool(false);
            result.Set("dryRun", dryRun);
            if (dryRun)
            {
                result.Set("renamed", false);
                return result;
            }

            function.Name = to;
            result.Set("renamed", true);
            // 设备标识的文字是单独的 PropertyPlacement：有些项目里它跟着 Name 变，
            // 有些不会。所以改完必须重新出图确认，这一句写进结果里，别让人猜。
            result.Set("note", "改完请重新出图确认图上的标识文字也跟着变了；没变就用 page_edit action=\"draw_graphics\" 补。");
            return result;
        }

        public static JsonValue Delete(JsonValue args)
        {
            Page page;
            Placement target;
            Resolve(args, out page, out target);

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("type", target.GetType().Name);
            result.Set("from", Context.PointJson(target.Location));
            try { result.Set("objectId", target.ObjectIdentifier.ToString()); } catch { }

            bool dryRun = args["dryRun"].AsBool(false);
            result.Set("dryRun", dryRun);
            if (dryRun)
            {
                result.Set("deleted", false);
                return result;
            }

            target.Remove();
            result.Set("deleted", true);
            return result;
        }

        // ---------------------------------------------------------------
        // 定位
        // ---------------------------------------------------------------

        private static void Resolve(JsonValue args, out Page page, out Placement target)
        {
            JsonValue selector = args["selector"];
            if (selector == null || !selector.IsObject)
                throw new HostException("BAD_ARGUMENT", "缺少 selector（给 objectId / deviceTag / index 之一）。");

            page = Context.FindPage(
                selector["page"].AsString(args["page"].AsString(null)),
                selector["project"].AsString(args["project"].AsString(null)));

            List<Placement> matches = Match(page, selector);
            if (matches.Count == 0)
                throw new HostException("OBJECT_NOT_FOUND",
                    "页「" + page.Name + "」上没找到匹配的对象：" + Json.Write(selector) +
                    "。先用 page_inspect view=\"list\" 看 objectId / deviceTag。");
            if (matches.Count > 1)
                throw new HostException("OBJECT_AMBIGUOUS",
                    "匹配到 " + matches.Count + " 个对象，这次只改一个。请给更具体的 objectId。");
            target = matches[0];
        }

        private static void ResolveFunction(JsonValue args, out Page page, out Function function)
        {
            JsonValue selector = args["selector"];
            if (selector == null || !selector.IsObject)
                throw new HostException("BAD_ARGUMENT", "缺少 selector（给 deviceTag 或 objectId）。");

            page = Context.FindPage(
                selector["page"].AsString(args["page"].AsString(null)),
                selector["project"].AsString(args["project"].AsString(null)));

            string objectId = selector["objectId"].AsString(null);
            string deviceTag = selector["deviceTag"].AsString(null);

            Function found = null;
            Function[] functions = page.Functions;
            if (functions != null)
            {
                foreach (Function candidate in functions)
                {
                    if (!string.IsNullOrEmpty(objectId))
                    {
                        try
                        {
                            if (string.Equals(candidate.ObjectIdentifier.ToString(), objectId, StringComparison.OrdinalIgnoreCase))
                            {
                                found = candidate;
                                break;
                            }
                        }
                        catch { }
                    }
                    else if (!string.IsNullOrEmpty(deviceTag) &&
                             string.Equals(candidate.Name, deviceTag, StringComparison.OrdinalIgnoreCase))
                    {
                        found = candidate;
                        break;
                    }
                }
            }

            if (found == null)
                throw new HostException("OBJECT_NOT_FOUND",
                    "页「" + page.Name + "」上没有设备标识为「" + (deviceTag ?? objectId) + "」的 Function。");
            function = found;
        }

        private static List<Placement> Match(Page page, JsonValue selector)
        {
            string objectId = selector["objectId"].AsString(null);
            string deviceTag = selector["deviceTag"].AsString(null);
            int index = selector["index"].AsInt(-1);

            Placement[] all = page.AllPlacements;
            List<Placement> matches = new List<Placement>();

            if (index >= 0)
            {
                if (all == null || index >= all.Length)
                    throw new HostException("OBJECT_NOT_FOUND",
                        "index " + index + " 越界：这一页只有 " + (all == null ? 0 : all.Length) + " 个放置对象。");
                matches.Add(all[index]);
                return matches;
            }

            if (all == null) return matches;

            foreach (Placement placement in all)
            {
                if (!string.IsNullOrEmpty(objectId))
                {
                    try
                    {
                        if (string.Equals(placement.ObjectIdentifier.ToString(), objectId, StringComparison.OrdinalIgnoreCase))
                            matches.Add(placement);
                    }
                    catch { }
                    continue;
                }

                Function function = placement as Function;
                if (function != null && !string.IsNullOrEmpty(deviceTag) &&
                    string.Equals(function.Name, deviceTag, StringComparison.OrdinalIgnoreCase))
                {
                    matches.Add(placement);
                }
            }
            return matches;
        }
    }
}
