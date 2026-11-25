// project_open / project_close：开、关项目。
//
// 为什么需要：
//   MCP 会话常常在 EPLAN 刚启动、还没有打开任何项目的时候接入。
//   之前只能靠人先手工打开项目，否则所有工具都报 PROJECT_NOT_OPEN。
//   把这一步做进工具里，"链接实时性"才完整：连不上就自己把项目拉起来。
//
// 实现细节：ProjectManager.OpenProject 的第二个参数是个嵌套枚举
// （ProjectManager+OpenMode），这里用反射取值，避免写死枚举成员名——
// 不同版本 EPLAN 的枚举成员不完全一样。
using System;
using System.Reflection;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class ProjectTool
    {
        private const string DefaultProjectDir = @"C:\Users\Public\EPLAN\Data\项目\Company name";

        public static JsonValue Open(JsonValue args)
        {
            string path = args["path"].AsString(null);
            string name = args["name"].AsString(null);

            if (string.IsNullOrEmpty(path))
            {
                if (string.IsNullOrEmpty(name))
                    throw new HostException("BAD_ARGUMENT",
                        "project_open 需要 path（.elk 完整路径）或 name（项目名）之一。");
                string dir = args["dir"].AsString(DefaultProjectDir);
                path = System.IO.Path.Combine(dir, name + ".elk");
            }

            if (!System.IO.File.Exists(path))
                throw new HostException("PROJECT_FILE_MISSING",
                    "找不到项目文件：" + path + "。检查项目名或目录是否正确。");

            ProjectManager manager = new ProjectManager();
            JsonValue result = JsonValue.NewObject();
            result.Set("path", path);

            // 已经打开就直接返回，避免重复打开触发 EPLAN 的"项目已被占用"。
            Project already = FindOpen(manager, path);
            if (already != null)
            {
                result.Set("alreadyOpen", true);
                result.Set("project", Describe(already));
                return result;
            }

            InvokeOpen(manager, path);

            // 开完之后不一定能立刻读 CurrentProject：在 LockingStep 之外访问它
            // 会抛 S063110。所以按「CurrentProject → 按路径找 → 取最后一个」三级回退。
            Project opened = null;
            try { opened = manager.CurrentProject; } catch { }
            if (opened == null) opened = FindOpen(manager, path);
            if (opened == null)
            {
                try
                {
                    Project[] all = manager.OpenProjects;
                    if (all != null && all.Length > 0) opened = all[all.Length - 1];
                }
                catch { }
            }
            if (opened == null)
                throw new HostException("PROJECT_OPEN_FAILED",
                    "OpenProject 调用返回了，但拿不到打开后的项目对象。检查该项目是否被别的 EPLAN 实例占用。");

            result.Set("alreadyOpen", false);
            result.Set("project", Describe(opened));
            return result;
        }

        public static JsonValue Close(JsonValue args)
        {
            ProjectManager manager = new ProjectManager();
            Project project = Context.Resolve(args["project"].AsString(null));
            string name = project.ProjectName;
            project.Close();
            JsonValue result = JsonValue.NewObject();
            result.Set("closed", true);
            result.Set("project", name);
            return result;
        }

        private static Project FindOpen(ProjectManager manager, string path)
        {
            Project[] open = manager.OpenProjects;
            if (open == null) return null;
            foreach (Project project in open)
            {
                try
                {
                    if (string.Equals(project.ProjectLinkFilePath, path, StringComparison.OrdinalIgnoreCase))
                        return project;
                }
                catch { }
            }
            return null;
        }

        /// <summary>
        /// 反射调用 OpenProject。优先用 (string, OpenMode) 重载，
        /// OpenMode 取枚举里第一个值或名为 Standard 的那个。
        /// </summary>
        private static void InvokeOpen(ProjectManager manager, string path)
        {
            MethodInfo withMode = null;
            MethodInfo single = null;

            foreach (MethodInfo method in manager.GetType().GetMethods(
                BindingFlags.Public | BindingFlags.Instance))
            {
                if (method.Name != "OpenProject") continue;
                ParameterInfo[] parameters = method.GetParameters();
                if (parameters.Length == 1 && parameters[0].ParameterType == typeof(string))
                    single = method;
                if (parameters.Length == 2
                    && parameters[0].ParameterType == typeof(string)
                    && !parameters[1].ParameterType.IsByRef)
                    withMode = method;
            }

            if (withMode != null)
            {
                Type enumType = withMode.GetParameters()[1].ParameterType;
                object mode = null;
                try { mode = Enum.Parse(enumType, "Standard"); }
                catch { }
                if (mode == null)
                {
                    Array values = Enum.GetValues(enumType);
                    if (values.Length > 0) mode = values.GetValue(0);
                }
                if (mode == null)
                    throw new HostException("PROJECT_OPEN_FAILED",
                        "无法构造 OpenMode 值（枚举 " + enumType.FullName + " 没有任何成员）。");
                withMode.Invoke(manager, new object[] { path, mode });
                return;
            }

            if (single != null)
            {
                single.Invoke(manager, new object[] { path });
                return;
            }

            throw new HostException("PROJECT_OPEN_UNSUPPORTED",
                "ProjectManager 上没有 OpenProject(string) 或 OpenProject(string, OpenMode) 重载。");
        }

        private static JsonValue Describe(Project project)
        {
            JsonValue item = JsonValue.NewObject();
            try { item.Set("name", project.ProjectName); } catch { }
            try { item.Set("path", project.ProjectLinkFilePath); } catch { }
            try { item.Set("directory", project.ProjectDirectoryPath); } catch { }
            try { item.Set("isReadOnly", project.IsReadOnly); } catch { }
            try { item.Set("pageCount", JsonValue.NewNumber(project.Pages.Length)); } catch { }
            return item;
        }
    }
}
