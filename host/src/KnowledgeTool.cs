// 元件语义知识库（M3 实现）。
//
// 铁律：几何永远实时从 EPLAN 取（symbol_catalog(action="pins")，实测十几毫秒），**不落盘**。
// 落盘的只有「这个符号在这张图里是干什么的」这类模型推断出来的语义，而且必须带 source：
//   derived  —— 模型推断的
//   verified —— 用户确认过的
//
// 为什么要这么死板：EPLAN 符号库没有文字描述（823 个符号，只有名字/类型/变体数），
// 所以「F1 是熔断器」这种知识只能靠人或者推断来补。一旦把它和引脚几何混在一个文件里，
// 过一个版本库变了，几何就是错的，而调用方分不出哪些是 EPLAN 说的、哪些是人猜的。
// 分开之后，几何永远新鲜，语义永远标注来源。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using EplanMcp;

namespace EplanMcpHost
{
    internal static class KnowledgeTool
    {
        internal static string FilePath
        {
            get { return Path.Combine(Paths.KnowledgeDir, "symbols.json"); }
        }

        // 这些键属于几何，一律拒收 —— 收下来就等于把过期的引脚坐标当真话存起来了。
        private static readonly string[] GeometryKeys = new string[] {
            "pins", "pin", "geometry", "location", "locations", "points", "offset", "offsets", "direction"
        };

        private static JsonValue LoadAll()
        {
            try
            {
                if (!File.Exists(FilePath)) return JsonValue.NewObject();
                string text = File.ReadAllText(FilePath, Encoding.UTF8);
                if (text.Trim().Length == 0) return JsonValue.NewObject();
                JsonValue parsed = Json.Parse(text);
                return parsed != null && parsed.IsObject ? parsed : JsonValue.NewObject();
            }
            catch
            {
                return JsonValue.NewObject();
            }
        }

        private static void SaveAll(JsonValue all)
        {
            string dir = Path.GetDirectoryName(FilePath);
            if (!string.IsNullOrEmpty(dir)) System.IO.Directory.CreateDirectory(dir);
            File.WriteAllText(FilePath, Json.Write(all), new UTF8Encoding(false));
        }

        /// <summary>读语义。参数：symbol / library / query。</summary>
        public static JsonValue Get(JsonValue args)
        {
            string symbol = args["symbol"].AsString(null);
            string library = args["library"].AsString(null);
            string query = args["query"].AsString(null);

            JsonValue all = LoadAll();

            if (!string.IsNullOrEmpty(symbol))
            {
                string entryKey = Key(library, symbol);
                JsonValue hit = all[entryKey];
                JsonValue result = JsonValue.NewObject();
                result.Set("symbol", JsonValue.NewString(symbol));
                result.Set("library", library == null ? JsonValue.NewNull() : JsonValue.NewString(library));
                result.Set("known", JsonValue.NewBool(hit != null && hit.IsObject));
                if (hit != null && hit.IsObject) result.Set("entry", hit);
                result.Set("note", "这里只有语义。引脚坐标请用 symbol_catalog(action=\"pins\") 实时取 —— 几何不落盘。");
                result.Set("file", JsonValue.NewString(FilePath));
                return result;
            }

            JsonValue matches = JsonValue.NewArray();
            int total = all.Count;
            if (all.IsObject)
            {
                foreach (string key in all.Keys)
                {
                    JsonValue entry = all[key];
                    if (entry == null || !entry.IsObject) continue;
                    if (!string.IsNullOrEmpty(query))
                    {
                        string hay = (entry["concept"].AsString("") + " " + entry["usage"].AsString("") + " " + key);
                        if (hay.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    }
                    matches.Add(entry);
                }
            }

            JsonValue result2 = JsonValue.NewObject();
            result2.Set("query", query == null ? JsonValue.NewNull() : JsonValue.NewString(query));
            result2.Set("total", JsonValue.NewNumber(total));
            result2.Set("matchedCount", JsonValue.NewNumber(matches.Count));
            result2.Set("entries", matches);
            result2.Set("file", JsonValue.NewString(FilePath));
            if (total == 0)
                result2.Set("note", "知识库还是空的。用 symbol_catalog(action=\"annotate\") 把你确认过的元件含义写进来。");
            return result2;
        }

        /// <summary>写回语义。参数：symbol / library / concept / usage / verified。</summary>
        public static JsonValue Annotate(JsonValue args)
        {
            string symbol = args["symbol"].AsString(null);
            if (string.IsNullOrEmpty(symbol))
                throw new HostException("BAD_ARGUMENT", "要给 symbol，例如 \"F1\"。", "只记录语义，几何不用传。");

            string library = args["library"].AsString(null);
            string concept = args["concept"].AsString(null);
            string usage = args["usage"].AsString(null);
            bool verified = args["verified"].AsBool(false);

            JsonValue ignored = JsonValue.NewArray();
            if (args.IsObject)
            {
                foreach (string key in args.Keys)
                {
                    foreach (string geometryKey in GeometryKeys)
                    {
                        if (string.Equals(key, geometryKey, StringComparison.OrdinalIgnoreCase))
                        {
                            ignored.Add(JsonValue.NewString(key));
                            break;
                        }
                    }
                }
            }

            JsonValue all = LoadAll();
            string entryKey = Key(library, symbol);
            JsonValue existing = all[entryKey];
            JsonValue entry = existing != null && existing.IsObject ? existing : JsonValue.NewObject();

            entry.Set("symbol", JsonValue.NewString(symbol));
            if (!string.IsNullOrEmpty(library)) entry.Set("library", JsonValue.NewString(library));
            if (!string.IsNullOrEmpty(concept)) entry.Set("concept", JsonValue.NewString(concept));
            if (!string.IsNullOrEmpty(usage)) entry.Set("usage", JsonValue.NewString(usage));
            entry.Set("source", JsonValue.NewString(verified ? "verified" : "derived"));
            entry.Set("updatedAt", JsonValue.NewString(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)));

            all.Set(entryKey, entry);
            SaveAll(all);

            JsonValue result = JsonValue.NewObject();
            result.Set("saved", JsonValue.NewBool(true));
            result.Set("key", JsonValue.NewString(entryKey));
            result.Set("entry", entry);
            result.Set("file", JsonValue.NewString(FilePath));
            if (ignored.Count > 0)
                result.Set("ignoredGeometryKeys", ignored);
            return result;
        }

        private static string Key(string library, string symbol)
        {
            string lib = string.IsNullOrEmpty(library) ? "?" : library;
            return lib + "|" + symbol;
        }
    }
}
