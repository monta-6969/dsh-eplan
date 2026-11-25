// export：把项目或指定页导出成 PNG / PDF / DXF。
// PNG 用于模型自己 read_image 检查画得对不对，PDF/DXF 用于交付。
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.HEServices;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class ExportTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string kind = args["kind"].AsString("png").ToLowerInvariant();
            JsonValue pageNames = args["pages"];
            string outDir = args["outDir"].AsString(null);
            string fileName = args["fileName"].AsString(null);

            string projectName = args["project"].AsString(null);
            Project project = Context.Resolve(projectName);
            if (outDir == null)
                outDir = Path.Combine(project.ProjectDirectoryPath, "_eplan_export");
            if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir);

            string stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss", System.Globalization.CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(fileName)) fileName = project.ProjectName + "_" + stamp;

            List<Page> pages = new List<Page>();
            if (pageNames != null && pageNames.IsArray && pageNames.Count > 0)
            {
                for (int i = 0; i < pageNames.Count; i++)
                    pages.Add(Context.FindPage(pageNames[i].AsString(null), projectName));
            }

            JsonValue result = JsonValue.NewObject();
            result.Set("kind", kind);
            result.Set("outDir", outDir);
            result.Set("project", project.ProjectName);

            JsonValue files = JsonValue.NewArray();
            Export service = new Export();
            try
            {
                switch (kind)
                {
                    case "png":
                        files = ExportPng(service, project, pages, outDir, fileName,
                            args["theme"].AsString("dark").ToLowerInvariant());
                        break;
                    case "pdf":
                        files = ExportPdf(service, project, pages, outDir, fileName);
                        break;
                    case "dxf":
                        files = ExportDxf(service, project, pages, outDir, fileName);
                        break;
                    default:
                        throw new HostException("BAD_ARGUMENT",
                            "不支持的导出格式「" + kind + "」。可用：png / pdf / dxf。");
                }
            }
            finally
            {
                try { service.Dispose(); } catch { }
            }

            result.Set("files", files);
            result.Set("count", files.Count);
            if (files.Count == 0)
                throw new HostException("EXPORT_EMPTY",
                    "导出没有产出任何文件（格式 " + kind + "）。检查页名是否正确、项目是否已保存。");
            return result;
        }

        /// <summary>按 theme 重新上色；失败不影响导出本身。</summary>
        private static void ApplyTheme(string path, string theme)
        {
            if (theme != "dark" || string.IsNullOrEmpty(path) || !File.Exists(path)) return;
            try { DarkScheme.Apply(path); } catch { }
        }

        private static JsonValue ExportPng(Export service, Project project, List<Page> pages, string outDir, string fileName, string theme)
        {
            JsonValue files = JsonValue.NewArray();

            if (pages.Count == 0)
            {
                // 整个项目：GraphicProjectEx 每页一张，返回文件列表。
                string[] produced = service.GraphicProjectEx(
                    project, outDir, Export.Format.PNG, 24, 1600, Export.Compression.None, false);
                if (produced != null)
                {
                    foreach (string path in produced)
                    {
                        if (string.IsNullOrEmpty(path)) continue;
                        ApplyTheme(path, theme);
                        files.Add(Describe(path));
                    }
                }
                return files;
            }

            // 坑：GraphicPageEx 的第二个参数是**输出目录**，不是文件路径。
            // 传 "xxx.png" 时 EPLAN 会把 xxx.png 建成一个目录，再把 <页名>.png 塞进去。
            // 所以这里给目录，然后拿返回值 —— 它才是真正的产物路径。
            Directory.CreateDirectory(outDir);
            for (int i = 0; i < pages.Count; i++)
            {
                string produced = service.GraphicPageEx(
                    pages[i], outDir, Export.Format.PNG, 24, 1600, Export.Compression.None, false);

                if (!string.IsNullOrEmpty(produced) && File.Exists(produced))
                {
                    ApplyTheme(produced, theme);
                    files.Add(Describe(produced));
                    continue;
                }

                // 返回值不可用时按 EPLAN 的命名约定回查一遍：页名里的 = + / 会变成下划线。
                string expected = Path.Combine(outDir, Sanitize(pages[i].Name) + ".png");
                if (File.Exists(expected))
                {
                    ApplyTheme(expected, theme);
                    files.Add(Describe(expected));
                }
                else
                {
                    files.Add(Describe(produced ?? expected));
                }
            }
            return files;
        }

        private static JsonValue ExportPdf(Export service, Project project, List<Page> pages, string outDir, string fileName)
        {
            JsonValue files = JsonValue.NewArray();
            string target = Path.Combine(outDir, fileName + ".pdf");

            if (pages.Count == 0)
            {
                service.PdfProject(project, string.Empty, target,
                    Export.DegreeOfColor.Color, false, string.Empty, true);
            }
            else
            {
                // PdfPages 要 ArrayList，里面是 Page 对象。
                ArrayList list = new ArrayList();
                foreach (Page page in pages) list.Add(page);
                service.PdfPages(list, string.Empty, target,
                    Export.DegreeOfColor.Color, false, string.Empty, true);
            }
            files.Add(Describe(target));
            return files;
        }

        private static JsonValue ExportDxf(Export service, Project project, List<Page> pages, string outDir, string fileName)
        {
            JsonValue files = JsonValue.NewArray();

            if (pages.Count == 0)
            {
                service.DxfDwgProjectToDisk(project, string.Empty, outDir, string.Empty);
                // DXF 导出没有返回值，扫描目录里最新的 dxf 文件。
                string[] produced = Directory.GetFiles(outDir, "*.dxf");
                foreach (string path in produced) files.Add(Describe(path));
                return files;
            }

            for (int i = 0; i < pages.Count; i++)
            {
                service.DxfDwgPageToDisk(
                    pages[i], string.Empty, outDir, fileName + "_" + Sanitize(pages[i].Name), string.Empty);
            }

            // 同样按命名约定回查。
            for (int i = 0; i < pages.Count; i++)
            {
                string expected = Path.Combine(outDir, fileName + "_" + Sanitize(pages[i].Name) + ".dxf");
                if (File.Exists(expected)) files.Add(Describe(expected));
            }
            return files;
        }

        private static string Sanitize(string name)
        {
            if (string.IsNullOrEmpty(name)) return "page";
            char[] bad = Path.GetInvalidFileNameChars();
            System.Text.StringBuilder sb = new System.Text.StringBuilder(name.Length);
            foreach (char c in name)
            {
                if (Array.IndexOf(bad, c) >= 0 || c == '=' || c == '+' || c == '/' || c == '\\') sb.Append('_');
                else sb.Append(c);
            }
            return sb.ToString().Trim('_');
        }

        private static JsonValue Describe(string path)
        {
            JsonValue item = JsonValue.NewObject();
            item.Set("path", path);
            try
            {
                FileInfo info = new FileInfo(path);
                item.Set("exists", info.Exists);
                if (info.Exists) item.Set("bytes", info.Length);
            }
            catch { }
            return item;
        }
    }
}
