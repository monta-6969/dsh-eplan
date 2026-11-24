// project_create：新建一个项目，并按需写入项目属性（例如作者）。
//
// EPLAN 新建项目要两样东西：
//   linkFilePath    项目文件（.elk）要落在哪里
//   templateFilePath 用哪个模板（.zw9 基础项目 / .ept 项目模板）
// 模板决定图框、标题栏、符号库、层设置 —— 不传模板建出来的项目是空壳，
// 画出来的图没有图框，用户一眼就看出不对。
using System;
using System.Collections.Generic;
using System.IO;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class ProjectCreateTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string name = args["name"].AsString(null);
            if (string.IsNullOrEmpty(name))
                throw new HostException("BAD_ARGUMENT", "缺少项目名（name），例如「三菱变频器」。");

            string directory = args["directory"].AsString(
                @"C:\Users\Public\EPLAN\Data\项目\Company name");
            string template = args["template"].AsString(null);
            JsonValue properties = args["properties"];
            bool dryRun = args["dryRun"].AsBool(false);

            string elkPath = Path.Combine(directory, name + ".elk");

            if (File.Exists(elkPath) || Directory.Exists(Path.Combine(directory, name + ".edb")))
                throw new HostException("PROJECT_EXISTS",
                    "项目「" + name + "」已经存在：" + elkPath + "。换个名字，或者用 project_open 打开它。");

            if (!Directory.Exists(directory))
                throw new HostException("BAD_ARGUMENT", "目录不存在：" + directory);

            if (string.IsNullOrEmpty(template))
                template = PickTemplate(args["templateName"].AsString(null));

            if (string.IsNullOrEmpty(template) || !File.Exists(template))
                throw new HostException("TEMPLATE_NOT_FOUND",
                    "找不到项目模板：" + (template ?? "(未指定)") +
                    "。模板决定图框和标题栏，必须给一个；常见位置是 C:\\Users\\Public\\EPLAN\\Data\\模板\\Company name\\ 下的 .zw9 或 .ept。");

            JsonValue result = JsonValue.NewObject();
            result.Set("name", name);
            result.Set("elkPath", elkPath);
            result.Set("template", template);
            result.Set("dryRun", dryRun);

            if (dryRun)
            {
                result.Set("created", false);
                result.Set("wouldCreate", true);
                return result;
            }

            ProjectManager manager = new ProjectManager();

            Project project;
            try
            {
                project = manager.CreateProject(elkPath, template);
            }
            catch (Exception ex)
            {
                throw new HostException("PROJECT_CREATE_FAILED",
                    "建项目失败：" + ex.GetType().Name + ": " + ex.Message, ex.ToString());
            }

            if (project == null)
                throw new HostException("PROJECT_CREATE_FAILED", "EPLAN 没有返回项目对象，创建可能没成功。");

            result.Set("created", true);

            JsonValue info = JsonValue.NewObject();
            info.Set("name", project.ProjectName);
            info.Set("path", project.ProjectLinkFilePath);
            info.Set("directory", project.ProjectDirectoryPath);
            info.Set("pageCount", project.Pages == null ? 0 : project.Pages.Length);
            result.Set("project", info);

            // 项目属性：EPLAN 的标识名没法从反射里枚举出来（Properties.Project 这个类
            // 在程序集里查不到），所以按调用方给的键逐个试，把每个键的成败如实报出来，
            // 而不是整批失败或整批假装成功。
            if (properties != null && properties.IsObject)
            {
                JsonValue applied = JsonValue.NewObject();
                JsonValue failed = JsonValue.NewObject();
                foreach (string key in properties.Keys)
                {
                    string ident = MapFriendly(key);
                    string text = properties[key].AsString("");
                    Exception error;
                    if (PropWriter.Write(project, ident, text, out error))
                    {
                        applied.Set(ident, text);
                    }
                    else
                    {
                        failed.Set(ident, error.GetType().Name + ": " + error.Message);
                    }
                }
                result.Set("propertiesApplied", applied);
                result.Set("propertiesFailed", failed);
            }

            // 作者这类信息如果用户在 EPLAN 里看得见，多半是通过「项目属性」对话框。
            // 这里额外报告一份实际读回来的值，方便核对有没有真的写进去。
            JsonValue probe = ProbeAuthor(project);
            if (probe != null) result.Set("authorProbe", probe);

            return result;
        }

        /// <summary>没指定模板时，从模板目录里挑一个基础项目（优先 GB）。</summary>
        private static string PickTemplate(string preferred)
        {
            string root = @"C:\Users\Public\EPLAN\Data\模板\Company name";
            if (!Directory.Exists(root)) return null;

            string[] order = preferred != null
                ? new string[] { preferred }
                : new string[] { "GB_tpl001.ept", "GB_bas001.zw9", "IEC_tpl001.ept", "IEC_bas001.zw9" };

            foreach (string candidate in order)
            {
                string full = Path.Combine(root, candidate);
                if (File.Exists(full)) return full;
            }

            string[] any = Directory.GetFiles(root, "*.zw9");
            if (any.Length > 0) return any[0];
            any = Directory.GetFiles(root, "*.ept");
            return any.Length > 0 ? any[0] : null;
        }

        /// <summary>把项目身份相关的属性读回来，确认真的写进去了。</summary>
        private static JsonValue ProbeAuthor(Project project)
        {
            string[] idents = new string[]
            {
                "PROJ_CREATORLONGNAME",   // 创建者（长名）—— 标题栏里的「作者」就是它
                "PROJ_RESPONSIBLEFORPROJECT",
                "PROJ_CREATORNAME",
            };

            JsonValue found = JsonValue.NewObject();
            bool any = false;
            foreach (string ident in idents)
            {
                string text = PropWriter.Read(project, ident);
                if (text == null) continue;
                found.Set(ident, text);
                any = true;
            }
            return any ? found : null;
        }

        /// <summary>把用户好写的短名字映射到 EPLAN 的标识名。</summary>
        private static string MapFriendly(string key)
        {
            switch (key.ToLowerInvariant())
            {
                case "author": return "PROJ_CREATORLONGNAME";
                case "creator": return "PROJ_CREATORLONGNAME";
                case "responsible": return "PROJ_RESPONSIBLEFORPROJECT";
                case "note": return "PROJ_CREATORNOTE";
                default: return key;   // 已经是标识名就原样用
            }
        }
    }
}
