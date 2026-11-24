// symbol_info：查符号库里的符号「有几个变体、每个变体的连接点在哪、朝哪个方向」。
//
// 为什么必须能查：
//   EPLAN 的红线是它根据「连接点是否对齐、是否面对面」自动画的。
//   所以要摆出正确的图，必须先知道每个符号的连接点在符号坐标系里的偏移和朝向。
//   靠往页面上试插再量太慢，这里直接读书里的定义。
//
// 用法：
//   symbol_info {"library":"SPECIAL","symbols":["TLRU","TLRO","CO"]}
//   symbol_info {"library":"GB_symbol","symbols":["F1","FA3"],"project":"test"}
using System;
using System.Collections;
using System.Reflection;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.MasterData;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class SymbolInfoTool
    {
        public static JsonValue Run(JsonValue args)
        {
            SymbolLibrary library = Context.Library(
                args["library"].AsString("GB_symbol"), args["project"].AsString(null));

            JsonValue names = args["symbols"];
            if (names == null || !names.IsArray || names.Count == 0)
                throw new HostException("BAD_ARGUMENT", "symbols 必须是非空的符号名数组。");

            JsonValue list = JsonValue.NewArray();
            for (int i = 0; i < names.Count; i++)
            {
                string name = names[i].AsString(null);
                if (string.IsNullOrEmpty(name)) continue;
                list.Add(Describe(library, name));
            }

            JsonValue result = JsonValue.NewObject();
            result.Set("library", library.Name);
            result.Set("symbols", list);
            return result;
        }

        private static JsonValue Describe(SymbolLibrary library, string name)
        {
            JsonValue item = JsonValue.NewObject();
            item.Set("name", name);

            Symbol symbol;
            try
            {
                symbol = new Symbol(library, name);
            }
            catch (Exception ex)
            {
                item.Set("error", ex.Message);
                return item;
            }

            SymbolVariant[] variants = symbol.Variants;
            item.Set("variantCount", variants == null ? 0 : variants.Length);

            JsonValue list = JsonValue.NewArray();
            if (variants != null)
            {
                int limit = Math.Min(variants.Length, 8);
                for (int i = 0; i < limit; i++)
                {
                    JsonValue variantItem = JsonValue.NewObject();
                    variantItem.Set("nr", variants[i].VariantNr);
                    variantItem.Set("points", Points(variants[i]));
                    list.Add(variantItem);
                }
            }
            item.Set("variants", list);
            return item;
        }

        private static JsonValue Points(SymbolVariant variant)
        {
            JsonValue list = JsonValue.NewArray();
            try
            {
                IEnumerable points = variant.ConnectionPoints as IEnumerable;
                if (points == null) return list;
                foreach (object point in points)
                {
                    if (point == null) continue;
                    list.Add(Dump(point));
                }
            }
            catch { }
            return list;
        }

        /// <summary>
        /// 连接点对象的公开成员不确定，全量反射，把能读到的标量都吐出来。
        /// 关心的是 Location（相对偏移）和 Direction（朝向）。
        /// </summary>
        private static JsonValue Dump(object source)
        {
            JsonValue item = JsonValue.NewObject();
            foreach (PropertyInfo info in source.GetType().GetProperties(
                BindingFlags.Public | BindingFlags.Instance))
            {
                try
                {
                    object value = info.GetValue(source, null);
                    if (value == null) continue;
                    string key = info.Name.ToLowerInvariant();

                    if (value is PointD)
                    {
                        PointD point = (PointD)value;
                        JsonValue pair = JsonValue.NewArray();
                        pair.Add(JsonValue.NewNumber(point.X));
                        pair.Add(JsonValue.NewNumber(point.Y));
                        item.Set(key, pair);
                        continue;
                    }
                    if (value.GetType().IsEnum)
                    {
                        item.Set(key, value.ToString());
                        continue;
                    }
                    if (value is int || value is short || value is byte)
                    {
                        item.Set(key, JsonValue.NewNumber(Convert.ToDouble(value)));
                        continue;
                    }
                    if (value is string)
                    {
                        item.Set(key, (string)value);
                        continue;
                    }
                }
                catch { }
            }
            return item;
        }
    }
}
