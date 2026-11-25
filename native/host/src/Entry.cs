// EPLAN 进程内的宿主：所有真正的绘图逻辑都在这里。
//
// 为什么需要它：EPLAN 的脚本编译器（EplanEplApiScriptLogu.erx）把引用集写死了，
// 里面没有 Eplan.EplApi.DataModelu.dll / HEServicesu.dll，所以 .cs 脚本
// 连 "DataModel" 这个命名空间都看不到，画不了图。
// 这段代码是我们自己用 csc.exe 编译成独立 DLL、再由引导脚本用反射加载进来的，
// 因此可以自由引用 DataModel / HEServices。
//
// 生命周期：宿主实例在 EPLAN 进程内缓存，跨次调用复用（缓存 SymbolLibrary 等）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;
using Eplan.EplApi.DataModel.MasterData;
using Eplan.EplApi.HEServices;
using EplanMcp;

namespace EplanMcpHost
{
    /// <summary>
    /// 由引导脚本反射调用的唯一入口。
    /// 参数 payloadJson 形如 {"op":"status","args":{...}}，
    /// 返回 {"ok":true,"result":{...}} 或 {"ok":false,"error":{"code","message","detail"}}。
    /// </summary>
    public class Entry
    {
        private static readonly object Gate = new object();

        public string Run(string payloadJson)
        {
            // EPLAN 的动作可能并发进来，统一串行化，避免两个线程同时改同一个项目。
            lock (Gate)
            {
                JsonValue response = JsonValue.NewObject();
                try
                {
                    JsonValue request = Json.Parse(payloadJson);
                    string op = request["op"].AsString("");
                    JsonValue args = request["args"];
                    if (args == null || !args.IsObject) args = JsonValue.NewObject();

                    // 所有 DataModel 访问都必须在一个 LockingStep 里，否则
                    // ProjectManager.CurrentProject 直接抛 S063110「不能生成 LockingStep 类别的对象」。
                    // 实测 ExecuteAction 跑在 EPLAN 主线程（threadId=1, STA,
                    // DispatcherSynchronizationContext），所以这里新建 LockingStep 是合法的。
                    //
                    // LockingStep 只有 ctor 和 Dispose()，没有 Rollback/Commit：
                    // Dispose 即提交，退出 using 就落盘。需要撤销的操作由各工具自己做
                    // （例如 DrawTool 失败时会 SetUndoStep/删除刚建的图元）。
                    // 所有 DataModel 访问都必须在一个 LockingStep 里。
                    // 连 project_open 也不例外：ProjectManager.OpenProject 内部会调
                    // lockHandleIfNeccesary，没有 LockingStep 直接抛
                    // S063110「不能生成 LockingStep 类别的对象」（实测踩过）。
                    JsonValue result;
                    using (LockingStep step = new LockingStep())
                    {
                        result = Dispatcher.Execute(op, args);
                    }

                    response.Set("ok", true);
                    response.Set("result", result ?? JsonValue.NewObject());
                }
                catch (HostException ex)
                {
                    response.Set("ok", false);
                    JsonValue err = JsonValue.NewObject();
                    err.Set("code", ex.Code);
                    err.Set("message", ex.Message);
                    if (ex.Detail != null) err.Set("detail", ex.Detail);
                    response.Set("error", err);
                }
                catch (Exception ex)
                {
                    response.Set("ok", false);
                    JsonValue err = JsonValue.NewObject();
                    err.Set("code", "EPLAN_HOST_ERROR");
                    err.Set("message", Describe(ex));
                    err.Set("detail", ex.ToString());
                    response.Set("error", err);
                }
                return Json.Write(response);
            }
        }

        private static string Describe(Exception ex)
        {
            Exception inner = ex;
            List<string> parts = new List<string>();
            while (inner != null)
            {
                string text = inner.GetType().Name + ": " + inner.Message;
                if (!parts.Contains(text)) parts.Add(text);
                inner = inner.InnerException;
            }
            return string.Join(" <- ", parts.ToArray());
        }
    }

    internal class HostException : Exception
    {
        public string Code { get; private set; }
        public string Detail { get; private set; }

        public HostException(string code, string message) : base(message) { Code = code; }
        public HostException(string code, string message, string detail) : base(message) { Code = code; Detail = detail; }
    }
}
