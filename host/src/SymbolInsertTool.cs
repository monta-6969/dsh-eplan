// symbol_insert：插元件 + 写设备标识。
// 用 SymbolVariant.Create(page) 拿到 SymbolReference，再设位置与属性。
using System;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;
using Eplan.EplApi.DataModel.MasterData;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class SymbolInsertTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string pageName = args["page"].AsString(null);
            string libraryName = args["library"].AsString("GB_symbol");
            string symbolName = args["symbol"].AsString(null);
            int variantNr = args["variant"].AsInt(0);
            string deviceTag = args["deviceTag"].AsString(null);
            bool dryRun = args["dryRun"].AsBool(false);
            // 默认把设备标识显示到图上；关掉可以少一个图元。
            bool showDeviceTag = args["showDeviceTag"].AsBool(true);
            JsonValue props = args["props"];

            if (string.IsNullOrEmpty(symbolName))
                throw new HostException("BAD_ARGUMENT", "缺少符号名（symbol），例如 FA3。可以先用 symbols 查询。");

            Page page = Context.FindPage(pageName, args["project"].AsString(null));
            PointD at = Context.Point(args["at"], "at");

            SymbolLibrary library;
            try
            {
                library = Context.Library(libraryName, args["project"].AsString(null));
            }
            catch (Exception ex)
            {
                throw new HostException("LIBRARY_NOT_FOUND",
                    "打不开符号库「" + libraryName + "」：" + ex.Message, null);
            }

            Symbol symbol;
            try
            {
                symbol = new Symbol(library, symbolName);
            }
            catch (Exception ex)
            {
                throw new HostException("SYMBOL_NOT_FOUND",
                    "符号库「" + libraryName + "」里没有符号「" + symbolName + "」：" + ex.Message +
                    "。先用 symbols 工具查询确切的符号名。");
            }

            SymbolVariant variant;
            try
            {
                variant = new SymbolVariant(symbol, variantNr);
            }
            catch (Exception ex)
            {
                throw new HostException("VARIANT_NOT_FOUND",
                    "符号「" + symbolName + "」没有变体 " + variantNr + "：" + ex.Message);
            }

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("library", libraryName);
            result.Set("symbol", symbol.Name);
            result.Set("variant", variantNr);
            result.Set("at", Context.PointJson(at));
            result.Set("deviceTag", deviceTag);
            result.Set("dryRun", dryRun);

            if (dryRun)
            {
                result.Set("inserted", false);
                result.Set("wouldInsert", true);
                return result;
            }

            Placement placement = null;
            try
            {
                placement = variant.Create(page);
                placement.Location = at;

                if (!string.IsNullOrEmpty(deviceTag))
                {
                    Function function = placement as Function;
                    if (function != null)
                    {
                        function.Name = deviceTag;
                    }
                    else
                    {
                        result.Set("deviceTagWarning",
                            "插入的对象不是 Function（是 " + placement.GetType().Name + "），设备标识未写入。");
                    }
                }

                if (props != null && props.IsObject)
                {
                    Function function = placement as Function;
                    if (function != null)
                        ApplyProperties(function, props, result);
                    else
                        result.Set("propsWarning", "对象不是 Function，属性未写入。");
                }
            }
            catch (Exception ex)
            {
                try { if (placement != null) placement.Remove(); } catch { }
                throw new HostException("INSERT_FAILED", "插入符号失败：" + ex.Message, ex.ToString());
            }

            // 设备标识写进属性只是存了数据，图上默认不显示；
            // 要让 -F4 这种文字出现在符号旁边，必须额外放一个 PropertyPlacement。
            // 这是 EPLAN 的规矩，不是我们的选择。
            if (!string.IsNullOrEmpty(deviceTag) && showDeviceTag)
            {
                try
                {
                    SymbolReference reference = placement as SymbolReference;
                    if (reference == null)
                    {
                        result.Set("tagDisplayWarning",
                            "插入对象不是 SymbolReference（是 " + placement.GetType().Name + "），无法挂属性显示。");
                    }
                    else
                    {
                        PlaceDeviceTag(reference, at, deviceTag, result);
                    }
                }
                catch (Exception ex)
                {
                    result.Set("tagDisplayWarning", "设备标识已写入，但显示到图上失败：" + ex.Message);
                }
            }

            result.Set("inserted", true);
            JsonValue created = Describe(placement);
            result.Set("object", created);

            // 记一笔，好在事后撤回：按页名 + 对象名定位，回退时把它删掉。
            // 名字必须用 EPLAN 生成的那个（=+-Q1 这种），deviceTag 可能为空或重复。
            string createdName = created == null ? null : created["name"].AsString(null);
            if (!string.IsNullOrEmpty(createdName))
            {
                JsonValue undo = JsonValue.NewObject();
                undo.Set("kind", "remove_object");
                undo.Set("name", createdName);
                OpJournal.Append("symbol_insert", page.Project.ProjectName, page.Name, undo, true, null);
            }
            else
            {
                OpJournal.Append("symbol_insert", page.Project.ProjectName, page.Name, null, false,
                    "插入的对象没有可用于定位的名字，无法自动回退。");
            }

            return result;
        }

        /// <summary>
        /// 在符号旁边标出设备标识。
        ///
        /// 为什么用 Graphics.Text 而不是 PropertyPlacement：
        /// 实测 PropertyPlacement 造出来是「看得见对象、看不见字」——
        ///   * reference.PropertyPlacements 里本来就有 12 条符号自带的，Height 全是
        ///     -16002（隐藏哨兵），GetDisplayString() 返回空字符串；
        ///   * 自己 Create 的那条 Height=2.5、GetDisplayString() 也拿到了 "F4"，
        ///     但 GraphicPageEx 渲染出来仍然是空白；
        ///   * 开不开 UseLocalPropertyPlacements、bFromDevice 传 true/false，
        ///     这几种组合都试过，全都不显示。
        /// 而 Graphics.Text 是确定能渲染的（页面上的 L24-1 这些标注就是它画的）。
        ///
        /// 代价：标签是普通文字，改设备标识时不会自动跟着变。
        /// 好处：一定能看到，且位置完全可控。
        ///
        /// 位置规则：Location 是文字包围盒的左下角；符号占多高优先看包围盒，
        /// 查不到就退到经验值。
        /// </summary>
        private static void PlaceDeviceTag(SymbolReference reference, PointD at, string deviceTag, JsonValue result)
        {
            double leftShift = 5.0;
            double topOffset = 7.0;
            try
            {
                PointD[] box = reference.GetBoundingBox();
                if (box != null && box.Length >= 2)
                {
                    double halfHeight = Math.Abs(box[1].Y - box[0].Y) / 2.0;
                    topOffset = halfHeight + 3.0;
                }
            }
            catch { }

            Text label = new Text();
            label.Create(reference.Page, deviceTag, 2.5);
            label.Location = new PointD(at.X - leftShift, at.Y + topOffset);

            result.Set("deviceTagShown", true);
            result.Set("deviceTagMode", "text");
            result.Set("deviceTagAt", Context.PointJson(label.Location));
        }

        private static void ApplyProperties(Function function, JsonValue props, JsonValue result)
        {
            JsonValue applied = JsonValue.NewArray();
            JsonValue failed = JsonValue.NewArray();
            foreach (string key in props.Keys)
            {
                try
                {
                    // 通过属性名反射到 FunctionPropertyList 的静态属性。
                    System.Reflection.PropertyInfo info =
                        typeof(FunctionPropertyList).GetProperty(key,
                            System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
                    if (info == null)
                    {
                        failed.Add(JsonValue.NewString(key + "：不认识的属性名"));
                        continue;
                    }
                    object propertyId = info.GetValue(null, null);
                    string value = props[key].AsString(null);
                    if (value == null) { failed.Add(JsonValue.NewString(key + "：值为空")); continue; }
                    function.Properties[(Eplan.EplApi.DataModel.Properties.Function)propertyId] = value;
                    applied.Add(JsonValue.NewString(key));
                }
                catch (Exception ex)
                {
                    failed.Add(JsonValue.NewString(key + "：" + ex.Message));
                }
            }
            result.Set("propsApplied", applied);
            if (failed.Count > 0) result.Set("propsFailed", failed);
        }

        private static JsonValue Describe(Placement placement)
        {
            JsonValue item = JsonValue.NewObject();
            item.Set("type", placement.GetType().Name);
            try { item.Set("objectId", placement.ObjectIdentifier.ToString()); } catch { }
            Function function = placement as Function;
            if (function != null)
            {
                try { item.Set("name", function.Name); } catch { }
                try { item.Set("visibleName", function.VisibleName); } catch { }
            }
            try
            {
                JsonValue location = JsonValue.NewArray();
                location.Add(JsonValue.NewNumber(placement.Location.X));
                location.Add(JsonValue.NewNumber(placement.Location.Y));
                item.Set("location", location);
            }
            catch { }
            return item;
        }
    }
}
