// actions：查 EPLAN 里到底有哪些动作。
//
// 为什么需要：ActionManager 是**进程内** API，在 EPLAN 外面（通过 Remoting 连过来的
// 测试程序）调用 FindAction 对任何名字都永远返回 null。只有在 EPLAN 进程内查才有意义。
//
// 用途：
//   1. 批量探测动作名是否存在
//   2. 枚举所有已注册动作（list=true），找界面跳转之类的内部动作
using System;
using System.Collections.Generic;
using System.Reflection;
using Eplan.EplApi.ApplicationFramework;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class ActionsTool
    {
        public static JsonValue Run(JsonValue args)
        {
            JsonValue result = JsonValue.NewObject();
            ActionManager manager = new ActionManager();

            string probe = args["probe"].AsString(null);
            if (!string.IsNullOrEmpty(probe))
            {
                result.Set("probe", probe);
                result.Set("found", Exists(manager, probe));
                return result;
            }

            JsonValue names = args["names"];
            if (names != null && names.IsArray && names.Count > 0)
            {
                JsonValue found = JsonValue.NewArray();
                JsonValue missing = JsonValue.NewArray();
                for (int i = 0; i < names.Count; i++)
                {
                    string name = names[i].AsString(null);
                    if (string.IsNullOrEmpty(name)) continue;
                    if (Exists(manager, name)) found.Add(JsonValue.NewString(name));
                    else missing.Add(JsonValue.NewString(name));
                }
                result.Set("found", found);
                result.Set("missing", missing);
                return result;
            }

            // 查一个动作的元数据（参数名就在里面）。
            // 用途：像 XSeGotoGraphicOpenPageAction 这种没文档的内部动作，
            // 靠它才能知道参数该叫什么，而不是一个个试。
            string props = args["props"].AsString(null);
            if (!string.IsNullOrEmpty(props))
            {
                Eplan.EplApi.ApplicationFramework.Action target = manager.FindAction(props, true);
                if (target == null)
                    throw new HostException("ACTION_MISSING", "EPLAN 里没有动作：" + props);
                result.Set("action", props);
                // Action 包装类没有 GetActionProperties（那是 IEplAction 上的方法），
                // 所以这里直接把这个对象能读到的成员倒出来，参数名就从里面找。
                result.Set("members", DescribeProperties(target));
                // ActionProperties.GetParameterProperties() 返回这个动作的全部参数定义，
                // 内部动作的参数名只能从这里拿到。
                try
                {
                    System.Reflection.MethodInfo gp =
                        target.ActionProperties.GetType().GetMethod("GetParameterProperties");
                    if (gp != null)
                    {
                        object raw = gp.Invoke(target.ActionProperties, null);
                        JsonValue defs = JsonValue.NewArray();
                        System.Collections.IEnumerable items = raw as System.Collections.IEnumerable;
                        if (items != null)
                        {
                            foreach (object item in items)
                                defs.Add(DescribeProperties(item));
                        }
                        result.Set("parameterDefs", defs);
                    }
                }
                catch (Exception ex)
                {
                    result.Set("parameterDefsError", ex.GetType().Name + ": " + ex.Message);
                }
                return result;
            }

            // 执行一个动作：参数要通过 ActionCallingContext 传。
            string run = args["run"].AsString(null);
            if (!string.IsNullOrEmpty(run))
            {
                result.Set("run", run);
                JsonValue parameters = args["parameters"];
                string output = Execute(manager, run, parameters);
                result.Set("executed", output != null);
                if (output != null) result.Set("message", output);
                return result;
            }

            // 枚举：ActionManager 没有公开的枚举方法，用反射找私有成员。
            result.Set("methods", DescribeMembers(manager.GetType()));
            return result;
        }

        /// <summary>
        /// 在当前（EPLAN 主线程）上下文里执行一个动作。
        /// 返回动作写进 context.Message 的文本，没有则为空串。
        /// </summary>
        private static string Execute(ActionManager manager, string name, JsonValue parameters)
        {
            Eplan.EplApi.ApplicationFramework.Action action = manager.FindAction(name, true);
            if (action == null) return null;

            ActionCallingContext context = new ActionCallingContext();
            if (parameters != null && parameters.IsObject)
            {
                foreach (string key in parameters.Keys)
                    context.AddParameter(key, parameters[key].AsString(string.Empty));
            }

            try
            {
                action.Execute(context);
            }
            catch (Exception ex)
            {
                return "EXECUTE_FAILED " + ex.GetType().Name + ": " + ex.Message;
            }

            // ActionCallingContext 没有 Message 属性；要读消息得拿它的参数块。
            try
            {
                Eplan.EplApi.Base.ContextParameterBlock block = context.GetContextParameter();
                object raw = null;
                if (block != null && block.Get("Message", ref raw) && raw != null)
                    return raw as string ?? raw.ToString();
            }
            catch { }
            return string.Empty;
        }

        /// <summary>把 ActionProperties 的公开成员和当前值倒出来。</summary>
        private static JsonValue DescribeProperties(object properties)
        {
            JsonValue list = JsonValue.NewArray();
            if (properties == null) return list;
            Type type = properties.GetType();
            BindingFlags flags = BindingFlags.Public | BindingFlags.Instance;

            foreach (PropertyInfo p in type.GetProperties(flags))
            {
                JsonValue item = JsonValue.NewObject();
                item.Set("kind", "property");
                item.Set("name", p.Name);
                item.Set("type", p.PropertyType.Name);
                try
                {
                    object value = p.GetValue(properties, null);
                    if (value != null) item.Set("value", value.ToString());
                }
                catch { }
                list.Add(item);
            }

            foreach (MethodInfo m in type.GetMethods(flags))
            {
                if (m.IsSpecialName) continue;
                if (m.DeclaringType == typeof(object)) continue;
                JsonValue item = JsonValue.NewObject();
                item.Set("kind", "method");
                item.Set("name", m.Name);
                JsonValue ps = JsonValue.NewArray();
                foreach (ParameterInfo p in m.GetParameters())
                    ps.Add(JsonValue.NewString(p.ParameterType.Name + " " + p.Name));
                item.Set("params", ps);
                list.Add(item);
            }
            return list;
        }

        private static JsonValue DescribeMembers(Type type)
        {
            JsonValue list = JsonValue.NewArray();
            BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

            foreach (MethodInfo m in type.GetMethods(flags))
            {
                if (m.IsSpecialName) continue;
                JsonValue item = JsonValue.NewObject();
                item.Set("kind", "method");
                item.Set("name", m.Name);
                item.Set("isPublic", m.IsPublic);
                JsonValue ps = JsonValue.NewArray();
                foreach (ParameterInfo p in m.GetParameters())
                    ps.Add(JsonValue.NewString(p.ParameterType.Name + " " + p.Name));
                item.Set("params", ps);
                list.Add(item);
            }
            foreach (PropertyInfo p in type.GetProperties(flags))
            {
                JsonValue item = JsonValue.NewObject();
                item.Set("kind", "property");
                item.Set("name", p.Name);
                item.Set("type", p.PropertyType.Name);
                item.Set("isPublic", p.GetMethod != null && p.GetMethod.IsPublic);
                list.Add(item);
            }
            return list;
        }

        private static bool Exists(ActionManager manager, string name)
        {
            try
            {
                // 写全名：System.Action 和 Eplan 的 Action 会撞名（CS0104）。
                Eplan.EplApi.ApplicationFramework.Action action = manager.FindAction(name, true);
                return action != null;
            }
            catch
            {
                return false;
            }
        }
    }
}
