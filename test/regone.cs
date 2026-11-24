using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;

internal static class RegOne
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

        var ctx = new Eplan.EplApi.Remoting.CallingContext();
        ctx.Set("ScriptFile", args[0]);
        bool ok = client.ExecuteAction("RegisterScript", ref ctx);
        Console.WriteLine("RegisterScript => " + ok + " succeed=" + ctx.Succeed
            + " msg=" + (string.IsNullOrEmpty(ctx.Message) ? "(none)" : ctx.Message));
        client.Disconnect();
        return 0;
    }
}
