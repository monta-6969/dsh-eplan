// symbols：查符号库，确认符号名存在再插。
// 模型最容易犯的错就是凭记忆编符号名，这个工具就是为了堵住这个错。
using System;
using System.Collections.Generic;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.MasterData;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class SymbolsTool
    {
        public static JsonValue Run(JsonValue args)
        {
            string libraryName = args["library"].AsString("GB_symbol");
            // query 和 filter 都接受：工具描述里写的是 query，
            // 但 EPLAN 用户的习惯说法是 filter（和 pages 一致）。谁给了就用谁。
            string query = args["query"].AsString(null);
            if (string.IsNullOrEmpty(query)) query = args["filter"].AsString(null);
            int limit = args["limit"].AsInt(50);
            if (limit <= 0) limit = 50;

            Project project = Context.Resolve(args["project"].AsString(null));

            JsonValue available = JsonValue.NewArray();
            if (project.SymbolLibraries != null)
            {
                foreach (SymbolLibrary lib in project.SymbolLibraries)
                    available.Add(JsonValue.NewString(lib.Name));
            }

            SymbolLibrary library;
            try
            {
                library = Context.Library(libraryName, args["project"].AsString(null));
            }
            catch (Exception ex)
            {
                throw new HostException("LIBRARY_NOT_FOUND",
                    "打不开符号库「" + libraryName + "」：" + ex.Message,
                    "当前项目可用的符号库: " + Json.Write(available));
            }

            Symbol[] symbols = library.Symbols;
            if (symbols == null) symbols = new Symbol[0];

            List<Symbol> matched = new List<Symbol>();
            foreach (Symbol symbol in symbols)
            {
                if (query != null && query.Length > 0)
                {
                    string name = symbol.Name ?? string.Empty;
                    if (name.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
                }
                matched.Add(symbol);
            }

            matched.Sort(delegate (Symbol a, Symbol b)
            {
                return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
            });

            JsonValue result = JsonValue.NewObject();
            result.Set("library", libraryName);
            result.Set("availableLibraries", available);
            result.Set("totalSymbols", symbols.Length);
            result.Set("matchedCount", matched.Count);

            JsonValue list = JsonValue.NewArray();
            int emitted = 0;
            foreach (Symbol symbol in matched)
            {
                if (emitted >= limit) break;
                emitted++;
                JsonValue item = JsonValue.NewObject();
                item.Set("name", symbol.Name);
                try { item.Set("type", symbol.Type.ToString()); } catch { }
                JsonValue variants = JsonValue.NewArray();
                try
                {
                    if (symbol.Variants != null)
                        foreach (SymbolVariant v in symbol.Variants)
                            variants.Add(JsonValue.NewNumber(v.VariantNr));
                }
                catch { }
                item.Set("variants", variants);
                list.Add(item);
            }
            result.Set("symbols", list);
            if (matched.Count > emitted) result.Set("truncated", true);
            return result;
        }
    }
}
