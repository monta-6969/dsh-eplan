// box：在页面上画「黑箱」——黄色矩形 + 边缘的连接点（DCP）。
//
// 为什么不直接用 EPLAN 的 BoxedDevice：实测（2026-11-09）API 建出来的 BoxedDevice
// 要么渲染成一个红色叉（占位符），要么按固定符号尺寸画个小方框，SetLogicalArea
// 只改 Location 不拉伸图形，AddConnectionPointPosition 也存不住。GUI 里那个
// 黄框黑箱没法从 API 复刻，所以这里用「黄色矩形 + DCP 端子」的组合表达：
//   * 矩形用 Graphics.Rectangle + Pen.ColorId=2（黄），和界面里黑箱同色；
//   * 连接点用 SPECIAL/DCP，deviceTag 写 "-U1:SD"，DCP 自己会把 SD 渲染出来；
//   * 端子朝向按所在边选变体：上=0、左=1、下=2、右=3，引脚正好落在框线上。
using System;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class BoxTool
    {
        public static JsonValue Run(JsonValue args)
        {
            Page page = Context.FindPage(args["page"].AsString(null), args["project"].AsString(null));
            PointD from = Context.Point(args["from"], "from");
            PointD to = Context.Point(args["to"], "to");
            string color = args["color"].AsString("yellow");
            double width = args["width"].AsDouble(0.35);
            string deviceTag = args["deviceTag"].AsString(null);
            bool dryRun = args["dryRun"].AsBool(false);
            JsonValue pins = args["pins"];

            Int16 colorId;
            if (!DrawTool.TryColor(color, out colorId))
                throw new HostException("BAD_ARGUMENT",
                    "不认识的颜色「" + color + "」，可用 yellow / red / green / cyan / blue / magenta / black / gray，或 1-12 的数字。");

            double left = Math.Min(from.X, to.X);
            double right = Math.Max(from.X, to.X);
            double bottom = Math.Min(from.Y, to.Y);
            double top = Math.Max(from.Y, to.Y);
            bool hasPins = pins != null && pins.IsArray && pins.Count > 0;
            if (hasPins && string.IsNullOrEmpty(deviceTag))
                throw new HostException("BAD_ARGUMENT", "pins 需要 deviceTag（例如 -U1），否则连接点代号渲染不出来。");

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("rect", Points(left, bottom, right, top));
            result.Set("color", color);
            result.Set("width", width);
            result.Set("pinsRequested", hasPins ? pins.Count : 0);
            result.Set("dryRun", dryRun);

            if (dryRun)
            {
                result.Set("created", false);
                result.Set("wouldCreate", JsonValue.NewNumber(1 + (hasPins ? pins.Count : 0) + (string.IsNullOrEmpty(deviceTag) ? 0 : 1)));
                return result;
            }

            // 1) 矩形。Pen.ColorId 就是固定调色板编号，2 = 黄。
            Rectangle rect = new Rectangle();
            rect.Create(page);
            rect.SetArea(new PointD(left, bottom), new PointD(right, top));
            Pen pen = new Pen();
            pen.ColorId = colorId;
            if (width > 0) pen.Width = width;
            rect.Pen = pen;
            JsonValue rectInfo = JsonValue.NewObject();
            rectInfo.Set("kind", "rect");
            try { rectInfo.Set("objectId", rect.ObjectIdentifier.ToString()); } catch { }
            result.Set("rectObject", rectInfo);

            // 2) 器件标识写在框左上角外面，和界面里黑箱的 -U1 同位。
            JsonValue texts = JsonValue.NewArray();
            if (!string.IsNullOrEmpty(deviceTag))
            {
                try
                {
                    Text label = new Text();
                    label.Create(page, deviceTag, 2.5);
                    label.Location = new PointD(left, top + 1.5);
                    JsonValue t = JsonValue.NewObject();
                    t.Set("text", deviceTag);
                    t.Set("at", Point2(left, top + 1.5));
                    texts.Add(t);
                }
                catch (Exception ex)
                {
                    result.Set("tagWarning", "器件标识已作为连接点前缀使用，文本框没画出来：" + ex.Message);
                }
            }
            result.Set("texts", texts);

            // 3) 连接点：DCP 变体按边选，位置沿边分布。
            JsonValue placed = JsonValue.NewArray();
            JsonValue failed = JsonValue.NewArray();
            if (hasPins)
            {
                for (int i = 0; i < pins.Count; i++)
                {
                    JsonValue pin = pins[i];
                    string name = pin["name"].AsString(null);
                    if (string.IsNullOrEmpty(name))
                    {
                        JsonValue bad = JsonValue.NewObject();
                        bad.Set("index", JsonValue.NewNumber(i));
                        bad.Set("error", "缺少 name");
                        failed.Add(bad);
                        continue;
                    }
                    string side = (pin["side"].AsString("top") ?? "top").ToLowerInvariant();
                    double at = pin["at"] == null ? double.NaN : pin["at"].AsDouble(double.NaN);
                    double x;
                    double y;
                    int variant;
                    if (side == "top") { x = Slot(at, left, right, i, pins.Count); y = top - 4; variant = 0; }
                    else if (side == "bottom") { x = Slot(at, left, right, i, pins.Count); y = bottom + 4; variant = 2; }
                    else if (side == "left") { y = Slot(at, bottom, top, i, pins.Count); x = left + 2; variant = 1; }
                    else if (side == "right") { y = Slot(at, bottom, top, i, pins.Count); x = right - 2; variant = 3; }
                    else
                    {
                        JsonValue bad = JsonValue.NewObject();
                        bad.Set("index", JsonValue.NewNumber(i));
                        bad.Set("error", "side 只能是 top / bottom / left / right，收到「" + side + "」");
                        failed.Add(bad);
                        continue;
                    }

                    JsonValue nodeArgs = JsonValue.NewObject();
                    nodeArgs.Set("page", page.Name);
                    nodeArgs.Set("project", page.Project.ProjectName);
                    nodeArgs.Set("library", "SPECIAL");
                    nodeArgs.Set("symbol", "DCP");
                    nodeArgs.Set("variant", JsonValue.NewNumber(variant));
                    nodeArgs.Set("at", Point2(x, y));
                    nodeArgs.Set("deviceTag", deviceTag + ":" + name);
                    nodeArgs.Set("showDeviceTag", JsonValue.NewBool(false));
                    try
                    {
                        JsonValue one = SymbolInsertTool.Run(nodeArgs);
                        JsonValue brief = JsonValue.NewObject();
                        brief.Set("index", JsonValue.NewNumber(i));
                        brief.Set("name", name);
                        brief.Set("side", side);
                        brief.Set("at", Point2(x, y));
                        brief.Set("variant", JsonValue.NewNumber(variant));
                        brief.Set("deviceTag", deviceTag + ":" + name);
                        if (one != null) brief.Set("object", one["object"]);
                        placed.Add(brief);
                    }
                    catch (Exception ex)
                    {
                        JsonValue bad = JsonValue.NewObject();
                        bad.Set("index", JsonValue.NewNumber(i));
                        bad.Set("name", name);
                        bad.Set("error", ex.Message);
                        failed.Add(bad);
                    }
                }
            }
            result.Set("pins", placed);
            if (failed.Count > 0) result.Set("failed", failed);
            result.Set("ok", failed.Count == 0);
            return result;
        }

        /// <summary>给一个坐标就吸附到 [lo,hi]，没给就按序号平均分。</summary>
        private static double Slot(double at, double lo, double hi, int index, int count)
        {
            if (!double.IsNaN(at)) return Math.Min(Math.Max(at, lo + 2), hi - 2);
            return lo + (hi - lo) * (index + 1) / (count + 1);
        }

        private static JsonValue Point2(double x, double y)
        {
            JsonValue a = JsonValue.NewArray();
            a.Add(JsonValue.NewNumber(x));
            a.Add(JsonValue.NewNumber(y));
            return a;
        }

        private static JsonValue Points(double x1, double y1, double x2, double y2)
        {
            JsonValue a = JsonValue.NewArray();
            a.Add(JsonValue.NewNumber(x1));
            a.Add(JsonValue.NewNumber(y1));
            JsonValue b = JsonValue.NewArray();
            b.Add(JsonValue.NewNumber(x2));
            b.Add(JsonValue.NewNumber(y2));
            JsonValue pair = JsonValue.NewArray();
            pair.Add(a);
            pair.Add(b);
            return pair;
        }
    }
}

