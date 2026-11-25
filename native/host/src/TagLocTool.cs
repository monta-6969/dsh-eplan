// tagloc：把设备标识放到符号旁边，并回报最终实际位置。
//
// 为什么单独做一个：PropertyPlacement 的 Location 语义不直观 ——
// 设完之后位置不一定是你给的那个，必须读回来确认。
// 顺便把「符号本身多大」也报出来，方便算避让距离。
using System;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;
using Eplan.EplApi.DataModel.MasterData;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class TagLocTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string pageName = args["page"].AsString(null);
            string libraryName = args["library"].AsString("GB_symbol");
            string symbolName = args["symbol"].AsString(null);
            string deviceTag = args["deviceTag"].AsString(null);
            int variantNr = args["variant"].AsInt(0);

            Page page = Context.FindPage(pageName, args["project"].AsString(null));
            PointD at = Context.Point(args["at"], "at");
            PointD tagAt = Context.Point(args["tagAt"], "tagAt");

            SymbolLibrary library = Context.Library(libraryName, args["project"].AsString(null));
            Symbol symbol = new Symbol(library, symbolName);
            SymbolVariant variant = new SymbolVariant(symbol, variantNr);

            JsonValue result = JsonValue.NewObject();

            SymbolReference reference = variant.Create(page) as SymbolReference;
            if (reference == null)
            {
                throw new HostException("NOT_SYMBOL", "插入出来的对象不是 SymbolReference。");
            }
            reference.Location = at;
            if (!string.IsNullOrEmpty(deviceTag))
            {
                // Name 在 Function 上，不在 SymbolReference 上。
                Function function = reference as Function;
                if (function != null) function.Name = deviceTag;
                else result.Set("nameWarning", "对象不是 Function，设备标识未写入。");
            }

            // 符号自身占多大：用它的包围盒判断。
            try
            {
                PointD[] box = reference.GetBoundingBox();
                if (box != null && box.Length >= 2)
                {
                    JsonValue min = JsonValue.NewArray();
                    min.Add(JsonValue.NewNumber(box[0].X));
                    min.Add(JsonValue.NewNumber(box[0].Y));
                    JsonValue max = JsonValue.NewArray();
                    max.Add(JsonValue.NewNumber(box[1].X));
                    max.Add(JsonValue.NewNumber(box[1].Y));
                    result.Set("symbolBoxMin", min);
                    result.Set("symbolBoxMax", max);
                }
            }
            catch (Exception ex) { result.Set("symbolBoxError", ex.Message); }

            PropertyPlacement tag = new PropertyPlacement();
            tag.Create(reference, Properties.Function.FUNC_DEVICETAG_MAINNAME);
            result.Set("locationAfterCreate", PointJson(tag.Location));

            try
            {
                tag.Location = tagAt;
                result.Set("setTo", Context.PointJson(tagAt));
            }
            catch (Exception ex)
            {
                result.Set("setLocationError", ex.Message);
            }
            result.Set("locationAfterSet", PointJson(tag.Location));

            try { result.Set("displayString", tag.GetDisplayString()); }
            catch (Exception ex) { result.Set("displayError", ex.Message); }

            try
            {
                PointD[] box = tag.GetBoundingBox();
                if (box != null && box.Length >= 2)
                {
                    result.Set("tagBoxMin", PointJson(box[0]));
                    result.Set("tagBoxMax", PointJson(box[1]));
                }
            }
            catch (Exception ex) { result.Set("tagBoxError", ex.Message); }

            result.Set("inserted", true);
            return result;
        }

        private static JsonValue PointJson(PointD p)
        {
            JsonValue a = JsonValue.NewArray();
            a.Add(JsonValue.NewNumber(p.X));
            a.Add(JsonValue.NewNumber(p.Y));
            return a;
        }
    }
}
