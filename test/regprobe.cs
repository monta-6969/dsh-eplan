// 探 RegisterScript / UnregisterScript 动作的参数名。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;

internal static class RegProbe
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
        var client = new Eplan.EplApi.RemoteClient.EplanRemoteClient();
        client.SynchronousMode = true;
        var servers = new List<Eplan.EplApi.RemoteClient.EplanServerData>();
        client.GetActiveEplanServersOnLocalMachine(out servers);
        client.Connect("localhost", servers[0].ServerPort.ToString());

        string script = args[0];
        // 参数名候选：EPLAN 内部会把 key 小写化，试几种常见拼法。
        string[] keys = { "ScriptFile", "scriptfile", "FileName", "filename", "File", "file", "Name", "name" };
        foreach (string key in keys)
        {
            var ctx = new Eplan.EplApi.Remoting.CallingContext();
            ctx.Set(key, script);
            bool ok = client.ExecuteAction("RegisterScript", ref ctx);
            Console.WriteLine("RegisterScript[" + key + "] => " + ok + "  succeed=" + ctx.Succeed
                + "  msg=" + (string.IsNullOrEmpty(ctx.Message) ? "(none)" : ctx.Message));
            if (ok && ctx.Succeed) break;
        }

        // 顺便列出 EPLAN 支持的所有动作名里含 Script 的
        client.Disconnect();
        return 0;
    }
}
