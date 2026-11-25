// 极简 JSON：桥接器和 EPLAN 内宿主共用。
//
// 为什么自己写：EPLAN 的 AppDomain 里不保证有 System.Web.Extensions，
// 而 .NET 自带的 DataContractJsonSerializer 在 C# 5 下用起来又太啰嗦。
// 这里只做本项目需要的事：对象、数组、字符串、数字、布尔、null。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace EplanMcp
{
    public enum JsonKind { Null, Bool, Number, String, Array, Object }

    public class JsonValue
    {
        public JsonKind Kind;
        public bool BoolValue;
        public double NumberValue;
        public string StringValue;
        public List<JsonValue> Items;
        public Dictionary<string, JsonValue> Members;

        public static JsonValue NewNull() { JsonValue v = new JsonValue(); v.Kind = JsonKind.Null; return v; }
        public static JsonValue NewBool(bool b) { JsonValue v = new JsonValue(); v.Kind = JsonKind.Bool; v.BoolValue = b; return v; }
        public static JsonValue NewNumber(double d) { JsonValue v = new JsonValue(); v.Kind = JsonKind.Number; v.NumberValue = d; return v; }
        public static JsonValue NewString(string s)
        {
            JsonValue v = new JsonValue();
            if (s == null) { v.Kind = JsonKind.Null; return v; }
            v.Kind = JsonKind.String; v.StringValue = s; return v;
        }
        public static JsonValue NewObject()
        {
            JsonValue v = new JsonValue();
            v.Kind = JsonKind.Object;
            v.Members = new Dictionary<string, JsonValue>(StringComparer.Ordinal);
            return v;
        }
        public static JsonValue NewArray()
        {
            JsonValue v = new JsonValue();
            v.Kind = JsonKind.Array;
            v.Items = new List<JsonValue>();
            return v;
        }

        public bool IsNull { get { return Kind == JsonKind.Null; } }
        public bool IsObject { get { return Kind == JsonKind.Object; } }
        public bool IsArray { get { return Kind == JsonKind.Array; } }

        /// <summary>缺省值：所有 As* 都返回各自的 fallback，链式取成员也不会抛。</summary>
        private static readonly JsonValue Missing = NewNull();

        /// <summary>
        /// 取成员；不存在或不是对象时返回一个 Null 值对象（不是 C# null）。
        ///
        /// 返回嵌入的 null 而不是 C# null，是为了支持 args["filter"].AsString(null) 这种写法：
        /// 写工具时少一层判空，也就少一类 NullReferenceException。这是踩过的坑——
        /// PagesTool 里 args["filter"] 一开始就崩在这里。
        /// </summary>
        public JsonValue this[string key]
        {
            get
            {
                if (Kind != JsonKind.Object || Members == null) return Missing;
                JsonValue v;
                return Members.TryGetValue(key, out v) ? (v ?? Missing) : Missing;
            }
            set
            {
                if (Kind != JsonKind.Object) return;
                Members[key] = value ?? Missing;
            }
        }


        public JsonValue this[int index]
        {
            get
            {
                if (Kind != JsonKind.Array || Items == null) return Missing;
                if (index < 0 || index >= Items.Count) return Missing;
                return Items[index] ?? Missing;
            }
        }

        public int Count
        {
            get
            {
                if (Kind == JsonKind.Array) return Items == null ? 0 : Items.Count;
                if (Kind == JsonKind.Object) return Members == null ? 0 : Members.Count;
                return 0;
            }
        }

        public bool Has(string key) { return this[key] != null; }

        public string AsString(string fallback)
        {
            if (Kind == JsonKind.String) return StringValue;
            if (Kind == JsonKind.Number) return NumberValue.ToString(CultureInfo.InvariantCulture);
            if (Kind == JsonKind.Bool) return BoolValue ? "true" : "false";
            return fallback;
        }

        public double AsDouble(double fallback)
        {
            if (Kind == JsonKind.Number) return NumberValue;
            if (Kind == JsonKind.String)
            {
                double d;
                if (double.TryParse(StringValue, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            }
            return fallback;
        }

        public int AsInt(int fallback)
        {
            double d = AsDouble(double.NaN);
            if (double.IsNaN(d)) return fallback;
            return (int)Math.Round(d);
        }

        public bool AsBool(bool fallback)
        {
            if (Kind == JsonKind.Bool) return BoolValue;
            if (Kind == JsonKind.String) return string.Equals(StringValue, "true", StringComparison.OrdinalIgnoreCase);
            if (Kind == JsonKind.Number) return NumberValue != 0;
            return fallback;
        }

        public void Add(JsonValue item)
        {
            if (Kind != JsonKind.Array) return;
            Items.Add(item ?? NewNull());
        }

        public void Set(string key, JsonValue value)
        {
            if (Kind != JsonKind.Object) return;
            Members[key] = value ?? NewNull();
        }

        public void Set(string key, string value) { Set(key, NewString(value)); }
        public void Set(string key, double value) { Set(key, NewNumber(value)); }
        public void Set(string key, int value) { Set(key, NewNumber(value)); }
        public void Set(string key, bool value) { Set(key, NewBool(value)); }

        public IEnumerable<string> Keys
        {
            get
            {
                if (Kind != JsonKind.Object || Members == null) return new string[0];
                return Members.Keys;
            }
        }

        public override string ToString() { return Json.Write(this); }
    }

    public static class Json
    {
        public static string Write(JsonValue value)
        {
            StringBuilder sb = new StringBuilder();
            WriteValue(sb, value);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, JsonValue v)
        {
            if (v == null) { sb.Append("null"); return; }
            switch (v.Kind)
            {
                case JsonKind.Null: sb.Append("null"); break;
                case JsonKind.Bool: sb.Append(v.BoolValue ? "true" : "false"); break;
                case JsonKind.Number:
                    double d = v.NumberValue;
                    if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); break; }
                    if (d == Math.Floor(d) && Math.Abs(d) < 1e15) sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
                    else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case JsonKind.String: WriteString(sb, v.StringValue); break;
                case JsonKind.Array:
                    sb.Append('[');
                    if (v.Items != null)
                    {
                        for (int i = 0; i < v.Items.Count; i++)
                        {
                            if (i > 0) sb.Append(',');
                            WriteValue(sb, v.Items[i]);
                        }
                    }
                    sb.Append(']');
                    break;
                case JsonKind.Object:
                    sb.Append('{');
                    if (v.Members != null)
                    {
                        bool first = true;
                        foreach (KeyValuePair<string, JsonValue> kv in v.Members)
                        {
                            if (!first) sb.Append(',');
                            first = false;
                            WriteString(sb, kv.Key);
                            sb.Append(':');
                            WriteValue(sb, kv.Value);
                        }
                    }
                    sb.Append('}');
                    break;
            }
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            if (s == null) { sb.Append("null"); return; }
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == '\u2028' || c == '\u2029')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        public static JsonValue Parse(string text)
        {
            if (text == null) throw new FormatException("JSON 文本为 null");
            int i = 0;
            JsonValue v = ParseValue(text, ref i);
            SkipWs(text, ref i);
            if (i < text.Length) throw new FormatException("JSON 结尾有多余内容，位置 " + i);
            return v;
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length)
            {
                char c = s[i];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { i++; continue; }
                break;
            }
        }

        private static JsonValue ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("JSON 提前结束");
            char c = s[i];
            switch (c)
            {
                case '{': return ParseObject(s, ref i);
                case '[': return ParseArray(s, ref i);
                case '"': return JsonValue.NewString(ParseString(s, ref i));
                case 't':
                    Expect(s, ref i, "true"); return JsonValue.NewBool(true);
                case 'f':
                    Expect(s, ref i, "false"); return JsonValue.NewBool(false);
                case 'n':
                    Expect(s, ref i, "null"); return JsonValue.NewNull();
                default:
                    return ParseNumber(s, ref i);
            }
        }

        private static void Expect(string s, ref int i, string literal)
        {
            if (i + literal.Length > s.Length || string.CompareOrdinal(s, i, literal, 0, literal.Length) != 0)
                throw new FormatException("位置 " + i + " 处期待 " + literal);
            i += literal.Length;
        }

        private static JsonValue ParseObject(string s, ref int i)
        {
            JsonValue obj = JsonValue.NewObject();
            i++; // {
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return obj; }
            while (true)
            {
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != '"') throw new FormatException("位置 " + i + " 处期待对象键");
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("位置 " + i + " 处期待 ':'");
                i++;
                obj.Members[key] = ParseValue(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("对象未闭合");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return obj; }
                throw new FormatException("位置 " + i + " 处期待 ',' 或 '}'");
            }
        }

        private static JsonValue ParseArray(string s, ref int i)
        {
            JsonValue arr = JsonValue.NewArray();
            i++; // [
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return arr; }
            while (true)
            {
                arr.Items.Add(ParseValue(s, ref i));
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("数组未闭合");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return arr; }
                throw new FormatException("位置 " + i + " 处期待 ',' 或 ']'");
            }
        }

        private static string ParseString(string s, ref int i)
        {
            StringBuilder sb = new StringBuilder();
            i++; // "
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("\\u 转义不完整");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("未知转义 \\" + e);
                }
            }
            throw new FormatException("字符串未闭合");
        }

        private static JsonValue ParseNumber(string s, ref int i)
        {
            int start = i;
            if (i < s.Length && (s[i] == '-' || s[i] == '+')) i++;
            while (i < s.Length)
            {
                char c = s[i];
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { i++; continue; }
                break;
            }
            if (i == start) throw new FormatException("位置 " + start + " 处期待值");
            string token = s.Substring(start, i - start);
            double d;
            if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                throw new FormatException("无法解析数字: " + token);
            return JsonValue.NewNumber(d);
        }
    }
}
