// pages：列出页面，确认目标页存在、名字没写错。
using System;
using System.Collections.Generic;
using System.Globalization;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class PagesTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string filter = args["filter"].AsString(null);
            int limit = args["limit"].AsInt(100);
            if (limit <= 0) limit = 100;
            bool includePlacements = args["includePlacements"].AsBool(false);

            Project project = Context.Resolve(args["project"].AsString(null));
            Page[] pages = project.Pages;
            if (pages == null) pages = new Page[0];

            List<Page> matched = new List<Page>();
            int total = 0;
            foreach (Page page in pages)
            {
                total++;
                if (filter != null && filter.Length > 0)
                {
                    string name = page.Name ?? string.Empty;
                    string ident = page.IdentifyingName ?? string.Empty;
                    if (name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0
                        && ident.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0)
                        continue;
                }
                matched.Add(page);
            }

            // 按页名排序，结果稳定、便于模型比对。
            matched.Sort(delegate (Page a, Page b)
            {
                return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
            });

            JsonValue result = JsonValue.NewObject();
            result.Set("project", project.ProjectName);
            result.Set("totalPages", total);
            result.Set("matchedCount", matched.Count);

            JsonValue list = JsonValue.NewArray();
            int emitted = 0;
            foreach (Page page in matched)
            {
                if (emitted >= limit) break;
                emitted++;

                JsonValue item = JsonValue.NewObject();
                item.Set("name", page.Name);
                item.Set("identifyingName", page.IdentifyingName);
                item.Set("type", page.PageTypeName);
                try { item.Set("size", PageSizeJson(page)); }
                catch { }

                if (includePlacements)
                {
                    try
                    {
                        Placement[] placements = page.AllPlacements;
                        item.Set("placementCount", placements == null ? 0 : placements.Length);
                        int functions = 0;
                        if (page.Functions != null) functions = page.Functions.Length;
                        item.Set("functionCount", functions);
                    }
                    catch (Exception ex)
                    {
                        item.Set("placementError", ex.Message);
                    }
                }
                list.Add(item);
            }
            result.Set("pages", list);
            if (matched.Count > emitted) result.Set("truncated", true);
            return result;
        }

        private static JsonValue PageSizeJson(Page page)
        {
            Eplan.EplApi.Base.PointD size = page.Size;
            JsonValue array = JsonValue.NewArray();
            array.Add(JsonValue.NewNumber(size.X));
            array.Add(JsonValue.NewNumber(size.Y));
            return array;
        }
    }
}
