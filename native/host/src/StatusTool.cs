// status：任何绘图之前的第一件事。
// 只读，不修改项目。
using System;
using System.IO;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.MasterData;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class StatusTool
    {
        public static JsonValue Run(JsonValue args)
        {
            JsonValue result = JsonValue.NewObject();
            result.Set("unit", "mm");
            result.Set(
                "coordinateSystem",
                "原点在页面左下角，X 向右、Y 向上，单位 mm");

            // 让模型知道「用户现在到底看得见哪一页」。
            // 数据改对了但界面停在别的页，对用户来说等于没做，这一点必须可查询。
            try
            {
                string title = System.Diagnostics.Process.GetCurrentProcess().MainWindowTitle;
                result.Set("windowTitle", title);
                result.Set("visiblePage", PageFromTitle(title));
            }
            catch { }

            ProjectManager manager = new ProjectManager();
            Project project = manager.CurrentProject;

            JsonValue open = JsonValue.NewArray();
            Project[] projects = manager.OpenProjects;
            if (projects != null)
            {
                foreach (Project p in projects)
                {
                    JsonValue item = JsonValue.NewObject();
                    item.Set("name", p.ProjectName);
                    item.Set("path", p.ProjectLinkFilePath);
                    item.Set("isCurrent", project != null && ProjectNameEquals(p, project));
                    item.Set("isReadOnly", p.IsReadOnly);
                    open.Add(item);
                }
            }
            result.Set("openProjects", open);

            if (project == null)
            {
                result.Set("ready", false);
                result.Set("currentProject", (string)null);
                result.Set("hint", "EPLAN 里还没有打开的项目，先打开一个再绘图。");
                return result;
            }

            JsonValue current = JsonValue.NewObject();
            current.Set("name", project.ProjectName);
            current.Set("path", project.ProjectLinkFilePath);
            current.Set("directory", project.ProjectDirectoryPath);
            current.Set("isReadOnly", project.IsReadOnly);
            current.Set("isLocked", project.IsLocked);
            current.Set("pageCount", project.Pages == null ? 0 : project.Pages.Length);

            JsonValue libraries = JsonValue.NewArray();
            if (project.SymbolLibraries != null)
            {
                foreach (SymbolLibrary library in project.SymbolLibraries)
                {
                    JsonValue item = JsonValue.NewObject();
                    item.Set("name", library.Name);
                    libraries.Add(item);
                }
            }
            current.Set("symbolLibraries", libraries);
            result.Set("currentProject", current);
            result.Set("ready", true);
            AppendLibraries(result);
            AppendSkills(result);
            return result;
        }


        /// <summary>从 EPLAN 主窗口标题里取当前显示的那一页；取不到返回 null。</summary>
        private static string PageFromTitle(string title)
        {
            if (string.IsNullOrEmpty(title)) return null;
            int index = title.LastIndexOf(" - ", StringComparison.Ordinal);
            if (index < 0 || index + 3 >= title.Length) return null;
            string page = title.Substring(index + 3).Trim();
            if (page.Length == 0) return null;

            // 项目刚打开、还没切到具体页时，标题后半段是**项目路径**而不是页名。
            // 不认出来的话 visiblePage 会报一条 "C:\...\test"，模型会以为用户正看着那一页。
            // 页名的结构标识一定带 "/"，而路径带反斜杠 —— 用这个区分，不猜。
            if (page.IndexOf('\\') >= 0 || page.IndexOf('/') < 0) return null;

            return page;
        }

        private static bool ProjectNameEquals(Project a, Project b)
        {
            return string.Equals(a.ProjectName, b.ProjectName, StringComparison.OrdinalIgnoreCase)
                && string.Equals(a.ProjectLinkFilePath, b.ProjectLinkFilePath, StringComparison.OrdinalIgnoreCase);
        }


        // ---------------------------------------------------------------
        // 有哪些符号库，让宿主自己说。
        //
        // 库名写错是新手最常犯的错：GB_symbol 里没有 T 节点，SPECIAL 里没有熔断器，
        // 拿错库只会得到一句「找不到符号」。把这个列表给出去，模型就不用猜了。
        // ---------------------------------------------------------------
        private static void AppendLibraries(JsonValue result)
        {
            try
            {
                ProjectManager manager = new ProjectManager();
                Project project = manager.CurrentProject;
                if (project == null) return;

                JsonValue names = JsonValue.NewArray();
                SymbolLibrary[] libraries = project.SymbolLibraries;
                if (libraries != null)
                {
                    foreach (SymbolLibrary library in libraries)
                    {
                        if (library == null) continue;
                        names.Add(JsonValue.NewString(library.Name));
                    }
                }
                result.Set("symbolLibraries", names);
            }
            catch { }
        }

        // ---------------------------------------------------------------
        // 知识文件在哪，要由宿主自己报，不能让模型猜。
        //
        // 人设里写的是「去读 skills/xxx/SKILL.md」，但安装目录每台机器不一样；
        // 写死路径换个地方就失效，让模型去找又纯属浪费往返。
        // 宿主的 DLL 就在 <安装目录>\native\host\bin\ 下，往上三层就是 bundle 根。
        // ---------------------------------------------------------------
        private static void AppendSkills(JsonValue result)
        {
            try
            {
                string hostDir = Path.GetDirectoryName(typeof(StatusTool).Assembly.Location);
                if (string.IsNullOrEmpty(hostDir)) return;

                string root = Path.GetFullPath(Path.Combine(hostDir, "..", "..", ".."));
                string skillsDir = Path.Combine(root, "skills");
                result.Set("skillsDir", skillsDir);
                if (!Directory.Exists(skillsDir)) return;

                JsonValue found = JsonValue.NewArray();
                string[] files = Directory.GetFiles(skillsDir, "SKILL.md", SearchOption.AllDirectories);
                Array.Sort(files);
                foreach (string file in files) found.Add(JsonValue.NewString(file));
                result.Set("skills", found);
            }
            catch { }
        }

    }
}
