// props：读写对象属性。
//
// 属性访问有两条路：
//   1. Properties.Function.FUNC_XXX 这类静态字段 → 强类型、IDE 可补全，但名字写死；
//   2. UniversalPropertyList 的字符串索引器 → 可以传 EPLAN 的标识名（如 "FUNC_COMMENT"）。
// 这里优先用 1（可靠），失败后退到 2。
using System;
using System.Collections.Generic;
using System.Reflection;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class PropsTool
    {
        private static readonly string[] KnownLists = new string[]
        {
            "Eplan.EplApi.DataModel.Properties+Function",
            "Eplan.EplApi.DataModel.Properties+FunctionBase",
            "Eplan.EplApi.DataModel.Properties+Placement",
            "Eplan.EplApi.DataModel.Properties+StorableObject",
            "Eplan.EplApi.DataModel.Properties+Page",
            "Eplan.EplApi.DataModel.Properties+Project"
        };

        public static JsonValue Run(JsonValue args)
        {
            JsonValue selector = args["selector"];
            if (selector == null || !selector.IsObject)
                throw new HostException("BAD_ARGUMENT", "缺少 selector（至少给 page 或 deviceTag）。");

            bool dryRun = args["dryRun"].AsBool(false);
            JsonValue get = args["get"];
            JsonValue set = args["set"];

            List<ObjectInfo> targets = Resolve(selector);
            if (targets.Count == 0)
                throw new HostException("OBJECT_NOT_FOUND",
                    "没有找到匹配的对象：selector = " + Json.Write(selector));

            JsonValue result = JsonValue.NewObject();
            result.Set("matched", targets.Count);
            result.Set("dryRun", dryRun);

            JsonValue rows = JsonValue.NewArray();
            foreach (ObjectInfo info in targets)
            {
                JsonValue row = JsonValue.NewObject();
                row.Set("kind", info.Kind);
                row.Set("type", info.TypeName);
                if (info.Name != null) row.Set("name", info.Name);
                if (info.Page != null) row.Set("page", info.Page);

                if (get != null && get.IsArray && get.Count > 0)
                {
                    JsonValue values = JsonValue.NewObject();
                    for (int i = 0; i < get.Count; i++)
                    {
                        string key = get[i].AsString(null);
                        if (string.IsNullOrEmpty(key)) continue;
                        values.Set(key, ReadProperty(info, key));
                    }
                    row.Set("values", values);
                }

                if (set != null && set.IsObject)
                {
                    JsonValue applied = JsonValue.NewArray();
                    JsonValue failed = JsonValue.NewArray();
                    foreach (string key in set.Keys)
                    {
                        string value = set[key].AsString(null);
                        if (dryRun)
                        {
                            applied.Add(JsonValue.NewString(key + " = " + value + "（未写入，dryRun）"));
                            continue;
                        }
                        try
                        {
                            WriteProperty(info, key, value);
                            applied.Add(JsonValue.NewString(key));
                        }
                        catch (Exception ex)
                        {
                            failed.Add(JsonValue.NewString(key + "：" + ex.Message));
                        }
                    }
                    row.Set("applied", applied);
                    if (failed.Count > 0) row.Set("failed", failed);
                }

                rows.Add(row);
            }

            result.Set("objects", rows);
            return result;
        }

        // ---------------------------------------------------------------
        // 定位对象
        // ---------------------------------------------------------------

        private class ObjectInfo
        {
            public string Kind;          // page / function / project
            public string TypeName;
            public string Name;
            public string Page;
            public object Target;
        }

        private static List<ObjectInfo> Resolve(JsonValue selector)
        {
            List<ObjectInfo> found = new List<ObjectInfo>();

            // selector 里可以带 project，和顶层参数同义；写操作要能指定目标项目。
            string projectName = selector["project"].AsString(null);

            string pageName = selector["page"].AsString(null);
            string deviceTag = selector["deviceTag"].AsString(null);

            if (pageName != null)
            {
                Page page = Context.FindPage(pageName, projectName);
                ObjectInfo info = new ObjectInfo();
                info.Kind = "page";
                info.TypeName = page.GetType().Name;
                info.Name = page.Name;
                info.Page = page.Name;
                info.Target = page;
                found.Add(info);

                if (deviceTag != null)
                {
                    // 在该页里按设备标识找 Function。
                    foreach (Function function in page.Functions)
                    {
                        if (string.Equals(function.Name, deviceTag, StringComparison.OrdinalIgnoreCase))
                        {
                            found.Add(FunctionInfo(function, page.Name));
                            break;
                        }
                    }
                }
                return found;
            }

            if (deviceTag != null)
            {
                Project project = Context.Resolve(projectName);
                foreach (Page page in project.Pages)
                {
                    Function[] functions = page.Functions;
                    if (functions == null) continue;
                    foreach (Function function in functions)
                    {
                        if (string.Equals(function.Name, deviceTag, StringComparison.OrdinalIgnoreCase))
                            found.Add(FunctionInfo(function, page.Name));
                    }
                }
                return found;
            }

            // 只给了 objectId 或什么都没给：退到当前项目。
            Project current = Context.Resolve(projectName);
            ObjectInfo projectInfo = new ObjectInfo();
            projectInfo.Kind = "project";
            projectInfo.TypeName = current.GetType().Name;
            projectInfo.Name = current.ProjectName;
            projectInfo.Target = current;
            found.Add(projectInfo);
            return found;
        }

        private static ObjectInfo FunctionInfo(Function function, string pageName)
        {
            ObjectInfo info = new ObjectInfo();
            info.Kind = "function";
            info.TypeName = function.GetType().Name;
            info.Name = function.Name;
            info.Page = pageName;
            info.Target = function;
            return info;
        }

        // ---------------------------------------------------------------
        // 属性读写
        // ---------------------------------------------------------------

        private static JsonValue ReadProperty(ObjectInfo info, string key)
        {
            UniversalPropertyList list = PropertyListOf(info);
            if (list == null) return JsonValue.NewString("(该对象没有属性表)");

            try
            {
                object anyId = ResolvePropertyId(info, key);
                if (anyId != null)
                {
                    PropertyValue value = list[(AnyPropertyId)anyId];
                    if (value == null || value.IsEmpty) return JsonValue.NewNull();
                    return JsonValue.NewString(value.ToString());
                }
                PropertyValue byName = list[key];
                if (byName == null || byName.IsEmpty) return JsonValue.NewNull();
                return JsonValue.NewString(byName.ToString());
            }
            catch (Exception ex)
            {
                return JsonValue.NewString("(读取失败: " + ex.Message + ")");
            }
        }

        private static void WriteProperty(ObjectInfo info, string key, string value)
        {
            UniversalPropertyList list = PropertyListOf(info);
            if (list == null) throw new HostException("NOT_WRITABLE", "该对象没有属性表。");

            object anyId = ResolvePropertyId(info, key);
            if (anyId != null)
            {
                list[(AnyPropertyId)anyId] = value;
                return;
            }
            list[key] = value;
        }

        private static UniversalPropertyList PropertyListOf(ObjectInfo info)
        {
            if (info.Kind == "page") return ((Page)info.Target).Properties;
            if (info.Kind == "function") return ((FunctionBase)info.Target).Properties;
            if (info.Kind == "project") return ((Project)info.Target).Properties;
            return null;
        }

        /// <summary>
        /// 把 "FUNC_COMMENT" 这样的名字解析成 AnyPropertyId。
        /// EPLAN 的静态属性（Properties.Function.FUNC_COMMENT）本身就是 AnyPropertyId 的子类，
        /// 反射取它们的值即可。
        /// </summary>
        private static object ResolvePropertyId(ObjectInfo info, string key)
        {
            Assembly assembly = typeof(Properties).Assembly;
            foreach (string typeName in KnownLists)
            {
                Type type = assembly.GetType(typeName);
                if (type == null) continue;
                PropertyInfo property = type.GetProperty(key, BindingFlags.Public | BindingFlags.Static);
                if (property == null) continue;
                object value = property.GetValue(null, null);
                if (value is AnyPropertyId) return value;
            }
            return null;
        }
    }
}
