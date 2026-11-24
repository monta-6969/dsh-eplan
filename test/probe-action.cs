// 探针：EPLAN 里到底有没有加载我们的宿主（EplanMcpRun 动作在不在）。
//
// 绕开桥接器的「模态框预检」：直接往 IPC 目录写一个只读 status 请求，
// 再用 Remoting 调一次 EplanMcpRun。
//   ACTION_RETURNED + REPLY  → 宿主活着，动作也注册了（对话框只挡了桥接器）
//   ACTION_ERROR ...         → 动作没注册（宿主没加载）
//   done=False               → 动作在，但 EPLAN 主线程被模态框占着（超时）
//
// 只用 status，不发任何写操作。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using Eplan.EplApi.RemoteClient;
using Eplan.EplApi.Remoting;

internal static class ProbeAction
{
    private const string IpcDir = @"C:\Users\Public\EPLAN\Data\eplan-mcp\ipc";
    private const string EplanBin = @"D:\EPLAN\Platform\2.9.4\Bin";

    private static int Main()
    {
        // 探针 exe 旁边没有 EPLAN 的程序集：让 CLR 去 EPLAN 安装目录找。
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
        {
            string name = e.Name.Split(',')[0];
            string path = Path.Combine(EplanBin, name + ".dll");
            if (File.Exists(path))
            {
                try { return Assembly.LoadFrom(path); } catch { }
            }
            return null;
        };

        try { return Run(); }
        catch (Exception ex)
        {
            Console.WriteLine("FATAL " + ex.GetType().FullName + ": " + ex.Message);
            return 9;
        }
    }

    private static int Run()
    {
        EplanRemoteClient client = new EplanRemoteClient();
        client.SynchronousMode = true;

        List<EplanServerData> servers = new List<EplanServerData>();
        try { client.GetActiveEplanServersOnLocalMachine(out servers); }
        catch (Exception ex) { Console.WriteLine("ENUM_ERROR " + ex.Message); return 2; }
        if (servers == null || servers.Count == 0) { Console.WriteLine("NO_EPLAN"); return 2; }

        EplanServerData chosen = servers[0];
        foreach (EplanServerData s in servers)
        {
            Console.WriteLine("server " + s.ServerName + " port=" + s.ServerPort + " pid=" + s.EplanProcessID + " variant=" + s.EplanVariant);
            if (s.EplanVariant != null && s.EplanVariant.IndexOf("P8", StringComparison.OrdinalIgnoreCase) >= 0) chosen = s;
        }

        try { client.Connect("localhost", chosen.ServerPort.ToString(CultureInfo.InvariantCulture)); }
        catch (Exception ex) { Console.WriteLine("CONNECT_ERROR " + ex.Message); return 3; }
        Console.WriteLine("connected=" + client.Ping());

        string id = Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(IpcDir);
        string requestPath = Path.Combine(IpcDir, "request.json");
        File.WriteAllText(requestPath, "{\"id\":\"" + id + "\",\"op\":\"status\",\"args\":{}}", new UTF8Encoding(false));

        Thread worker = new Thread(delegate()
        {
            try
            {
                client.ExecuteAction("EplanMcpRun");
                Console.WriteLine("ACTION_RETURNED");
            }
            catch (Exception ex)
            {
                Console.WriteLine("ACTION_ERROR " + ex.Message);
            }
        });
        worker.IsBackground = true;
        worker.Start();

        bool done = worker.Join(15000);
        Console.WriteLine("done=" + done);

        string reply = Path.Combine(IpcDir, "reply-" + id + ".json");
        if (File.Exists(reply))
        {
            string text = File.ReadAllText(reply, Encoding.UTF8);
            Console.WriteLine("REPLY " + (text.Length > 400 ? text.Substring(0, 400) : text));
        }
        else
        {
            Console.WriteLine("NO_REPLY");
        }

        try { client.Disconnect(); } catch { }
        return 0;
    }
}
