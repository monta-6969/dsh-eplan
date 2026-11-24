// 宿主自检：逐条执行语句，看哪一条失败、失败原因是什么。
//
// 重点检查 LockingStep。EPLAN 的 ProjectManager.CurrentProject 必须在
// LockingStep 里访问，否则抛 S063110「不能生成 LockingStep 类别的对象」。
// 但 LockingStep 只能在 EPLAN 主线程上创建，所以这里同时报告线程信息，
// 用来判断 ExecuteAction 到底跑在主线程还是 Remoting 的线程池线程上。
using System;
using System.Reflection;
using System.Threading;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class DiagnoseTool
    {
        public static JsonValue Run(JsonValue args)
        {
            JsonValue result = JsonValue.NewObject();
            result.Set("hostVersion", "0.1.0");
            result.Set("hostAssembly", SafeHostAssembly());
            result.Set("baseDirectory", AppDomain.CurrentDomain.BaseDirectory);

            // 线程身份：和引导脚本 [Start] 记下的主线程 id 对比，
            // 就知道动作是不是跑在主线程上。
            Step(result, "threadId", delegate { return Thread.CurrentThread.ManagedThreadId.ToString(); });
            Step(result, "threadApartment", delegate { return Thread.CurrentThread.GetApartmentState().ToString(); });
            Step(result, "threadIsBackground", delegate { return Thread.CurrentThread.IsBackground.ToString(); });
            Step(result, "syncContext", delegate
            {
                SynchronizationContext ctx = SynchronizationContext.Current;
                return ctx == null ? "(null)" : ctx.GetType().FullName;
            });

            // 裸访问：预期在这里失败（S063110）。
            Step(result, "currentProjectBare", delegate
            {
                ProjectManager m = new ProjectManager();
                Project p = m.CurrentProject;
                return p == null ? "(null)" : p.ProjectName;
            });

            // 显式套 LockingStep：预期修好上一条。
            Step(result, "currentProjectInLockingStep", delegate
            {
                using (LockingStep step = new LockingStep())
                {
                    ProjectManager m = new ProjectManager();
                    Project p = m.CurrentProject;
                    return p == null ? "(null)" : p.ProjectName;
                }
            });

            Step(result, "pagesInLockingStep", delegate
            {
                using (LockingStep step = new LockingStep())
                {
                    ProjectManager m = new ProjectManager();
                    Project p = m.CurrentProject;
                    if (p == null) return "(no project)";
                    Page[] pages = p.Pages;
                    return pages == null ? "(null pages)" : pages.Length.ToString();
                }
            });

            Step(result, "projectFactsInLockingStep", delegate
            {
                using (LockingStep step = new LockingStep())
                {
                    ProjectManager m = new ProjectManager();
                    Project p = m.CurrentProject;
                    if (p == null) return "(no project)";
                    return "readOnly=" + p.IsReadOnly
                         + "; link=" + p.ProjectLinkFilePath
                         + "; dir=" + p.ProjectDirectoryPath;
                }
            });

            return result;
        }

        private delegate string Probe();

        private static string SafeHostAssembly()
        {
            try { return Assembly.GetExecutingAssembly().Location; }
            catch (Exception ex) { return "FAILED " + ex.Message; }
        }

        private static void Step(JsonValue result, string name, Probe probe)
        {
            try
            {
                result.Set(name, probe());
            }
            catch (Exception ex)
            {
                result.Set(name, "FAILED " + Describe(ex));
            }
        }

        private static string Describe(Exception ex)
        {
            string chain = ex.GetType().Name + ": " + ex.Message;
            Exception inner = ex.InnerException;
            while (inner != null)
            {
                chain += " <- " + inner.GetType().Name + ": " + inner.Message;
                inner = inner.InnerException;
            }
            return chain;
        }
    }
}
