// probe_props：试出 EPLAN 到底认哪些属性标识名，以及该怎么写进去。
//
// 背景：`project.Properties["PROJ_XXX"]` 这种字符串索引器对所有 PROJ_ 标识名
// 都抛 `S063109属性无效`（实测 14 个全挂），但这些属性明明在
// `ProjectPropertyList` 上以强类型成员的形式存在。所以这里除了字符串索引器，
// 还走一遍反射取成员 —— 两种路径都试，把「哪条通、怎么写成功」如实报出来。
using System;
using System.Reflection;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class ProbePropsTool
    {
        public static JsonValue Run(JsonValue args)
        {
            JsonValue identsArg = args["idents"];
            string patternEarly = args["pattern"].AsString(null);
            // 只列成员名（不给 idents）也是合法用法，所以这里两个都放过。
            bool hasIdents = identsArg != null && identsArg.IsArray && identsArg.Count > 0;
            if (!hasIdents && string.IsNullOrEmpty(patternEarly))
                throw new HostException("BAD_ARGUMENT", "给一组要试的属性标识名（idents），或者用 pattern 列出成员名。");

            Project project = Context.Resolve(args["project"].AsString(null));
            bool write = args["write"].AsBool(false);
            string writeValue = args["writeValue"].AsString("__mcp_probe__");

            // 先看运行时类型上到底有哪些成员名：dump 出来的可能是别的类，
            // 只有 project.Properties 的真实类型才算数。
            string pattern = patternEarly;
            if (!string.IsNullOrEmpty(pattern))
            {
                JsonValue names = JsonValue.NewArray();
                foreach (PropertyInfo p in project.Properties.GetType().GetProperties(
                    BindingFlags.Public | BindingFlags.Instance))
                {
                    if (p.PropertyType != typeof(PropertyValue)) continue;
                    if (pattern != "*" && p.Name.IndexOf(pattern, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    names.Add(JsonValue.NewString(p.Name));
                }
                JsonValue listed = JsonValue.NewObject();
                listed.Set("pattern", pattern);
                listed.Set("count", names.Count);
                listed.Set("names", names);
                return listed;
            }

            JsonValue found = JsonValue.NewArray();
            JsonValue missing = JsonValue.NewArray();

            for (int i = 0; i < identsArg.Count; i++)
            {
                string ident = identsArg[i].AsString(null);
                if (string.IsNullOrEmpty(ident)) continue;

                JsonValue item = JsonValue.NewObject();
                item.Set("ident", ident);

                PropertyValue value = null;

                // 路径一：字符串索引器。对 PROJ_* 基本都会失败，但不能先入为主。
                try
                {
                    value = project.Properties[ident];
                    item.Set("viaIndexer", true);
                }
                catch (Exception ex)
                {
                    item.Set("viaIndexer", false);
                    item.Set("indexerError", ex.GetType().Name + ": " + ex.Message);
                }

                // 路径二：反射取强类型成员。
                if (value == null)
                {
                    try
                    {
                        // 每个属性名都有重载（带 Int32 index 的多值版本），
                        // 直接 GetProperty 会抛 AmbiguousMatchException，
                        // 必须挑「不带索引参数」的那个。
                        PropertyInfo member = null;
                        foreach (PropertyInfo candidate in project.Properties.GetType().GetProperties(
                            BindingFlags.Public | BindingFlags.Instance))
                        {
                            if (candidate.Name != ident) continue;
                            if (candidate.GetIndexParameters().Length != 0) continue;
                            member = candidate;
                            break;
                        }
                        if (member != null)
                        {
                            value = member.GetValue(project.Properties, null) as PropertyValue;
                            item.Set("viaMember", true);
                        }
                    }
                    catch (Exception ex)
                    {
                        item.Set("memberError", ex.GetType().Name + ": " + ex.Message);
                    }
                }

                if (value == null)
                {
                    item.Set("found", false);
                    missing.Add(item);
                    continue;
                }

                item.Set("found", true);

                string before = null;
                try { before = value.ToString(); } catch { }
                item.Set("current", before);

                if (write)
                {
                    try
                    {
                        value.Set(writeValue);
                        string after = null;
                        try { after = value.ToString(); } catch { }
                        item.Set("writable", true);
                        item.Set("afterWrite", after);
                        if (before != null) { try { value.Set(before); } catch { } }
                    }
                    catch (Exception ex)
                    {
                        item.Set("writable", false);
                        item.Set("writeError", ex.GetType().Name + ": " + ex.Message);
                    }
                }

                found.Add(item);
            }

            JsonValue result = JsonValue.NewObject();
            result.Set("project", project.ProjectName);
            // 把运行时类型名报出来：反射到哪个类上，决定了成员名长什么样。
            Type propsType = project.Properties.GetType();
            result.Set("propertiesType", propsType.FullName);
            result.Set("propertiesAssembly", propsType.Assembly.GetName().Name);
            int memberCount = 0;
            foreach (PropertyInfo p in propsType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                if (p.PropertyType == typeof(PropertyValue)) memberCount++;
            result.Set("propertyMemberCount", memberCount);
            result.Set("found", found);
            result.Set("missing", missing);
            return result;
        }
    }
}
