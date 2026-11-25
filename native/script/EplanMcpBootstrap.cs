// EPLAN 引导脚本：唯一一个装进 EPLAN 的东西。
//
// ── 为什么需要它 ────────────────────────────────────────────────
// EPLAN 自己的脚本编译器引用集是写死的（见 EplanEplApiScriptLogu.erx），只有
// mscorlib / System / System.Core / System.Drawing / System.XML / System.Xml.Linq /
// System.Windows.Forms / System.IO.Compression.FileSystem /
// Eplan.EplApi.Baseu / AFu / Guiu / RecorderToolsu / EServicesu。
// Eplan.EplApi.DataModelu.dll 和 HEServicesu.dll 都不在里面，
// 所以脚本里连 "DataModel" 这个命名空间都看不见，画不了图。
//
// 于是脚本只做一件事：反射加载我们自己的 EplanMcpHost.dll（它是用 csc 编的，
// 不受那个引用集约束），把 JSON 转交给它。脚本里不出现任何 DataModel 类型。
//
// ── 三个用 EPLAN 日志试出来的硬约束 ──────────────────────────────
// 1. ExecuteScript 动作只执行 [Start]，**不注册** [DeclareAction]。
//    要注册必须用 RegisterScript 动作（参数 ScriptFile=<绝对路径>）。
// 2. [DeclareAction] 方法必须是**无参 void**。带 ActionCallingContext 参数虽然
//    能注册、能执行，但 ExecuteAction 会返回 false，而且 context.GetContextParameter()
//    返回 null（Remoting 的上下文传不进来）。
// 3. 因此请求/响应不能走 CallingContext，改用文件交换：
//       请求  C:\Users\Public\EPLAN\Data\eplan-mcp\ipc\request.json
//       响应  C:\Users\Public\EPLAN\Data\eplan-mcp\ipc\reply-<id>.json
//    脚本读走请求后立刻删除，处理完再写响应，客户端轮询响应文件。
//
// ── 热重载 ──────────────────────────────────────────────────────
// EPLAN 进程一旦 Assembly.LoadFrom 了某个 DLL，那个文件就被锁住，改代码后
// 覆盖不了。所以宿主目录里放的是带版本号的文件（EplanMcpHost-<ticks>.dll），
// 每次构建产生一个新文件名，旧的不动。本脚本每次调用都取目录里最新的那个，
// 和当前已加载的不是同一个就重新加载 —— 改完宿主代码重新构建即可生效，
// 不用重启 EPLAN。
public class EplanMcpBootstrap
{
    // 宿主 DLL 目录。prepare-install.ps1 会自动改写这一行。
    private const string HostDir = @"__HOST_DLL_DIR__";

    private const string IpcDir = @"C:\Users\Public\EPLAN\Data\eplan-mcp\ipc";
    private const string RequestPath = IpcDir + @"\request.json";

    private static object _entry;
    private static string _loadedPath;

    [Eplan.EplApi.Scripting.Start]
    public void Start(Eplan.EplApi.ApplicationFramework.ActionCallingContext context)
    {
        Log("引导脚本已加载，宿主目录: " + HostDir);
    }

    [Eplan.EplApi.Scripting.DeclareAction("EplanMcpRun")]
    public void Run()
    {
        string requestText;
        string requestId = null;

        try
        {
            if (!System.IO.Directory.Exists(IpcDir))
            {
                Log("IPC 目录不存在，动作被调用但无请求: " + IpcDir);
                return;
            }
            if (!System.IO.File.Exists(RequestPath))
            {
                Log("没有待处理的请求文件，动作被调用但无内容。");
                return;
            }

            // 先读再删：删掉才能让"处理中"和"新请求"区分开，
            // 也避免同一个请求被处理两次。
            requestText = System.IO.File.ReadAllText(RequestPath, System.Text.Encoding.UTF8);
            System.IO.File.Delete(RequestPath);
        }
        catch (System.Exception ex)
        {
            Log("读取请求失败: " + ex.GetType().Name + ": " + ex.Message);
            return;
        }

        // 从请求里抠出 id，用来命名响应文件。手写解析，避免依赖 JSON 库。
        try
        {
            int idStart = requestText.IndexOf("\"id\"", System.StringComparison.Ordinal);
            if (idStart >= 0)
            {
                int colon = requestText.IndexOf(':', idStart);
                int quote1 = requestText.IndexOf('"', colon + 1);
                int quote2 = requestText.IndexOf('"', quote1 + 1);
                if (quote1 > 0 && quote2 > quote1)
                    requestId = requestText.Substring(quote1 + 1, quote2 - quote1 - 1);
            }
        }
        catch { }

        if (string.IsNullOrEmpty(requestId))
        {
            Log("请求里没有 id，放弃处理。");
            return;
        }

        string replyPath = System.IO.Path.Combine(IpcDir, "reply-" + requestId + ".json");
        string replyText;

        try
        {
            replyText = InvokeHost(requestText);
        }
        catch (System.Exception ex)
        {
            replyText = Fail("HOST_LOAD_FAILED",
                "加载或调用宿主失败: " + ex.GetType().Name + ": " + ex.Message,
                ex.ToString());
        }

        // 先写临时文件再改名，避免客户端读到写了一半的 JSON。
        string tempPath = replyPath + ".tmp";
        try
        {
            System.IO.File.WriteAllText(tempPath, replyText, System.Text.Encoding.UTF8);
            if (System.IO.File.Exists(replyPath)) System.IO.File.Delete(replyPath);
            System.IO.File.Move(tempPath, replyPath);
        }
        catch (System.Exception ex)
        {
            Log("写响应失败: " + ex.GetType().Name + ": " + ex.Message + " → " + replyPath);
        }
    }

    /// <summary>加载最新的宿主 DLL 并调用 Entry.Run(payload)。</summary>
    private static string InvokeHost(string payload)
    {
        string newest = NewestHostDll();
        if (newest == null)
            throw new System.IO.FileNotFoundException("宿主目录里没有 EplanMcpHost-*.dll: " + HostDir);

        // 构建出了新版本就换掉，实现热重载。
        if (_entry == null || !string.Equals(newest, _loadedPath, System.StringComparison.OrdinalIgnoreCase))
        {
            System.Reflection.Assembly assembly = System.Reflection.Assembly.LoadFrom(newest);
            System.Type entryType = assembly.GetType("EplanMcpHost.Entry", true);
            _entry = System.Activator.CreateInstance(entryType);
            _loadedPath = newest;
            Log("宿主已加载: " + newest);
        }

        System.Reflection.MethodInfo run = _entry.GetType().GetMethod("Run");
        object result = run.Invoke(_entry, new object[] { payload });
        return result as string;
    }

    /// <summary>取宿主目录里修改时间最新的 EplanMcpHost-*.dll。</summary>
    private static string NewestHostDll()
    {
        if (!System.IO.Directory.Exists(HostDir)) return null;

        string best = null;
        System.DateTime bestTime = System.DateTime.MinValue;
        string[] files = System.IO.Directory.GetFiles(HostDir, "EplanMcpHost-*.dll");
        foreach (string file in files)
        {
            System.DateTime time = System.IO.File.GetLastWriteTimeUtc(file);
            if (time > bestTime)
            {
                bestTime = time;
                best = file;
            }
        }
        return best;
    }

    private static string Fail(string code, string message, string detail)
    {
        System.Text.StringBuilder sb = new System.Text.StringBuilder();
        sb.Append("{\"ok\":false,\"error\":{\"code\":");
        sb.Append(Quote(code));
        sb.Append(",\"message\":");
        sb.Append(Quote(message));
        if (detail != null)
        {
            sb.Append(",\"detail\":");
            sb.Append(Quote(detail.Length > 4000 ? detail.Substring(0, 4000) : detail));
        }
        sb.Append("}}");
        return sb.ToString();
    }

    private static string Quote(string text)
    {
        if (text == null) return "null";
        System.Text.StringBuilder sb = new System.Text.StringBuilder("\"");
        foreach (char c in text)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    /// <summary>日志写到 Public 下的固定文件。EPLAN 的 Remoting 通道不能往 console 写。</summary>
    private static void Log(string message)
    {
        try
        {
            string dir = @"C:\Users\Public\EPLAN\Data\eplan-mcp";
            if (!System.IO.Directory.Exists(dir)) System.IO.Directory.CreateDirectory(dir);
            System.IO.File.AppendAllText(dir + @"\bootstrap.log",
                System.DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + message + "\r\n",
                System.Text.Encoding.UTF8);
        }
        catch { }
    }
}
