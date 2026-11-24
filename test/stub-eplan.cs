// 离线测试用的最小替身：真实 HostException 在 host/src/Context.cs 里，
// 但那个文件引用了 EPLAN 的 DataModel，为了在没有 EPLAN 的机器上也能测
// 知识库逻辑，这里只补一个同名的壳子。
using System;

namespace EplanMcp
{
    public class HostException : Exception
    {
        public string Code;
        public string Detail;

        public HostException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public HostException(string code, string message, string detail)
            : base(message)
        {
            Code = code;
            Detail = detail;
        }
    }
}
