// 直接调用任意动作名，确认哪些注册成功了。
//
// 注意：AssemblyResolve 必须在 Main 里注册，而引用 EPLAN 类型的代码必须放在
// 另一个方法里 —— 否则 JIT 编译 Main 时就要求解析 Eplan.EplApi.RemoteClientu，
// 那时解析器还没挂上，会抛 FileNotFoundException。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;

internal static class CallAction
{
    private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";
    private static readonly HashSet<string> Tried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    private static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string name = e.Name.Split(',')[0];
            if (!Tried.Add(name)) return null;
            string path = Path.Combine(Bin, name + ".dll");
            if (!File.Exists(path)) return null;
            try { return System.Reflection.Assembly.LoadFrom(path); }
            catch { return null; }
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
        if (servers.Count == 0) { Console.WriteLine("NO_SERVER"); return 1; }
        client.Connect("localhost", servers[0].ServerPort.ToString());

        foreach (string name in args)
        {
            try
            {
                var ctx = new Eplan.EplApi.Remoting.CallingContext();
                ctx.Set("payload", "probe");
                bool ok = client.ExecuteAction(name, ref ctx);
                string msg = string.IsNullOrEmpty(ctx.Message) ? "" : ctx.Message;
                object reply = null;
                bool hasReply = ctx.Get("reply", out reply);
                Console.WriteLine((ok ? "[OK]   " : "[MISS] ") + name
                    + (msg.Length > 0 ? "  msg=" + msg : "")
                    + (hasReply ? "  reply=" + reply : ""));
            }
            catch (Exception ex)
            {
                Console.WriteLine("[THREW] " + name + " : " + ex.Message);
            }
        }
        client.Disconnect();
        return 0;
    }
}
