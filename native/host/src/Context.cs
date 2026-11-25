// 上下文：当前项目、页面查找、SymbolLibrary 缓存、写前备份。
// 所有操作都通过它拿到 Project/Page，保证「只有一个地方决定用哪个项目」。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.MasterData;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class Context
    {
        private static readonly Dictionary<string, SymbolLibrary> LibraryCache =
            new Dictionary<string, SymbolLibrary>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// 当前项目。没有打开项目时抛可读的错误。
        ///
        /// 允许 args.project 指定项目名（或 .elk 路径），避免误写到用户正在画的图上。
        /// 指定了就必须已经打开；名字对不上直接报错，绝不"猜"一个项目来写。
        /// </summary>
        public static Project Project
        {
            get { return Resolve(null); }
        }

        public static Project Resolve(string wanted)
        {
            ProjectManager manager = new ProjectManager();
            Project project;

            if (!string.IsNullOrEmpty(wanted))
            {
                project = FindOpenProject(manager, wanted);
                if (project == null)
                {
                    throw new HostException("PROJECT_NOT_OPEN",
                        "指定的项目「" + wanted + "」没有在 EPLAN 里打开。请先在 EPLAN 中打开它，" +
                        "或者用 status 查看当前打开了哪些项目。");
                }
            }
            else
            {
                project = manager.CurrentProject;
                if (project == null)
                {
                    Project[] open = manager.OpenProjects;
                    if (open != null && open.Length > 0) project = open[0];
                }
                if (project == null)
                {
                    throw new HostException("NO_PROJECT",
                        "EPLAN 里没有打开的项目。请先打开一个项目，并告诉我它的名字。");
                }
            }

            if (project.IsReadOnly)
            {
                throw new HostException("PROJECT_READONLY",
                    "项目是只读的（" + project.ProjectName + "），无法写入。");
            }
            return project;
        }

        /// <summary>从已打开的项目里按名字或路径找。只认已打开的，不会替你打开。</summary>
        private static Project FindOpenProject(ProjectManager manager, string wanted)
        {
            Project[] open = manager.OpenProjects;
            if (open == null) return null;

            string trimmed = wanted.Trim();
            foreach (Project p in open)
            {
                if (string.Equals(p.ProjectName, trimmed, StringComparison.OrdinalIgnoreCase)) return p;
            }
            // 也接受带 .elk 的文件名或完整路径。
            string leaf = trimmed;
            try { if (trimmed.IndexOf('\\') >= 0) leaf = Path.GetFileNameWithoutExtension(trimmed); } catch { }
            foreach (Project p in open)
            {
                if (string.Equals(p.ProjectName, leaf, StringComparison.OrdinalIgnoreCase)) return p;
                try
                {
                    if (string.Equals(p.ProjectLinkFilePath, trimmed, StringComparison.OrdinalIgnoreCase)) return p;
                }
                catch { }
            }
            return null;
        }


        public static Page FindPage(string pageName)
        {
            return FindPage(pageName, null);
        }

        public static Page FindPage(string pageName, string projectName)
        {
            if (string.IsNullOrEmpty(pageName))
                throw new HostException("BAD_ARGUMENT", "缺少页名（page）。");

            Project project = Resolve(projectName);
            string wanted = pageName.Trim();

            // 精确匹配 Name，其次 IdentifyingName，再次 FullName。
            Page loose = null;
            foreach (Page page in project.Pages)
            {
                if (string.Equals(page.Name, wanted, StringComparison.OrdinalIgnoreCase)) return page;
                if (string.Equals(page.IdentifyingName, wanted, StringComparison.OrdinalIgnoreCase)) return page;
                if (loose == null && string.Equals(page.Properties.PAGE_FULLNAME.ToString(), wanted, StringComparison.OrdinalIgnoreCase))
                    loose = page;
            }
            if (loose != null) return loose;

            throw new HostException("PAGE_NOT_FOUND",
                "项目「" + project.ProjectName + "」里没有页「" + wanted + "」。可以先调用 pages 查看现有页名。");
        }

        public static SymbolLibrary Library(string name)
        {
            return Library(name, null);
        }

        public static SymbolLibrary Library(string name, string projectName)
        {
            if (string.IsNullOrEmpty(name)) name = "GB_symbol";

            // 缓存键要带项目：同一个库名在不同项目里可能指向不同的 .slk。
            Project project = Resolve(projectName);
            string key = project.ProjectName + "|" + name;

            SymbolLibrary cached;
            if (LibraryCache.TryGetValue(key, out cached)) return cached;

            SymbolLibrary library = new SymbolLibrary(project, name);
            LibraryCache[key] = library;
            return library;
        }

        public static void ClearLibraryCache()
        {
            LibraryCache.Clear();
        }

        /// <summary>把 PointD 从 JSON [x, y] 解析出来。</summary>
        public static PointD Point(JsonValue value, string fieldName)
        {
            if (value == null || !value.IsArray || value.Count < 2)
                throw new HostException("BAD_ARGUMENT", "坐标 " + fieldName + " 必须是 [x, y] 两个数字。");
            double x = value[0].AsDouble(double.NaN);
            double y = value[1].AsDouble(double.NaN);
            if (double.IsNaN(x) || double.IsNaN(y))
                throw new HostException("BAD_ARGUMENT", "坐标 " + fieldName + " 含非数字: " + Json.Write(value));
            return new PointD(x, y);
        }

        public static JsonValue PointJson(PointD p)
        {
            JsonValue array = JsonValue.NewArray();
            array.Add(JsonValue.NewNumber(p.X));
            array.Add(JsonValue.NewNumber(p.Y));
            return array;
        }
    }
}
