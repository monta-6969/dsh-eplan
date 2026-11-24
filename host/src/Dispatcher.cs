// 分发器：把 op 名字映射到实现。新增能力只在这里加一行。
using System;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class Dispatcher
    {
        public static JsonValue Execute(string op, JsonValue args)
        {
            switch (op)
            {
                case "status": return StatusTool.Run(args);
                case "pages": return PagesTool.Run(args);
                case "page_create": return PageCreateTool.Run(args);
                case "draw": return DrawTool.Run(args);
                case "symbols": return SymbolsTool.Run(args);
                case "symbol_insert": return SymbolInsertTool.Run(args);
                case "props": return PropsTool.Run(args);
                case "export": return ExportTool.Run(args);
                case "diagnose": return DiagnoseTool.Run(args);
                case "actions": return ActionsTool.Run(args);
                case "tagloc": return TagLocTool.Run(args);
                case "inspect": return InspectTool.Run(args);
                case "look": return LookTool.Run(args);
                case "symbol_info": return SymbolInfoTool.Run(args);
                case "project_open": return ProjectTool.Open(args);
                case "project_close": return ProjectTool.Close(args);
                case "project_create": return ProjectCreateTool.Run(args);
                case "probe_props": return ProbePropsTool.Run(args);
                case "check": return CheckTool.Run(args);
                case "page_open": return PageOpenTool.Run(args);
                case "page_delete": return PageCreateTool.Delete(args);
                // 0.5.0 新增（M0 只冻结接口，M2/M3 实现）
                case "op_history": return OpLogTool.History(args);
                case "op_rollback": return OpLogTool.Rollback(args);
                case "knowledge_get": return KnowledgeTool.Get(args);
                case "knowledge_annotate": return KnowledgeTool.Annotate(args);
                case "box": return BoxTool.Run(args);
                // 增量改页：挪一个对象 / 改一个设备标识 / 删一个对象，都不重建整页。
                case "placement_move": return PlacementEditTool.Move(args);
                case "placement_relabel": return PlacementEditTool.Relabel(args);
                case "placement_delete": return PlacementEditTool.Delete(args);
                // 经验文件：只追加不覆盖，和 symbol 语义库分开存
                default:
                    throw new HostException("UNKNOWN_OP", "EPLAN 宿主不认识的操作: " + op);
            }
        }
    }
}

