// draw：在一页上批量画线、矩形、文本、折线。
// 支持 dryRun：只回方案不落图。失败时把本次已创建的图元删掉，不留半成品。
using System;
using System.Collections.Generic;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class DrawTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string pageName = args["page"].AsString(null);
            JsonValue items = args["items"];
            bool dryRun = args["dryRun"].AsBool(false);

            if (items == null || !items.IsArray || items.Count == 0)
                throw new HostException("BAD_ARGUMENT", "items 必须是非空数组。");

            Page page = Context.FindPage(pageName, args["project"].AsString(null));

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("dryRun", dryRun);
            result.Set("requestedCount", items.Count);

            List<JsonValue> planned = new List<JsonValue>();
            List<Placement> created = new List<Placement>();

            for (int i = 0; i < items.Count; i++)
            {
                JsonValue item = items[i];
                string kind = item["kind"].AsString("");
                JsonValue description = DescribeItem(kind, item, i);
                planned.Add(description);
                if (!description["valid"].AsBool(false)) continue;
                if (dryRun) continue;

                try
                {
                    created.Add(CreateOne(page, kind, item));
                }
                catch (Exception ex)
                {
                    // 回滚已创建的部分，避免留下半成品。
                    Rollback(created);
                    throw new HostException("DRAW_FAILED",
                        "第 " + (i + 1) + " 个图元（" + kind + "）绘制失败：" + ex.Message +
                        "。已回滚本次画出的 " + created.Count + " 个图元。",
                        ex.ToString());
                }
            }

            // 校验：有没有非法项。
            foreach (JsonValue d in planned)
            {
                if (!d["valid"].AsBool(false))
                {
                    if (!dryRun) Rollback(created);
                    result.Set("items", ToArray(planned));
                    result.Set("created", 0);
                    throw new HostException("BAD_ARGUMENT",
                        "有坐标或参数不合法的图元：" + Json.Write(d));
                }
            }

            result.Set("items", ToArray(planned));
            result.Set("created", created.Count);
            result.Set("boundingBox", BoundingBox(planned));
            return result;
        }

        private static JsonValue ToArray(List<JsonValue> list)
        {
            JsonValue array = JsonValue.NewArray();
            foreach (JsonValue v in list) array.Add(v);
            return array;
        }

        private static JsonValue DescribeItem(string kind, JsonValue item, int index)
        {
            JsonValue d = JsonValue.NewObject();
            d.Set("index", index);
            d.Set("kind", kind);
            try
            {
                switch (kind)
                {
                    case "line":
                    case "rect":
                        {
                            PointD from = Context.Point(item["from"], "from");
                            PointD to = Context.Point(item["to"], "to");
                            d.Set("from", Context.PointJson(from));
                            d.Set("to", Context.PointJson(to));
                            if (Math.Abs(from.X - to.X) < 1e-9 && Math.Abs(from.Y - to.Y) < 1e-9)
                            {
                                d.Set("valid", false);
                                d.Set("problem", "起点和终点重合");
                                return d;
                            }
                            d.Set("width", item["width"].AsDouble(0.2));
                            string color = item["color"].AsString(null);
                            if (!string.IsNullOrEmpty(color))
                            {
                                Int16 colorId;
                                if (!TryColor(color, out colorId))
                                {
                                    d.Set("valid", false);
                                    d.Set("problem", "不认识的颜色「" + color + "」，可用 yellow / red / green / cyan / blue / magenta / black / gray，或 1-12 的数字");
                                    return d;
                                }
                                d.Set("color", color);
                                d.Set("colorId", JsonValue.NewNumber(colorId));
                            }
                            d.Set("valid", true);
                            return d;
                        }
                    case "text":
                        {
                            PointD at = Context.Point(item["at"], "at");
                            string text = item["text"].AsString(null);
                            if (string.IsNullOrEmpty(text))
                            {
                                d.Set("valid", false);
                                d.Set("problem", "文本内容为空");
                                return d;
                            }
                            d.Set("at", Context.PointJson(at));
                            d.Set("text", text);
                            d.Set("height", item["height"].AsDouble(2.5));
                            d.Set("valid", true);
                            return d;
                        }
                    case "polyline":
                        {
                            JsonValue points = item["points"];
                            if (points == null || !points.IsArray || points.Count < 2)
                            {
                                d.Set("valid", false);
                                d.Set("problem", "polyline 至少需要 2 个点");
                                return d;
                            }
                            JsonValue list = JsonValue.NewArray();
                            for (int i = 0; i < points.Count; i++)
                                list.Add(Context.PointJson(Context.Point(points[i], "points[" + i + "]")));
                            d.Set("points", list);
                            d.Set("width", item["width"].AsDouble(0.2));
                            d.Set("valid", true);
                            return d;
                        }
                    default:
                        d.Set("valid", false);
                        d.Set("problem", "不认识的图元类型「" + kind + "」，可用：line / rect / text / polyline");
                        return d;
                }
            }
            catch (Exception ex)
            {
                d.Set("valid", false);
                d.Set("problem", ex.Message);
                return d;
            }
        }

        private static Placement CreateOne(Page page, string kind, JsonValue item)
        {
            switch (kind)
            {
                case "line":
                    {
                        Line line = new Line();
                        line.Create(page, Context.Point(item["from"], "from"), Context.Point(item["to"], "to"));
                        double width = item["width"].AsDouble(0.2);
                        if (width > 0) line.Width = width;
                        ApplyColor(item, line);
                        return line;
                    }
                case "rect":
                    {
                        Rectangle rect = new Rectangle();
                        rect.Create(page);
                        rect.SetArea(Context.Point(item["from"], "from"), Context.Point(item["to"], "to"));
                        ApplyColor(item, rect);
                        return rect;
                    }
                case "text":
                    {
                        Text text = new Text();
                        text.Create(page, item["text"].AsString(""), item["height"].AsDouble(2.5));
                        text.Location = Context.Point(item["at"], "at");
                        return text;
                    }
                case "polyline":
                    {
                        JsonValue points = item["points"];
                        PolyLine poly = new PolyLine();
                        poly.Create(page);
                        for (int i = 0; i < points.Count; i++)
                        {
                            PointD p = Context.Point(points[i], "points[" + i + "]");
                            poly.SetPointAt(i, ref p);
                        }
                        return poly;
                    }
                default:
                    throw new HostException("BAD_ARGUMENT", "不认识的图元类型: " + kind);
            }
        }

        /// <summary>
        /// 给图形图元上色。EPLAN 的调色板是固定编号（1 红、2 黄、3 绿、4 青、5 蓝、6 品红、7 黑…），
        /// Pen.ColorId 就是这个编号的索引。不传 color 时保持默认（跟图层走）。
        /// </summary>
        private static void ApplyColor(JsonValue item, Placement graphic)
        {
            string color = item["color"].AsString(null);
            if (string.IsNullOrEmpty(color)) return;
            Int16 colorId;
            if (!TryColor(color, out colorId)) return;
            double width = item["width"].AsDouble(0.2);
            Pen pen = new Pen();
            pen.ColorId = colorId;
            if (width > 0) pen.Width = width;
            Line line = graphic as Line;
            if (line != null) { line.Pen = pen; return; }
            Rectangle rect = graphic as Rectangle;
            if (rect != null) { rect.Pen = pen; return; }
            PolyLine poly = graphic as PolyLine;
            if (poly != null) poly.Pen = pen;
        }

        internal static bool TryColor(string text, out Int16 id)
        {
            id = 0;
            string key = (text ?? string.Empty).Trim().ToLowerInvariant();
            if (key == "red") id = 1;
            else if (key == "yellow") id = 2;
            else if (key == "green") id = 3;
            else if (key == "cyan") id = 4;
            else if (key == "blue") id = 5;
            else if (key == "magenta") id = 6;
            else if (key == "black") id = 7;
            else if (key == "gray" || key == "grey") id = 9;
            else
            {
                Int16 parsed;
                if (Int16.TryParse(key, out parsed) && parsed >= 1 && parsed <= 12) id = parsed;
                else return false;
            }
            return true;
        }

        private static void Rollback(List<Placement> created)
        {
            for (int i = created.Count - 1; i >= 0; i--)
            {
                try { created[i].Remove(); }
                catch { }
            }
            created.Clear();
        }

        private static JsonValue BoundingBox(List<JsonValue> planned)
        {
            double minX = double.MaxValue, minY = double.MaxValue;
            double maxX = double.MinValue, maxY = double.MinValue;
            bool any = false;

            foreach (JsonValue d in planned)
            {
                if (!d["valid"].AsBool(false)) continue;
                JsonValue from = d["from"];
                JsonValue to = d["to"];
                JsonValue at = d["at"];
                JsonValue points = d["points"];
                if (from != null) { Absorb(from, ref minX, ref minY, ref maxX, ref maxY, ref any); }
                if (to != null) { Absorb(to, ref minX, ref minY, ref maxX, ref maxY, ref any); }
                if (at != null) { Absorb(at, ref minX, ref minY, ref maxX, ref maxY, ref any); }
                if (points != null && points.IsArray)
                {
                    for (int i = 0; i < points.Count; i++)
                        Absorb(points[i], ref minX, ref minY, ref maxX, ref maxY, ref any);
                }
            }

            if (!any) return JsonValue.NewNull();
            JsonValue box = JsonValue.NewObject();
            JsonValue min = JsonValue.NewArray();
            min.Add(JsonValue.NewNumber(minX));
            min.Add(JsonValue.NewNumber(minY));
            JsonValue max = JsonValue.NewArray();
            max.Add(JsonValue.NewNumber(maxX));
            max.Add(JsonValue.NewNumber(maxY));
            box.Set("min", min);
            box.Set("max", max);
            return box;
        }

        private static void Absorb(JsonValue point, ref double minX, ref double minY, ref double maxX, ref double maxY, ref bool any)
        {
            if (point == null || !point.IsArray || point.Count < 2) return;
            double x = point[0].AsDouble(double.NaN);
            double y = point[1].AsDouble(double.NaN);
            if (double.IsNaN(x) || double.IsNaN(y)) return;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            any = true;
        }
    }
}
