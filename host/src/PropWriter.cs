// 写 EPLAN 属性的统一入口。
//
// 踩出来的两个坑，记在这里免得再踩：
//
// 1. `project.Properties["PROJ_CREATORLONGNAME"]` —— 字符串索引器对**所有** PROJ_ 标识名
//    都抛 `PropertyNotFoundException: S063109属性无效`。别用索引器。
//
// 2. `type.GetProperty("PROJ_CREATORLONGNAME", ...)` 抛 `AmbiguousMatchException`，
//    因为每个属性名都有重载（一个是单值，一个是带 Int32 index 的多值版本）。
//    必须遍历 `GetProperties()` 挑 `GetIndexParameters().Length == 0` 的那个。
using System;
using System.Reflection;
using Eplan.EplApi.DataModel;

namespace EplanMcpHost
{
    internal static class PropWriter
    {
        /// <summary>把一个属性的值读出来；读不到返回 null。</summary>
        public static string Read(Project project, string ident)
        {
            PropertyValue value = Find(project, ident);
            if (value == null) return null;
            try { return value.ToString(); }
            catch { return null; }
        }

        /// <summary>写一个属性。成功返回 true，失败时 ex 带回原因。</summary>
        public static bool Write(Project project, string ident, string text, out Exception error)
        {
            error = null;
            PropertyValue value = Find(project, ident);
            if (value == null)
            {
                error = new InvalidOperationException("EPLAN 里没有名为 " + ident + " 的项目属性。");
                return false;
            }
            try
            {
                value.Set(text ?? string.Empty);
                return true;
            }
            catch (Exception ex)
            {
                error = ex;
                return false;
            }
        }

        private static PropertyValue Find(Project project, string ident)
        {
            if (project == null || string.IsNullOrEmpty(ident)) return null;

            PropertyInfo member = null;
            foreach (PropertyInfo candidate in project.Properties.GetType().GetProperties(
                BindingFlags.Public | BindingFlags.Instance))
            {
                if (candidate.Name != ident) continue;
                if (candidate.GetIndexParameters().Length != 0) continue;
                if (candidate.PropertyType != typeof(PropertyValue)) continue;
                member = candidate;
                break;
            }
            if (member == null) return null;

            try { return member.GetValue(project.Properties, null) as PropertyValue; }
            catch { return null; }
        }
    }
}
