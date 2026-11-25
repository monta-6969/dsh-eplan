// 桥接器：Node(MCP 服务) 与 EPLAN 进程之间的那一层。
//
// 职责很窄：
//   1. 从 stdin 按行读 JSON 请求 {id, op, args}
//   2. 用 .NET Remoting 把请求送进运行中的 EPLAN（ExecuteAction "EplanMcpRun"）
//   3. 把结果按行写回 stdout {id, ok, result} / {id, ok:false, error}
//
// 它自己不懂 EPLAN 的数据模型 —— 那边由 EplanMcpHost.dll 在 EPLAN 进程内完成。
// 这样做的原因见 native/script/EplanMcpBootstrap.cs 的注释：EPLAN 的脚本编译器
// 引用集里没有 DataModelu.dll，所以真正的逻辑必须是我们自己编译的 DLL。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Eplan.EplApi.RemoteClient;
using Eplan.EplApi.Remoting;

namespace EplanMcp.Bridge
{
    internal static class Program
    {
        private const string ActionName = "EplanMcpRun";

        /// <summary>一次 IPC 往返最多等多久。EPLAN 的导出类操作会慢一些。</summary>
        private const int DefaultTimeoutMs = 120000;

        /// <summary>引导脚本和桥接器共用的状态目录。</summary>
        private static readonly string StateDir = @"C:\Users\Public\EPLAN\Data\eplan-mcp";

        private static readonly object WriteLock = new object();
        private static EplanRemoteClient _client;

        /// <summary>EPLAN 的安装目录。可通过环境变量 EPLAN_BIN 覆盖（换版本时用）。</summary>
        private static string EplanBin
        {
            get
            {
                string fromEnv = Environment.GetEnvironmentVariable("EPLAN_BIN");
                if (!string.IsNullOrEmpty(fromEnv) && Directory.Exists(fromEnv)) return fromEnv;
                return @"D:\EPLAN\Platform\2.9.4\Bin";
            }
        }

        private static System.Reflection.Assembly ResolveFromEplan(object sender, ResolveEventArgs e)
        {
            try
            {
                string simpleName = e.Name.Split(',')[0];
                string candidate = Path.Combine(EplanBin, simpleName + ".dll");
                if (File.Exists(candidate)) return System.Reflection.Assembly.LoadFrom(candidate);

                // 64 位 EPLAN 的程序集名带 u 后缀，个别不带，两边都试。
                if (!simpleName.EndsWith("u", StringComparison.OrdinalIgnoreCase))
                {
                    candidate = Path.Combine(EplanBin, simpleName + "u.dll");
                    if (File.Exists(candidate)) return System.Reflection.Assembly.LoadFrom(candidate);
                }
            }
            catch { }
            return null;
        }

        private static int Main(string[] args)
        {
            // 桥接器不在 EPLAN 目录里跑，但 EPLAN 的 Remoting 程序集有一串私有依赖。
            // 运行时从 EPLAN 的 Bin 目录就地解析，避免把几十个 DLL 复制进本仓库。
            AppDomain.CurrentDomain.AssemblyResolve += ResolveFromEplan;

            // 默认走 stdin/stdout（MCP 服务用）；--serve 时行为相同。
            // --once "<json>" 用于人工调试：跑一次就退出。
            string onceJson = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--once" && i + 1 < args.Length) { onceJson = args[i + 1]; i++; }
            }

            Console.OutputEncoding = new UTF8Encoding(false);
            Console.InputEncoding = new UTF8Encoding(false);

            try
            {
                if (onceJson != null)
                {
                    JsonValue req = Json.Parse(onceJson);
                    JsonValue resp = Handle(req);
                    Emit(resp);
                    return 0;
                }

                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line.Length == 0) continue;

                    JsonValue req;
                    try { req = Json.Parse(line); }
                    catch (Exception ex)
                    {
                        Emit(ErrorResponse(null, "BAD_REQUEST", "请求不是合法 JSON: " + ex.Message, null));
                        continue;
                    }

                    JsonValue resp = Handle(req);
                    Emit(resp);
                }
            }
            catch (Exception ex)
            {
                Emit(ErrorResponse(null, "BRIDGE_FATAL", ex.GetType().Name + ": " + ex.Message, ex.ToString()));
                return 3;
            }
            finally
            {
                Disconnect();
            }

            return 0;
        }

        private static void Emit(JsonValue response)
        {
            string text = Json.Write(response);
            lock (WriteLock)
            {
                Console.Out.Write(text);
                Console.Out.Write("\n");
                Console.Out.Flush();
            }
        }

        private static JsonValue ErrorResponse(JsonValue req, string code, string message, string detail)
        {
            JsonValue resp = JsonValue.NewObject();
            if (req == null) resp.Set("id", (string)null);
            else resp.Set("id", req["id"]);
            resp.Set("ok", false);

            JsonValue err = JsonValue.NewObject();
            err.Set("code", code);
            err.Set("message", message);
            if (detail != null) err.Set("detail", detail);
            resp.Set("error", err);
            return resp;
        }

        private static JsonValue Handle(JsonValue req)
        {
            string op = req["op"].AsString("");
            JsonValue args = req["args"];
            if (args == null || !args.IsObject) args = JsonValue.NewObject();

            try
            {
                JsonValue result = Dispatch(op, args);
                JsonValue resp = JsonValue.NewObject();
                resp.Set("id", req["id"]);
                resp.Set("ok", true);
                resp.Set("result", result);
                return resp;
            }
            catch (EplanBridgeException ex)
            {
                return ErrorResponse(req, ex.Code, ex.Message, ex.Detail);
            }
            catch (Exception ex)
            {
                return ErrorResponse(req, "EPLAN_ERROR",
                    ex.GetType().Name + ": " + ex.Message,
                    ex.InnerException == null ? null : ex.InnerException.Message);
            }
        }

        private static JsonValue Dispatch(string op, JsonValue args)
        {
            switch (op)
            {
                case "ping":
                    return PingResult();
                case "launch":
                    return LaunchEplan(args);
                case "install":
                    return InstallHost(args);
                case "dialogs":
                    return Dialogs(args);
                default:
                    return ForwardToEplan(op, args);
            }
        }

        /// <summary>
        /// 对话框的自检与处置：默认只报，close=true 才动手。
        /// 排查「EPLAN 为什么不动了」时可以直接 --once 调它。
        /// </summary>
        private static JsonValue Dialogs(JsonValue args)
        {
            bool close = args["close"].AsBool(false);
            JsonValue result = JsonValue.NewObject();
            string before = DescribeBlockingDialog();
            result.Set("blocking", before);
            if (close)
            {
                string acted = SettleKnownDialogs();
                result.Set("settled", acted);
                if (acted != null) AppendDialogLog(acted);
                System.Threading.Thread.Sleep(200);
                result.Set("blockingAfter", DescribeBlockingDialog());
            }
            return result;
        }

        /// <summary>处置记录落盘：事后能看出「这个框被我关过几次」，不用靠猜。</summary>
        private static void AppendDialogLog(string line)
        {
            try
            {
                Directory.CreateDirectory(StateDir);
                File.AppendAllText(
                    Path.Combine(StateDir, "dialog-actions.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + line + Environment.NewLine,
                    new UTF8Encoding(false));
            }
            catch { }
        }

        // ---------------------------------------------------------------
        // 安装宿主：用 RegisterScript 动作把引导脚本注册进 EPLAN。
        //
        // 关键区别（用 EPLAN 日志试出来的）：
        //   ExecuteScript  只执行 [Start]，**不注册** [DeclareAction]
        //   RegisterScript 才真正注册 [DeclareAction]
        // 之前反复失败就是因为用了 ExecuteScript。
        // ---------------------------------------------------------------

        private static JsonValue InstallHost(JsonValue args)
        {
            string scriptPath = args["script"].AsString(null);
            if (string.IsNullOrEmpty(scriptPath))
                throw new EplanBridgeException("BAD_ARGUMENT", "缺少 script 参数（引导脚本的绝对路径）。", null);
            if (!File.Exists(scriptPath))
                throw new EplanBridgeException("SCRIPT_MISSING", "找不到引导脚本: " + scriptPath, null);

            EplanRemoteClient client = Client;

            JsonValue result = JsonValue.NewObject();
            result.Set("script", scriptPath);

            // 装之前先探一次：宿主已经在了就直接返回，不重复注册。
            string beforeError = ProbeHost(client);
            result.Set("hostBefore", beforeError == null ? "ready" : beforeError);
            if (beforeError == null)
            {
                result.Set("installed", true);
                result.Set("alreadyInstalled", true);
                return result;
            }

            CallingContext context = new CallingContext();
            context.Set("ScriptFile", scriptPath);

            bool registered = client.ExecuteAction("RegisterScript", ref context);
            string message = string.IsNullOrEmpty(context.Message) ? null : context.Message;
            result.Set("registerScriptReturned", registered);
            result.Set("registerScriptSucceed", context.Succeed);
            if (message != null) result.Set("message", message);

            // 动作注册发生在 EPLAN 主线程上，轮询等它出现。
            string afterError = beforeError;
            for (int attempt = 0; attempt < 24; attempt++)
            {
                System.Threading.Thread.Sleep(250);
                afterError = ProbeHost(client);
                if (afterError == null) break;
            }

            if (afterError != null)
            {
                throw new EplanBridgeException("INSTALL_FAILED",
                    "RegisterScript 执行了，但 EplanMcpRun 仍不可用。" +
                    (message == null ? "" : " EPLAN 返回：" + message) +
                    @" 请查看 C:\Users\Public\EPLAN\Data\eplan-mcp\bootstrap.log 和 EPLAN 日志（EplLog.eldb）。",
                    Json.Write(result));
            }

            result.Set("installed", true);
            result.Set("alreadyInstalled", false);
            return result;
        }

        /// <summary>
        /// 探一下宿主是否可用：发一个只读的 diagnose 请求走完整 IPC 链路。
        /// 返回 null 表示可用；否则返回错误描述。
        /// </summary>
        private static string ProbeHost(EplanRemoteClient client)
        {
            try
            {
                JsonValue payload = JsonValue.NewObject();
                payload.Set("op", "diagnose");
                payload.Set("args", JsonValue.NewObject());
                JsonValue reply = SendThroughIpc(client, Json.Write(payload), 8000);
                if (!reply["ok"].AsBool(false))
                {
                    JsonValue err = reply["error"];
                    return err == null ? "HOST_ERROR" : err["code"].AsString("HOST_ERROR");
                }
                return null;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }


        /// <summary>
        /// 探一下宿主是否可用：调用只读的 diagnose。
        /// 返回 null 表示可用；否则返回错误码/文本，供上层判断。
        /// 用 diagnose 而不是别的，是因为它不写任何东西。
        /// </summary>
        private static string ProbeHostLegacy(EplanRemoteClient client)
        {
            try
            {
                JsonValue payload = JsonValue.NewObject();
                payload.Set("op", "diagnose");
                payload.Set("args", JsonValue.NewObject());

                CallingContext context = new CallingContext();
                context.Set("payload", Json.Write(payload));

                bool ok = client.ExecuteAction(ActionName, ref context);
                if (!ok)
                {
                    string message = context.Message;
                    if (string.IsNullOrEmpty(message)) return "ACTION_MISSING";
                    if (message.IndexOf("EplanMcpRun", StringComparison.OrdinalIgnoreCase) >= 0) return "ACTION_MISSING";
                    return message;
                }

                object reply = null;
                if (!context.Get("reply", out reply) || reply == null) return "NO_REPLY";
                string text = reply as string;
                if (text == null) return "BAD_REPLY_TYPE";
                JsonValue parsed = Json.Parse(text);
                if (!parsed["ok"].AsBool(false))
                {
                    JsonValue err = parsed["error"];
                    return err == null ? "HOST_ERROR" : err["code"].AsString("HOST_ERROR");
                }
                return null;
            }
            catch (Exception ex)
            {
                return "PROBE_FAILED: " + ex.Message;
            }
        }


        // ---------------------------------------------------------------
        // 与 EPLAN 的连接
        // ---------------------------------------------------------------

        private static EplanRemoteClient Client
        {
            get
            {
                if (_client != null && _client.Ping()) return _client;
                Disconnect();
                EplanRemoteClient client = new EplanRemoteClient();
                // 必须开同步模式：默认异步时 ExecuteAction 对任何动作名都返回 true，
                // 拿不到真实成败，也没法把结果带回来。
                client.SynchronousMode = true;

                List<EplanServerData> servers = new List<EplanServerData>();
                client.GetActiveEplanServersOnLocalMachine(out servers);
                if (servers == null || servers.Count == 0)
                {
                    throw new EplanBridgeException("EPLAN_NOT_RUNNING",
                        "没有检测到正在运行的 EPLAN。请先打开 EPLAN Electric P8 并载入项目后重试。", null);
                }

                // 多实例时选「真的开着项目」的那个（见 InstanceScore），同分再按 P8 优先。
                EplanServerData chosen = servers[0];
                int bestScore = int.MinValue;
                foreach (EplanServerData s in servers)
                {
                    int score = InstanceScore(s);
                    if (score > bestScore)
                    {
                        bestScore = score;
                        chosen = s;
                    }
                }

                client.Connect("localhost", chosen.ServerPort.ToString(CultureInfo.InvariantCulture));
                if (!client.Ping())
                {
                    throw new EplanBridgeException("EPLAN_CONNECT_FAILED",
                        "连接 EPLAN 失败（端口 " + chosen.ServerPort + "）。", null);
                }
                _client = client;
                _clientProcessId = chosen.EplanProcessID;
                _clientVersion = chosen.EplanVersion;
                return _client;
            }
        }

        private static int _clientProcessId;
        private static string _clientVersion;

        private static void Disconnect()
        {
            if (_client == null) return;
            try { _client.Disconnect(); } catch { }
            _client = null;
        }

        private static JsonValue PingResult()
        {
            List<EplanServerData> servers = new List<EplanServerData>();
            EplanRemoteClient probe = new EplanRemoteClient();
            probe.SynchronousMode = true;
            probe.GetActiveEplanServersOnLocalMachine(out servers);

            JsonValue result = JsonValue.NewObject();
            result.Set("bridgeVersion", "0.1.0");
            JsonValue list = JsonValue.NewArray();
            if (servers != null)
            {
                foreach (EplanServerData s in servers)
                {
                    JsonValue item = JsonValue.NewObject();
                    item.Set("serverName", s.ServerName);
                    item.Set("port", s.ServerPort);
                    item.Set("version", s.EplanVersion);
                    item.Set("variant", s.EplanVariant);
                    item.Set("processId", s.EplanProcessID);
                    item.Set("is64Bit", s.Is64Bit);
                    list.Add(item);
                }
            }
            result.Set("servers", list);
            result.Set("count", list.Count);
            return result;
        }

        private static JsonValue LaunchEplan(JsonValue args)
        {
            string path = args["path"].AsString(@"D:\EPLAN\Platform\2.9.4\Bin\Eplan.exe");
            string variant = args["variant"].AsString("Electric P8");
            string project = args["project"].AsString(null);

            // variant 和项目都通过命令行参数传。
            string arguments = "/Variant:\"" + variant + "\"";
            if (!string.IsNullOrEmpty(project)) arguments += " \"" + project + "\"";

            // 关键：必须用 UseShellExecute 走壳启动，让 EPLAN 成为**独立**进程。
            //
            // 如果直接 Process.Start 用 CreateProcess，EPLAN 就是这个桥接器的子进程；
            // 而 DSH 可能在 Job Object 里运行（kill-on-close），DSH 一退，
            // 整个作业对象连带进程树一起被杀 —— 用户的 EPLAN 就这么没了。
            // 走壳之后 EPLAN 挂在 explorer 下，和 DSH 没有任何父子关系。
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = path;
                info.Arguments = arguments;
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch (Exception ex)
            {
                throw new EplanBridgeException("EPLAN_LAUNCH_FAILED",
                    "启动 EPLAN 失败: " + ex.Message, path + " " + arguments);
            }

            // 启动是异步的，轮询等它把 Remoting 端口挂起来。
            EplanServerData started = null;
            int waited = 0;
            while (waited < 60000)
            {
                System.Threading.Thread.Sleep(1000);
                waited += 1000;
                try
                {
                    List<EplanServerData> servers = new List<EplanServerData>();
                    EplanRemoteClient probe = new EplanRemoteClient();
                    probe.GetActiveEplanServersOnLocalMachine(out servers);
                    if (servers != null && servers.Count > 0) { started = servers[servers.Count - 1]; break; }
                }
                catch { }
            }

            JsonValue result = JsonValue.NewObject();
            result.Set("started", started != null);
            result.Set("detached", true);
            if (started != null)
            {
                result.Set("port", started.ServerPort);
                result.Set("processId", started.EplanProcessID);
                result.Set("version", started.EplanVersion);
            }
            else
            {
                result.Set("note", "EPLAN 已启动但没有在 60 秒内挂上 Remoting 端口，可能还在加载，或者弹出了启动对话框。");
            }
            return result;
        }


        // ---------------------------------------------------------------
        // 把请求转发进 EPLAN 进程
        //
        // 走文件交换而不是 CallingContext：DeclareAction 必须是无参 void，
        // 带 ActionCallingContext 参数时 ExecuteAction 返回 false 且
        // context.GetContextParameter() 返回 null，参数根本传不进去。
        // 详见 native/script/EplanMcpBootstrap.cs 顶部的注释。
        // ---------------------------------------------------------------

        private static JsonValue ForwardToEplan(string op, JsonValue args)
        {
            EplanRemoteClient client = Client;

            JsonValue payload = JsonValue.NewObject();
            payload.Set("op", op);
            payload.Set("args", args);

            // 命令里显式指定的超时覆盖默认值。
            int timeoutMs = args["timeoutMs"].AsInt(DefaultTimeoutMs);

            JsonValue reply = SendThroughIpc(client, Json.Write(payload), timeoutMs);

            bool replyOk = reply["ok"].AsBool(false);
            if (!replyOk)
            {
                JsonValue error = reply["error"];
                string code = error == null ? "EPLAN_ERROR" : error["code"].AsString("EPLAN_ERROR");
                string message = error == null ? "EPLAN 宿主报告失败" : error["message"].AsString("EPLAN 宿主报告失败");
                string detail = error == null ? null : error["detail"].AsString(null);
                throw new EplanBridgeException(code, message, detail);
            }

            JsonValue result = reply["result"];
            if (result == null) result = JsonValue.NewObject();

            // page_open 的成败不能只看宿主有没有把动作执行掉 —— 得看界面到底切没切。
            // 等待放在这一层做：宿主跑在 EPLAN 主线程上，它 Sleep 会把界面锁死，
            // 标题永远刷不出来。桥接器是独立进程，睡多久都不影响 EPLAN。
            if (op == "page_open")
            {
                string pageName = result["page"].AsString(null);
                if (!string.IsNullOrEmpty(pageName))
                {
                    bool shown = WaitWindowTitle(pageName, 4000);
                    result.Set("visibleInTitle", shown);

                    // 只有调用方**明确**要抢焦点时才把窗口提到前台（focus=true）。
                    // 默认不抢：用户很可能正在看别的东西，EPLAN 突然蹦到最前面是最烦人的交互。
                    // 换页本身（ExecuteAction 打开那一页）不受这个开关影响 —— 那是 page_open 的本职。
                    bool focus = args["focus"].AsBool(false);
                    if (focus)
                    {
                        IntPtr handle = FindEplanWindow();
                        if (handle != IntPtr.Zero) Activate(handle);
                    }
                }
            }

            return result;
        }

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        private const int SW_RESTORE = 9;
        private const int SW_MAXIMIZE = 3;
        private static readonly IntPtr HWND_TOP = IntPtr.Zero;
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_SHOWWINDOW = 0x0040;

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        /// <summary>
        /// 把 EPLAN 窗口提到最前。**只有调用方显式要焦点时才会走到这里。**
        ///
        /// 光调 SetForegroundWindow 不够：桥接器是后台进程，Windows 的前台锁会直接拒绝，
        /// 只闪一下任务栏。实测「临时置顶 + SwitchToThisWindow」在真机上也不生效
        /// （调用返回成功，前台窗口还是浏览器）。
        ///
        /// 真正可靠的是 AttachThreadInput：把本线程接到**当前前台窗口所属线程**的输入队列上，
        /// 这样两个线程共享前台状态，本线程的 SetForegroundWindow 就不再被拒。
        /// 用完必须解除，否则会把两个线程的输入队列一直粘在一起（拖慢甚至卡住前台程序）。
        /// </summary>
        private static void Activate(IntPtr handle)
        {
            uint foregroundThread = 0;
            uint currentThread = GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (IsIconic(handle)) ShowWindow(handle, SW_RESTORE);

                IntPtr foreground = GetForegroundWindow();
                if (foreground != IntPtr.Zero)
                {
                    foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
                    if (foregroundThread != 0 && foregroundThread != currentThread)
                    {
                        attached = AttachThreadInput(currentThread, foregroundThread, true);
                    }
                }

                BringWindowToTop(handle);
                SetForegroundWindow(handle);
                SetWindowPos(handle, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
            }
            catch { }
            finally
            {
                if (attached) AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        /// <summary>轮询 EPLAN 主窗口标题，直到里面出现目标页名或超时。</summary>
        private static bool WaitWindowTitle(string needle, int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                string title = WindowTitleOf(FindEplanWindow());
                if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                Thread.Sleep(120);
            }
            return false;
        }

        private static IntPtr FindEplanWindow()
        {
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    if (process.MainWindowHandle == IntPtr.Zero) continue;
                    string title = process.MainWindowTitle;
                    if (title != null && title.StartsWith("EPLAN Electric", StringComparison.OrdinalIgnoreCase))
                        return process.MainWindowHandle;
                }
                catch { }
                finally { process.Dispose(); }
            }
            return IntPtr.Zero;
        }

        private static string WindowTitleOf(IntPtr handle)
        {
            if (handle == IntPtr.Zero) return string.Empty;
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    if (process.MainWindowHandle == handle) return process.MainWindowTitle ?? string.Empty;
                }
                catch { }
                finally { process.Dispose(); }
            }
            return string.Empty;
        }

        /// <summary>建一个命名互斥量；名字没权限或不可用时返回 null，让调用方降级。</summary>
        private static Mutex CreateGate(string name)
        {
            try { return new Mutex(false, name); }
            catch { return null; }
        }

        /// <summary>
        /// 文件 IPC 的独占闸门。
        ///
        /// request.json 是固定路径：同一个桥接进程内部本来就是串行的（主循环一行一行读），
        /// 但**两个**桥接进程（两个 DSH 会话、或者 MCP 与调试脚本同时用）会互相覆盖请求文件，
        /// 输的那一方要白等满一个 timeout 才报超时，而且很可能什么都没执行。
        /// 用命名互斥把跨进程的情形也挡住。
        /// </summary>
        private static JsonValue SendThroughIpc(EplanRemoteClient client, string payload, int timeoutMs)
        {
            // Global\ 需要 SeCreateGlobalPrivilege（默认只给管理员和系统账户）。
            // 普通用户可能拿不到，那就退到会话级的 Local\；再不行就退化成不加锁 ——
            // 跨进程竞态只是少见情形，不值得因为它让整个桥接器不能用。
            Mutex gate = CreateGate(@"Global\EplanMcpIpc") ?? CreateGate(@"Local\EplanMcpIpc");
            if (gate == null) return SendThroughIpcCore(client, payload, timeoutMs);

            bool taken = false;
            try
            {
                try { taken = gate.WaitOne(IpcGateWaitMs, false); }
                catch (AbandonedMutexException)
                {
                    // 上一个持有者崩了，互斥量被系统强制释放 —— 这时候通道归我们。
                    taken = true;
                }

                if (!taken)
                {
                    throw new EplanBridgeException("IPC_BUSY",
                        "另一个调用已经占着 EPLAN 的 IPC 通道超过 " + (IpcGateWaitMs / 1000) + " 秒。",
                        "通常是另一个会话正在跑长任务（导出/渲染），或者上一次调用卡在模态框上没退出。等它结束再试。");
                }

                return SendThroughIpcCore(client, payload, timeoutMs);
            }
            finally
            {
                if (taken)
                {
                    try { gate.ReleaseMutex(); } catch { }
                }
                try { gate.Dispose(); } catch { }
            }
        }

        // 跨进程等待上限。比正常的 120 秒调用超时留一点余量，让排队的调用有机会跑完。
        private const int IpcGateWaitMs = 180000;

        /// <summary>
        /// 文件 IPC 一次往返：写 request.json → ExecuteAction("EplanMcpRun") → 轮询 reply-&lt;id&gt;.json。
        /// </summary>
        private static JsonValue SendThroughIpcCore(EplanRemoteClient client, string payload, int timeoutMs)
        {
            string ipcDir = Path.Combine(StateDir, "ipc");
            Directory.CreateDirectory(ipcDir);

            // 发请求之前先看一眼有没有模态框挡着。
            //
            // 只在超时之后才检查是不够的：模态框占住 EPLAN 主线程时 ExecuteAction 永不返回，
            // 每次调用都要白等满一个 timeout（默认 120 秒）才拿到错误 —— 模型会把这段时间当成
            // 「工具坏了」反复重试，用户则在旁边干等。提前检查能把 120 秒变成 100 毫秒，
            // 而且报的是「有个框挡住了，请关掉」这种能直接照做的信息。
            //
            // 先试着自己答掉已知的框（检查相容性 / 系统消息），它们有标准答案，
            // 不该让用户或模型为它们停下来；答完还挡着才报错。
            string settled = SettleKnownDialogs();
            if (settled != null)
            {
                AppendDialogLog(settled);
                System.Threading.Thread.Sleep(200);
            }

            string blockedBeforeSend = DescribeBlockingDialog();
            if (blockedBeforeSend != null)
            {
                throw new EplanBridgeException("EPLAN_BLOCKED_BY_DIALOG",
                    "EPLAN 被一个对话框挡住了：" + blockedBeforeSend + "。把它关掉再重试；这次请求没有发出去，什么都没改。",
                    "模态对话框会占住 EPLAN 主线程，所有 API 调用都会一起卡住。");
            }

            string requestId = Guid.NewGuid().ToString("N");
            string replyPath = Path.Combine(ipcDir, "reply-" + requestId + ".json");
            string requestPath = Path.Combine(ipcDir, "request.json");

            // 请求文件得带上 id，脚本靠它命名响应文件。
            JsonValue envelope = Json.Parse(payload);
            envelope.Set("id", requestId);
            string requestText = Json.Write(envelope);

            // 先写临时文件再改名，避免脚本读到半个文件。
            string tempRequest = requestPath + ".tmp";
            File.WriteAllText(tempRequest, requestText, new UTF8Encoding(false));
            if (File.Exists(requestPath)) File.Delete(requestPath);
            File.Move(tempRequest, requestPath);

            CallingContext context = new CallingContext();
            bool triggered = client.ExecuteAction(ActionName, ref context);
            string actionMessage = context.Message;

            if (!triggered)
            {
                try { File.Delete(requestPath); } catch { }

                // 动作不存在时 EPLAN 返回 S085021「无法找到操作…不包含在功能范围内」。
                if (!string.IsNullOrEmpty(actionMessage) &&
                    (actionMessage.IndexOf("EplanMcpRun", StringComparison.OrdinalIgnoreCase) >= 0 ||
                     actionMessage.IndexOf("S085021", StringComparison.OrdinalIgnoreCase) >= 0 ||
                     actionMessage.IndexOf("功能范围", StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    throw new EplanBridgeException("HOST_NOT_INSTALLED",
                        "EPLAN 里还没有装宿主（找不到动作 EplanMcpRun）。" +
                        "请先执行 install 操作注册引导脚本，详见 README。", actionMessage);
                }
                throw new EplanBridgeException("EPLAN_ACTION_FAILED",
                    string.IsNullOrEmpty(actionMessage) ? "EPLAN 执行 EplanMcpRun 失败，没有返回错误文本。" : actionMessage, null);
            }

            // 脚本在主线程上同步处理，正常情况下几百毫秒内就有响应文件。
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                if (File.Exists(replyPath))
                {
                    string text = null;
                    for (int attempt = 0; attempt < 10; attempt++)
                    {
                        try
                        {
                            text = File.ReadAllText(replyPath, Encoding.UTF8);
                            break;
                        }
                        catch (IOException)
                        {
                            // 文件可能还占着，等一下再读。
                            System.Threading.Thread.Sleep(30);
                        }
                    }
                    try { File.Delete(replyPath); } catch { }

                    if (text == null)
                    {
                        throw new EplanBridgeException("HOST_BAD_REPLY", "读不到 EPLAN 的响应文件: " + replyPath, null);
                    }

                    try { return Json.Parse(text); }
                    catch (Exception ex)
                    {
                        throw new EplanBridgeException("HOST_BAD_REPLY",
                            "EPLAN 返回的 JSON 无法解析: " + ex.Message,
                            text.Length > 2000 ? text.Substring(0, 2000) : text);
                    }
                }
                System.Threading.Thread.Sleep(25);
            }

            try { File.Delete(requestPath); } catch { }

            // 超时的第一嫌疑不是脚本，是 EPLAN 被模态对话框挡住了：
            // 模态框占住 EPLAN 主线程，ExecuteAction 就永远不返回，任何 API 调用一起挂死。
            // 与其让用户对着超时瞎猜，不如直接把那个框念出来。
            string dialog = DescribeBlockingDialog();
            if (dialog != null)
            {
                throw new EplanBridgeException("EPLAN_BLOCKED_BY_DIALOG",
                    "等了 " + timeoutMs + " 毫秒没有响应，EPLAN 被一个对话框挡住了：" + dialog +
                    "。把它关掉再重试即可；之前那次操作很可能没有执行。",
                    "模态对话框会占住 EPLAN 主线程，所有 API 调用都会一起卡住。");
            }

            // 没有对话框，那可能是脚本压根没跑起来。翻一下日志给个更准的提示。
            string hint = BootstrapHint();
            throw new EplanBridgeException("EPLAN_TIMEOUT",
                "等了 " + timeoutMs + " 毫秒，EPLAN 没有返回结果。" + hint,
                "如果重复出现，请检查 C:\\Users\\Public\\EPLAN\\Data\\eplan-mcp\\bootstrap.log 和 EPLAN 日志（EplLog.eldb）。");
        }


        // ---------------------------------------------------------------
        // 超时排障：EPLAN 是不是被模态框挡住了。
        //
        // 模态对话框是 EPLAN 最常见的「假死」来源：一点下去，主线程被占住，
        // ExecuteAction 永远不返回，表现就是所有工具调用一起超时。
        // 这里枚举 EPLAN 进程的可见顶层窗口，把不是主窗口的 #32770 报出来。
        // ---------------------------------------------------------------

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        /// <summary>列出 EPLAN 进程里挡在前面的对话框；没有就返回 null。</summary>
        private static string DescribeBlockingDialog()
        {
            try
            {
                List<uint> eplanPids = EplanPids();
                if (eplanPids.Count == 0) return null;

                List<string> found = new List<string>();
                EnumWindows(delegate(IntPtr handle, IntPtr state)
                {
                    uint pid;
                    GetWindowThreadProcessId(handle, out pid);
                    if (!eplanPids.Contains(pid)) return true;
                    if (!IsWindowVisible(handle)) return true;

                    StringBuilder cls = new StringBuilder(256);
                    GetClassNameW(handle, cls, 256);
                    if (cls.ToString() != "#32770") return true;

                    StringBuilder text = new StringBuilder(512);
                    GetWindowTextW(handle, text, 512);
                    string title = text.ToString().Trim();
                    found.Add(title.Length == 0 ? "（无标题对话框）" : "「" + title + "」");
                    return true;
                }, IntPtr.Zero);

                if (found.Count == 0) return null;
                return string.Join("、", found.ToArray());
            }
            catch
            {
                return null;
            }
        }

        // ---------------------------------------------------------------
        // 已知对话框自动处置
        //
        // EPLAN 每次非正常关闭后重开项目，都会先弹「检查相容性」；现场经常就卡在
        // 这个框上，看起来像工具坏了。这里把「有标准答案的框」直接答掉：
        //   检查相容性 → 点「以后」（先打开，下次再查；只是恢复提示，不动数据）
        //   系统消息   → 关掉（内容是 S046001 一类可以忽略的告警）
        // 不认识的框一律不碰，交给 DescribeBlockingDialog 报出来让人处理。
        // ---------------------------------------------------------------

        private static readonly string[][] KnownDialogs = new string[][]
        {
            new string[] { "检查相容性", "以后" },
            new string[] { "检查兼容性", "以后" },
            new string[] { "系统消息", null },
        };

        private delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        private const uint BM_CLICK = 0x00F5;
        private const uint WM_CLOSE = 0x0010;

        private static uint TargetEplanPid()
        {
            if (_clientProcessId != 0) return (uint)_clientProcessId;
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    if (process.MainWindowHandle == IntPtr.Zero) continue;
                    string title = process.MainWindowTitle;
                    if (title != null && title.StartsWith("EPLAN Electric", StringComparison.OrdinalIgnoreCase))
                        return (uint)process.Id;
                }
                catch { }
                finally { process.Dispose(); }
            }
            return 0;
        }

        /// <summary>
        /// 给一个 EPLAN 实例打分：真的载着项目的窗口优先。
        ///
        /// 本机常同时开两个窗口（一个空启动、一个开着项目）。以前固定用 servers[0]，
        /// 于是命令对着空实例发 —— 表现是项目打不开、或者报「另一个程序正在使用此文件」。
        /// 有项目时窗口标题是「EPLAN Electric P8 2.9 SP1 - C:\...\项目名 - =XXX/7」，
        /// 至少两个「 - 」并且带页名；空实例只有程序名。
        /// </summary>
        private static int InstanceScore(EplanServerData server)
        {
            int score = 0;
            if (server.EplanVariant != null && server.EplanVariant.IndexOf("P8", StringComparison.OrdinalIgnoreCase) >= 0) score += 100;
            string title = EplanWindowTitle((uint)server.EplanProcessID);
            if (!string.IsNullOrEmpty(title))
            {
                int separators = 0;
                for (int index = 0; index + 2 < title.Length; index++)
                {
                    if (title[index] == ' ' && title[index + 1] == '-' && title[index + 2] == ' ') separators++;
                }
                if (separators >= 2) score += 50;          // 标题里有项目
                if (title.IndexOf('=') >= 0) score += 25;   // 标题里有页名 =XXX/1
                else if (separators <= 1) score -= 20;      // 只有程序名，多半是空窗口
            }
            return score;
        }

        /// <summary>某个进程最长的一条可见顶层窗口标题（找不到返回 null）。</summary>
        private static string EplanWindowTitle(uint pid)
        {
            string best = null;
            EnumWindows(delegate(IntPtr handle, IntPtr state)
            {
                uint windowPid;
                GetWindowThreadProcessId(handle, out windowPid);
                if (windowPid != pid) return true;
                if (!IsWindowVisible(handle)) return true;
                StringBuilder text = new StringBuilder(512);
                int length = GetWindowTextW(handle, text, text.Capacity);
                if (length <= 0) return true;
                string title = text.ToString();
                if (title.Length == 0) return true;
                if (best == null || title.Length > best.Length) best = title;
                return true;
            }, IntPtr.Zero);
            return best;
        }

        /// <summary>
        /// 本机所有 EPLAN 进程的 pid。
        ///
        /// 多实例是本机的常态（用户会同时开两个窗口），对话框可能出现在**任何一个**
        /// 实例上；只看第一个会漏掉，表现就是「明明屏幕上有个框，工具说没有」。
        /// </summary>
        private static List<uint> EplanPids()
        {
            List<uint> pids = new List<uint>();
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    if (process.MainWindowHandle == IntPtr.Zero) continue;
                    string title = process.MainWindowTitle;
                    if (title == null) continue;
                    if (title.StartsWith("EPLAN Electric", StringComparison.OrdinalIgnoreCase))
                        pids.Add((uint)process.Id);
                }
                catch { }
                finally { process.Dispose(); }
            }
            return pids;
        }

        /// <summary>点掉/关掉已知对话框；返回做过的事，没有可做的返回 null。</summary>
        private static string SettleKnownDialogs()
        {
            try
            {
                List<uint> pids = EplanPids();
                if (pids.Count == 0) return null;

                List<string> acted = new List<string>();
                EnumWindows(delegate(IntPtr handle, IntPtr state)
                {
                    uint windowPid;
                    GetWindowThreadProcessId(handle, out windowPid);
                    if (!pids.Contains(windowPid)) return true;
                    if (!IsWindowVisible(handle)) return true;

                    StringBuilder cls = new StringBuilder(256);
                    GetClassNameW(handle, cls, 256);
                    if (cls.ToString() != "#32770") return true;

                    StringBuilder caption = new StringBuilder(512);
                    GetWindowTextW(handle, caption, 512);
                    string title = caption.ToString().Trim();
                    if (title.Length == 0) return true;

                    foreach (string[] known in KnownDialogs)
                    {
                        if (title.IndexOf(known[0], StringComparison.OrdinalIgnoreCase) < 0) continue;

                        string button = known[1];
                        if (button == null)
                        {
                            PostMessage(handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                            acted.Add("「" + title + "」→ 已关闭");
                            break;
                        }

                        IntPtr target = IntPtr.Zero;
                        EnumChildWindows(handle, delegate(IntPtr child, IntPtr childState)
                        {
                            StringBuilder childClass = new StringBuilder(256);
                            GetClassNameW(child, childClass, 256);
                            if (childClass.ToString() != "Button") return true;
                            StringBuilder childText = new StringBuilder(256);
                            GetWindowTextW(child, childText, 256);
                            if (childText.ToString().Trim() == button) { target = child; return false; }
                            return true;
                        }, IntPtr.Zero);

                        if (target != IntPtr.Zero)
                        {
                            SendMessage(target, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                            acted.Add("「" + title + "」→ 已点「" + button + "」");
                        }
                        else
                        {
                            PostMessage(handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                            acted.Add("「" + title + "」→ 没有「" + button + "」，已关闭");
                        }
                        break;
                    }
                    return true;
                }, IntPtr.Zero);

                if (acted.Count == 0) return null;
                return string.Join("；", acted.ToArray());
            }
            catch
            {
                return null;
            }
        }

        /// <summary>超时时看一眼引导日志，把「脚本没加载」和「脚本卡住」区分开。</summary>
        private static string BootstrapHint()
        {
            try
            {
                string logPath = Path.Combine(StateDir, "bootstrap.log");
                if (!File.Exists(logPath))
                    return " 引导脚本可能从未加载（找不到 bootstrap.log）。";

                string[] lines = File.ReadAllLines(logPath, Encoding.UTF8);
                for (int i = lines.Length - 1; i >= 0 && i >= lines.Length - 4; i--)
                {
                    string line = lines[i] ?? string.Empty;
                    if (line.IndexOf("请求", StringComparison.Ordinal) >= 0 ||
                        line.IndexOf("读取请求失败", StringComparison.Ordinal) >= 0 ||
                        line.IndexOf("写响应失败", StringComparison.Ordinal) >= 0 ||
                        line.IndexOf("HOST_LOAD_FAILED", StringComparison.Ordinal) >= 0)
                    {
                        return " 引导日志最后一条相关记录：" + line.Trim();
                    }
                }
                return " 引导脚本已加载，但没有记录到本次请求。";
            }
            catch
            {
                return string.Empty;
            }
        }
    }

    internal class EplanBridgeException : Exception
    {
        public string Code { get; private set; }
        public string Detail { get; private set; }

        public EplanBridgeException(string code, string message, string detail)
            : base(message)
        {
            Code = code;
            Detail = detail;
        }
    }
}
