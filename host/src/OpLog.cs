// 操作记录与回退（M2 实现）。
//
// 为什么要有这个东西：EPLAN API 的改动**不进 GUI 撤销栈**，Ctrl+Z 对它们无效；
// 而项目真正的数据在 .edb 目录里，复制 .elk 链接文件根本不算备份。
// 也就是说模型一旦改错，用户没有任何办法退回去。这个日志是唯一的退路。
//
// 设计（见 docs/interfaces.md）：
//   - 记录由写操作自己在落盘之后追加，模型不需要调用任何「开始记录」的工具
//   - 一行一条 JSON（JSONL），追加式写入，不需要锁
//   - undo 是描述符而不是操作枚举：{"kind":"delete_page","page":"=X/1"}，
//     新增可回退的操作只要多一种 kind，不用改日志格式
//   - 记不进去也不能影响已经完成的绘图 —— 整个 Append 吞掉所有异常
//
// 目前能回退的：建页（删掉那页）、插元件（删掉那个对象）。
// 不能回退的：删页、画图元、改属性 —— 这些在记录里标 undoable=false 并写明原因，
// 与其假装能撤，不如让调用方看到真相。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class OpJournal
    {
        /// <summary>日志目录。和备份、渲染图一样放临时目录，避免往用户的项目树里塞东西。</summary>
        internal static string RootDir
        {
            get { return Path.Combine(Path.GetTempPath(), "eplan-mcp", "ops"); }
        }

        /// <summary>一个项目一个文件，文件名只保留合法字符。</summary>
        internal static string FileFor(string projectName)
        {
            string safe = projectName;
            if (string.IsNullOrEmpty(safe)) safe = "unknown";
            char[] bad = Path.GetInvalidFileNameChars();
            StringBuilder sb = new StringBuilder(safe.Length);
            foreach (char c in safe) sb.Append(Array.IndexOf(bad, c) >= 0 ? '_' : c);
            return Path.Combine(RootDir, sb.ToString() + ".jsonl");
        }

        private static string NewId()
        {
            return "op" + DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture) +
                   Guid.NewGuid().ToString("N").Substring(0, 4);
        }

        /// <summary>追加一条记录。失败静默 —— 绘图已经落盘，不能因为写日志失败就让用户看到报错。</summary>
        public static void Append(string op, string projectName, string pageName, JsonValue undo, bool undoable, string reason)
        {
            try
            {
                JsonValue entry = JsonValue.NewObject();
                entry.Set("id", NewId());
                entry.Set("at", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
                entry.Set("op", op);
                entry.Set("project", projectName == null ? "" : projectName);
                entry.Set("page", pageName == null ? "" : pageName);
                entry.Set("undo", undo == null ? JsonValue.NewNull() : undo);
                entry.Set("undoable", undoable);
                if (!string.IsNullOrEmpty(reason)) entry.Set("reason", reason);
                entry.Set("undone", false);

                System.IO.Directory.CreateDirectory(RootDir);
                File.AppendAllText(FileFor(projectName), Json.Write(entry) + "\n", new UTF8Encoding(false));
            }
            catch
            {
            }
        }

        private static List<string> AllFiles()
        {
            List<string> files = new List<string>();
            try
            {
                if (System.IO.Directory.Exists(RootDir))
                    files.AddRange(System.IO.Directory.GetFiles(RootDir, "*.jsonl"));
            }
            catch
            {
            }
            return files;
        }

        private static int IntArg(JsonValue args, string key, int fallback)
        {
            JsonValue value = args[key];
            if (value == null || value.Kind != JsonKind.Number) return fallback;
            return (int)value.NumberValue;
        }

        /// <summary>查历史。参数：project / page / operation_id / limit。</summary>
        public static JsonValue History(JsonValue args)
        {
            string projectName = args["project"].AsString(null);
            if (string.IsNullOrEmpty(projectName))
            {
                try { projectName = Context.Project.ProjectName; }
                catch { projectName = null; }
            }

            string pageFilter = args["page"].AsString(null);
            string idFilter = args["operation_id"].AsString(null);
            int limit = IntArg(args, "limit", 30);
            if (limit < 1) limit = 1;

            List<string> files = new List<string>();
            if (!string.IsNullOrEmpty(projectName))
            {
                string file = FileFor(projectName);
                if (File.Exists(file)) files.Add(file);
            }
            else
            {
                files = AllFiles();
            }

            List<JsonValue> matched = new List<JsonValue>();
            foreach (string file in files)
            {
                string[] lines;
                try { lines = File.ReadAllLines(file, Encoding.UTF8); }
                catch { continue; }

                for (int i = 0; i < lines.Length; i++)
                {
                    if (lines[i].Length == 0) continue;
                    JsonValue entry;
                    try { entry = Json.Parse(lines[i]); }
                    catch { continue; }

                    if (!string.IsNullOrEmpty(pageFilter) && entry["page"].AsString("") != pageFilter) continue;
                    if (!string.IsNullOrEmpty(idFilter) && entry["id"].AsString("") != idFilter) continue;
                    matched.Add(entry);
                }
            }

            int total = matched.Count;
            int start = total > limit ? total - limit : 0;
            JsonValue list = JsonValue.NewArray();
            for (int i = total - 1; i >= start; i--) list.Add(matched[i]);

            JsonValue result = JsonValue.NewObject();
            result.Set("project", projectName == null ? JsonValue.NewNull() : JsonValue.NewString(projectName));
            result.Set("total", JsonValue.NewNumber(total));
            result.Set("returned", JsonValue.NewNumber(list.Count));
            result.Set("newestFirst", JsonValue.NewBool(true));
            result.Set("dir", JsonValue.NewString(RootDir));
            result.Set("operations", list);
            if (total == 0)
                result.Set("note", "这个项目还没有通过本预设做过写操作。历史只记本工具做的事，用户手画的不在里面。");
            return result;
        }

        /// <summary>撤回一次操作。参数：operation_id。</summary>
        public static JsonValue Rollback(JsonValue args)
        {
            string id = args["operation_id"].AsString(null);
            if (string.IsNullOrEmpty(id))
                throw new HostException("BAD_ARGUMENT", "要给 operation_id。", "用 op_history 查有哪些 id。");

            string file = null;
            int index = -1;
            JsonValue entry = null;

            foreach (string candidate in AllFiles())
            {
                string[] lines;
                try { lines = File.ReadAllLines(candidate, Encoding.UTF8); }
                catch { continue; }

                for (int i = 0; i < lines.Length; i++)
                {
                    if (lines[i].Length == 0) continue;
                    JsonValue parsed;
                    try { parsed = Json.Parse(lines[i]); }
                    catch { continue; }
                    if (parsed["id"].AsString("") == id) { file = candidate; index = i; entry = parsed; break; }
                }
                if (entry != null) break;
            }

            if (entry == null)
                throw new HostException("OP_NOT_FOUND", "没有这个操作记录：" + id,
                    "用 op_history 看这个项目有哪些操作 id。");

            JsonValue result = JsonValue.NewObject();
            result.Set("operation_id", JsonValue.NewString(id));
            result.Set("op", entry["op"]);
            result.Set("project", entry["project"]);
            result.Set("page", entry["page"]);

            if (entry["undone"].AsBool(false))
            {
                result.Set("undone", JsonValue.NewBool(true));
                result.Set("alreadyUndone", JsonValue.NewBool(true));
                result.Set("note", "这次操作之前已经撤回过了，本次什么都没做。");
                return result;
            }

            if (!entry["undoable"].AsBool(false))
            {
                result.Set("undone", JsonValue.NewBool(false));
                JsonValue reason = entry["reason"];
                result.Set("reason", reason == null || reason.Kind == JsonKind.Null
                    ? JsonValue.NewString("这次操作没有记录可用的回退方式。")
                    : reason);
                return result;
            }

            JsonValue undo = entry["undo"];
            string kind = undo == null ? "" : undo["kind"].AsString("");
            string projectName = entry["project"].AsString(null);
            string pageName = entry["page"].AsString(null);

            if (kind == "delete_page")
            {
                Page page = Context.FindPage(pageName, projectName);
                int functions = page.Functions == null ? 0 : page.Functions.Length;
                page.Remove();
                result.Set("undone", JsonValue.NewBool(true));
                result.Set("action", JsonValue.NewString("删掉这次建的页"));
                result.Set("removedFunctions", JsonValue.NewNumber(functions));
            }
            else if (kind == "remove_object")
            {
                string objectName = undo["name"].AsString(null);
                Page page = Context.FindPage(pageName, projectName);
                Function target = null;
                if (page.Functions != null)
                {
                    foreach (Function function in page.Functions)
                    {
                        if (function.Name == objectName) { target = function; break; }
                    }
                }
                if (target == null)
                    throw new HostException("ROLLBACK_TARGET_MISSING",
                        "页上已经找不到对象 " + objectName + "，可能被手动删掉了。",
                        "这种情况不需要再回退，历史记录保持原样。");
                target.Remove();
                result.Set("undone", JsonValue.NewBool(true));
                result.Set("action", JsonValue.NewString("删掉这次插入的元件"));
                result.Set("removedObject", JsonValue.NewString(objectName));
            }
            else
            {
                result.Set("undone", JsonValue.NewBool(false));
                result.Set("reason", JsonValue.NewString("这个回退类型还没实现：" + kind));
                return result;
            }

            // 标记已撤回，避免重复回退把别的东西也删了。
            try
            {
                string[] lines = File.ReadAllLines(file, Encoding.UTF8);
                JsonValue updated = Json.Parse(lines[index]);
                updated.Set("undone", JsonValue.NewBool(true));
                updated.Set("undoneAt", JsonValue.NewString(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)));
                lines[index] = Json.Write(updated);
                File.WriteAllLines(file, lines, new UTF8Encoding(false));
            }
            catch
            {
                // 标不上也无所谓：对象已经删了，重复回退最多报「找不到对象」。
            }

            return result;
        }
    }

    internal static class OpLogTool
    {
        public static JsonValue History(JsonValue args)
        {
            return OpJournal.History(args);
        }

        public static JsonValue Rollback(JsonValue args)
        {
            return OpJournal.Rollback(args);
        }
    }
}
