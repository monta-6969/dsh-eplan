// 数据目录：知识库与经验文件放哪、以及从旧位置搬过来。
//
// 为什么不用 %TEMP%：
//   原先知识库和经验文件都在 Path.GetTempPath() 下。临时目录会被磁盘清理、存储感知、
//   或者机器重装清掉 —— 而这两份数据的全部价值就在于「跨会话留下来」。
//   放在 %LOCALAPPDATA% 才是它们该待的地方。
//
// 为什么还要留退回路径：
//   宿主 DLL 跑在 EPLAN 的 AppDomain 里。取不到 LocalApplicationData 时宁可退回
//   临时目录（本次会话仍可用），也不要抛异常把 status 之类的基础工具带崩。
//
// 迁移规则（只做一次、绝不覆盖）：
//   新位置已有同名文件 —— 说明已经迁移过或者新位置有更新的数据，一律不动；
//   旧文件复制成功之后**不删除**，留着当兜底，用户想回退随时能找回来。
using System;
using System.IO;

namespace EplanMcpHost
{
    internal static class Paths
    {
        private static string _knowledgeDir;

        // 知识库（symbols.json）与经验文件（notes.jsonl）共用的目录。
        internal static string KnowledgeDir
        {
            get
            {
                if (_knowledgeDir == null) _knowledgeDir = Resolve();
                return _knowledgeDir;
            }
        }

        // 旧位置。只在迁移时读，不作为写入目标。
        internal static string LegacyKnowledgeDir
        {
            get { return Path.Combine(Path.GetTempPath(), "eplan-mcp", "knowledge"); }
        }

        private static string Resolve()
        {
            string legacy = LegacyKnowledgeDir;
            string durable = null;

            try
            {
                string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!string.IsNullOrEmpty(root)) durable = Path.Combine(root, "eplan-mcp", "knowledge");
            }
            catch
            {
                durable = null;
            }

            if (string.IsNullOrEmpty(durable)) return legacy;

            try
            {
                if (!Directory.Exists(durable)) Directory.CreateDirectory(durable);
            }
            catch
            {
                // 建不出来（权限、只读盘）就退回临时目录，本次会话照常能用。
                return legacy;
            }

            Migrate(legacy, durable);
            return durable;
        }

        private static void Migrate(string fromDir, string toDir)
        {
            try
            {
                if (!Directory.Exists(fromDir)) return;
                string[] files = Directory.GetFiles(fromDir, "*", SearchOption.TopDirectoryOnly);
                foreach (string from in files)
                {
                    string to = Path.Combine(toDir, Path.GetFileName(from));
                    if (File.Exists(to)) continue;      // 新位置已有，绝不覆盖
                    try { File.Copy(from, to, false); }
                    catch { }                            // 单个文件搬不动不影响其余的
                }
            }
            catch
            {
                // 迁移是尽力而为，失败了也只是用不上旧数据，不该让工具调用失败。
            }
        }
    }
}
