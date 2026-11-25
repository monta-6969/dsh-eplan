// page_open：把某一页在 EPLAN 界面里打开。
//
// 为什么需要：
//   工具在后台改图、渲染，用户却看不到——EPLAN 里显示的还停在别的页。
//   "画好了" 和 "看到了" 是两件事，这一步把后者补上。
//
// 动作名是试出来的，值得记下来：
//   * XSeGotoGraphicOpenPageAction —— 调用不报错、什么也不做。
//     它的 ModuleName 是 SearchAndReplaceGui，是「搜索结果跳转」专用，
//     不是通用的开页动作。别被名字骗了。
//   * XGedOpenPageName —— 也确实存在，但参数名不对时会把页切到 /1，行为诡异。
//   * **OpenPageAction + 参数 PageName** —— 唯一正确的一对，实测能把标题
//     从 "=MCP/2" 切到 "=MCP/8"。
//
// 窗口标题刷新的等待放在桥接器里做（见 bridge/src/Program.cs 的 WaitWindowTitle），
// 因为本方法跑在 EPLAN 主线程上，在这里 Sleep 会把界面锁死，标题永远更新不了。
using System;
using Eplan.EplApi.ApplicationFramework;
using Eplan.EplApi.DataModel;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class PageOpenTool
    {
        private const string ActionName = "OpenPageAction";
        private const string ParameterName = "PageName";

        public static JsonValue Run(JsonValue args)
        {
            string pageName = args["page"].AsString(null);
            Page page = Context.FindPage(pageName, args["project"].AsString(null));

            JsonValue result = JsonValue.NewObject();
            result.Set("page", page.Name);
            result.Set("project", page.Project.ProjectName);

            ActionManager manager = new ActionManager();
            Eplan.EplApi.ApplicationFramework.Action action = manager.FindAction(ActionName, true);
            if (action == null)
                throw new HostException("ACTION_MISSING",
                    "EPLAN 里没有 " + ActionName + " 这个动作，无法跳页。");

            try
            {
                ActionCallingContext context = new ActionCallingContext();
                context.AddParameter(ParameterName, page.Name);
                action.Execute(context);
            }
            catch (Exception ex)
            {
                throw new HostException("PAGE_OPEN_FAILED",
                    "跳页动作执行失败：" + ex.GetType().Name + ": " + ex.Message);
            }

            result.Set("action", ActionName);
            result.Set("parameter", ParameterName);
            result.Set("requested", true);
            return result;
        }
    }
}
