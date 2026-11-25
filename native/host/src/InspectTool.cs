// inspect：把一个页面上**真实存在**的东西全部倒出来，包括 EPLAN 自动生成的连接。
//
// 为什么需要它：
//   用户指出「红线是元器件和节点摆对位置后软件自动连的」，不是画出来的。
//   要复现这一点，必须先看清「一个已经画好的页」里到底有哪些对象、哪些是
//   符号的宿主(如 Function)、哪些是自动连接(Connection)、连接点坐标在哪。
//
// SymbolReference 的成员名不确定（没有 SymbolName / VariantNr / SymbolReferences），
// 所以这里一律走反射，把能读到的属性都列出来，而不是硬编码。
using System;
using System.Collections;
using System.Reflection;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;
using Eplan.EplApi.DataModel.MasterData;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class InspectTool
    {
        public static JsonValue Run(JsonValue args)
        {
            // 只看类型清单：{"assembly":"Guiu"} —— 探索某个 EPLAN 程序集里到底有什么。
            string assemblyFilter = args["assembly"].AsString(null);
            if (!string.IsNullOrEmpty(assemblyFilter))
            {
                JsonValue only = JsonValue.NewObject();
                only.Set("assembly", assemblyFilter);
                only.Set("types", ListTypes(assemblyFilter));
                return only;
            }

            string pageName = args["page"].AsString(null);
            Page page = Context.FindPage(pageName, args["project"].AsString(null));

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("pageType", page.PageType.ToString());

            int limit = args["limit"].AsInt(200);

            // ── 1. 放置对象 ──────────────────────────────────────────
            JsonValue placements = JsonValue.NewArray();
            Placement[] all = page.AllPlacements;
            if (all != null)
            {
                result.Set("placementTotal", all.Length);
                int n = 0;
                foreach (Placement p in all)
                {
                    if (n >= limit) break;
                    n++;
                    placements.Add(DescribePlacement(p));
                }
            }
            else result.Set("placementTotal", 0);
            result.Set("placements", placements);

            // ── 2. Function 列表 ─────────────────────────────────────
            JsonValue functions = JsonValue.NewArray();
            Function[] fns = page.Functions;
            if (fns != null)
            {
                result.Set("functionTotal", fns.Length);
                int n = 0;
                foreach (Function f in fns)
                {
                    if (n >= limit) break;
                    n++;
                    functions.Add(DescribeFunction(f));
                }
            }
            else result.Set("functionTotal", 0);
            result.Set("functions", functions);

            // ── 3. 自动连接 ──────────────────────────────────────────
            result.Set("connections", DescribeConnections(page));

            // ── 4. 想看某个类型的成员时：{"page":"...","members":"SymbolReference"}
            string members = args["members"].AsString(null);
            if (!string.IsNullOrEmpty(members)) result.Set("members", DumpMembers(members));

            return result;
        }

        /// <summary>把某个 EPLAN 类型的公开成员列出来，用来确认真实属性名。</summary>
        private static JsonValue DumpMembers(string typeName)
        {
            JsonValue list = JsonValue.NewArray();
            // 类型可能在 DataModel / DataModel.Graphics / DataModel.MasterData 任一命名空间下，
            // 依次试，别只认一个（PropertyPlacement 就在 Graphics 里）。
            string[] prefixes = {
                "Eplan.EplApi.DataModel.",
                "Eplan.EplApi.DataModel.Graphics.",
                "Eplan.EplApi.DataModel.MasterData.",
                "Eplan.EplApi.Base.",
                "Eplan.EplApi.HEServices.",
                "Eplan.EplApi.ApplicationFramework.",
            };
            Type type = null;
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (type != null) break;
                foreach (string prefix in prefixes)
                {
                    try
                    {
                        Type candidate = asm.GetType(prefix + typeName);
                        if (candidate != null) { type = candidate; break; }
                    }
                    catch { }
                }
            }
            if (type == null)
            {
                list.Add(JsonValue.NewString("NOT_FOUND: " + typeName));
                return list;
            }
            BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
            foreach (PropertyInfo p in type.GetProperties(flags))
            {
                string setter = p.SetMethod != null ? "set" : "get";
                list.Add(JsonValue.NewString(p.PropertyType.Name + " " + p.Name + " (" + setter + ")"));
            }
            foreach (MethodInfo m in type.GetMethods(flags))
            {
                if (m.IsSpecialName) continue;
                list.Add(JsonValue.NewString("() " + m.ReturnType.Name + " " + m.Name));
            }
            return list;
        }

        /// <summary>列出名字里含过滤串的 EPLAN 类型（跨所有已加载程序集）。</summary>
        private static JsonValue ListTypes(string filter)
        {
            JsonValue list = JsonValue.NewArray();
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch { continue; }
                foreach (Type type in types)
                {
                    if (type == null) continue;
                    string full = type.FullName ?? type.Name;
                    if (full.IndexOf("Eplan.EplApi", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (filter.Length > 0 && full.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    list.Add(JsonValue.NewString(full));
                }
            }
            return list;
        }

        private static JsonValue DescribePlacement(Placement p)
        {
            JsonValue item = JsonValue.NewObject();
            item.Set("type", p.GetType().Name);
            try { item.Set("objectId", p.ObjectIdentifier.ToString()); } catch { }
            try
            {
                JsonValue loc = JsonValue.NewArray();
                loc.Add(JsonValue.NewNumber(p.Location.X));
                loc.Add(JsonValue.NewNumber(p.Location.Y));
                item.Set("location", loc);
            }
            catch { }

            SymbolReference sr = p as SymbolReference;
            if (sr != null)
            {
                // SymbolReference 上没有 SymbolName，符号名在它的 SymbolVariant 上。
                SymbolVariant variant = TryGetVariant(sr);
                if (variant != null)
                {
                    CopyIfExists(item, "symbolName", variant, new string[] { "SymbolName", "Name" });
                    CopyIfExists(item, "variant", variant, new string[] { "VariantNr", "Variant" });
                }

                // 自动连线靠的就是这些连接点：Location 是**绝对坐标**，Direction 是朝向。
                // 两个符号的连接点对上（坐标相同、朝向相对），EPLAN 就自己画红线。
                item.Set("pins", DescribePins(sr));
                item.Set("propertyPlacements", DescribePropertyPlacements(sr));
            }

            Function f = p as Function;
            if (f != null)
            {
                try { item.Set("name", f.Name); } catch { }
                try { item.Set("visibleName", f.VisibleName); } catch { }
            }
            return item;
        }

        private static JsonValue DescribeFunction(Function f)
        {
            JsonValue item = JsonValue.NewObject();
            try { item.Set("name", f.Name); } catch { }
            try { item.Set("visibleName", f.VisibleName); } catch { }
            try { item.Set("type", f.GetType().Name); } catch { }

            SymbolReference sr = f as SymbolReference;
            if (sr != null)
            {
                CopyIfExists(item, "symbolName", sr, new string[] { "SymbolName", "Name" });
                CopyIfExists(item, "variant", sr, new string[] { "VariantNr", "Variant" });
            }
            return item;
        }

        private static SymbolVariant TryGetVariant(SymbolReference sr)
        {
            string[] names = { "BasedOnSymbolVariant", "SymbolVariant", "Variant" };
            foreach (string name in names)
            {
                try
                {
                    PropertyInfo info = sr.GetType().GetProperty(name);
                    if (info == null) continue;
                    object value = info.GetValue(sr, null);
                    SymbolVariant variant = value as SymbolVariant;
                    if (variant != null) return variant;
                }
                catch { }
            }
            return null;
        }

        /// <summary>
        /// 符号上挂的每一个属性摆放（PropertyPlacement）。
        ///
        /// 这是排查「设备标识不显示」的关键：
        /// 对象存在不等于图上能看到字，要逐条看 Contents 有没有内容、
        /// Location 是不是在页面外、IsFromDevice 读的是设备值还是符号局部值。
        /// </summary>
        private static JsonValue DescribePropertyPlacements(SymbolReference sr)
        {
            JsonValue list = JsonValue.NewArray();
            try
            {
                PropertyPlacement[] all = sr.PropertyPlacements;
                if (all == null) return list;
                foreach (PropertyPlacement p in all)
                {
                    JsonValue o = JsonValue.NewObject();
                    try
                    {
                        JsonValue at = JsonValue.NewArray();
                        at.Add(JsonValue.NewNumber(p.Location.X));
                        at.Add(JsonValue.NewNumber(p.Location.Y));
                        o.Set("at", at);
                    }
                    catch { }
                    try { o.Set("text", p.GetDisplayString()); } catch { }
                    try { o.Set("contents", p.Contents.ToString()); } catch { }
                    try { o.Set("fromDevice", p.IsFromDevice); } catch { }
                    try { o.Set("height", JsonValue.NewNumber(p.Height)); } catch { }
                    list.Add(o);
                }
            }
            catch (Exception ex) { list.Add(JsonValue.NewString("PP_ERROR " + ex.Message)); }
            return list;
        }

        /// <summary>
        /// 符号的连接点（Pin）。
        ///
        /// PinBase 的成员是：Location(PointD)、Direction(Directions)、Index(Int32)、Parent。
        /// Location 已经是**绝对坐标**，不用再加符号位置。
        /// 这一组坐标就是 EPLAN 判断"该不该画红线"的唯一依据。
        /// </summary>
        private static JsonValue DescribePins(SymbolReference sr)
        {
            JsonValue list = JsonValue.NewArray();
            try
            {
                PinBase[] pins = sr.GraphicalConnectionPoints;
                if (pins == null) return list;
                foreach (PinBase pin in pins)
                {
                    if (pin == null) continue;
                    JsonValue item = JsonValue.NewObject();
                    try
                    {
                        JsonValue loc = JsonValue.NewArray();
                        loc.Add(JsonValue.NewNumber(pin.Location.X));
                        loc.Add(JsonValue.NewNumber(pin.Location.Y));
                        item.Set("location", loc);
                    }
                    catch { }
                    try { item.Set("direction", pin.Direction.ToString()); } catch { }
                    try { item.Set("index", JsonValue.NewNumber(pin.Index)); } catch { }
                    list.Add(item);
                }
            }
            catch (Exception ex) { list.Add(JsonValue.NewString("PINS_ERROR " + ex.Message)); }
            return list;
        }

        private static void CopyPoint(JsonValue item, string key, object source, string propName)
        {
            try
            {
                PropertyInfo info = source.GetType().GetProperty(propName);
                if (info == null) return;
                object value = info.GetValue(source, null);
                // PointD 是**结构体**，as 一定返回 null，必须直接判类型。
                if (!(value is PointD)) return;
                PointD point = (PointD)value;
                JsonValue arr = JsonValue.NewArray();
                arr.Add(JsonValue.NewNumber(point.X));
                arr.Add(JsonValue.NewNumber(point.Y));
                item.Set(key, arr);
            }
            catch { }
        }

        private static void CopyIfExists(JsonValue item, string key, object source, string[] names)
        {
            foreach (string name in names)
            {
                try
                {
                    PropertyInfo info = source.GetType().GetProperty(name);
                    if (info == null) continue;
                    object value = info.GetValue(source, null);
                    if (value == null) continue;
                    if (value is int) item.Set(key, JsonValue.NewNumber((int)value));
                    else item.Set(key, value.ToString());
                    return;
                }
                catch { }
            }
        }

        /// <summary>
        /// 自动连接：EPLAN 根据连接点与导线自动生成，画出来是红线。
        /// 数量就是「有没有连上」最直接的证据。
        /// </summary>
        private static JsonValue DescribeConnections(Page page)
        {
            JsonValue result = JsonValue.NewObject();
            string[] names = { "Connections", "AllConnections", "ConnectionList" };
            foreach (string name in names)
            {
                try
                {
                    PropertyInfo info = page.GetType().GetProperty(name);
                    if (info == null) continue;
                    object value = info.GetValue(page, null);
                    ICollection collection = value as ICollection;
                    if (collection != null)
                    {
                        result.Set("property", name);
                        result.Set("count", collection.Count);
                        return result;
                    }
                }
                catch { }
            }
            result.Set("count", -1);
            result.Set("note", "Page 上没有 Connections 属性。");
            return result;
        }
    }
}
