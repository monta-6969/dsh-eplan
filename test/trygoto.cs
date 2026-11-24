// 试真实的动作：GotoGraphicOpenPageAction 等。
//
// 这些名字是从 D:\EPLAN\Platform\2.9.4\Cfg\regPlatform.xml 里挖出来的，
// 比猜快得多。目标是让 EPLAN 界面跳到指定页，用户在屏幕上看得到我在改哪页。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;

internal static class TryGoto
{
    private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";
    private static readonly HashSet<string> Tried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    private static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string n = e.Name.Split(',')[0];
            if (!Tried.Add(n)) return null;
            string p = Path.Combine(Bin, n + ".dll");
            if (!File.Exists(p)) return null;
            try { return System.Reflection.Assembly.LoadFrom(p); } catch { return null; }
        };
        return Run(args);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string[] args)
    {
        var am = new Eplan.EplApi.ApplicationFramework.ActionManager();
        string[] candidates = new string[]
        {
            "GotoGraphicOpenPageAction", "GoToGraphic", "GotoProject", "GotoSource", "GotoTarget",
            "GotoRelated", "GotoEECAction", "gotoItem", "GotoPage",
        };

        foreach (string name in candidates)
        {
            Eplan.EplApi.ApplicationFramework.Action a = null;
            try { a = am.FindAction(name, true); }
            catch { }
            Console.WriteLine((a != null ? "[YES] " : "[ no] ") + name);
        }

        if (args.Length == 0) return 0;

        // 试调用：参数名一个个试。
        string pageName = args[0];
        var client = new Eplan.EplApi.RemoteClient.EplanRemoteClient();
        client.SynchronousMode = true;
        var servers = new List<Eplan.EplApi.RemoteClient.EplanServerData>();
        client.GetActiveEplanServersOnLocalMachine(out servers);
        client.Connect("localhost", servers[0].ServerPort.ToString());

        string[] keys = { "Page", "page", "PageName", "pagename", "Name", "name", "FullPageName", "ObjectId" };
        foreach (string key in keys)
        {
            var ctx = new Eplan.EplApi.Remoting.CallingContext();
            ctx.Set(key, pageName);
            bool ok = client.ExecuteAction("GotoGraphicOpenPageAction", ref ctx);
            Console.WriteLine("GotoGraphicOpenPageAction[" + key + "] => " + ok
                + " succeed=" + ctx.Succeed
                + " msg=" + (string.IsNullOrEmpty(ctx.Message) ? "(none)" : ctx.Message));
            if (ok) break;
        }
        client.Disconnect();
        return 0;
    }
}
