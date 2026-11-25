using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace EplanMcp
{
    /// <summary>
    /// 把 EPLAN 的「打印配色」改成用户屏幕上的深色配色。
    ///
    /// EPLAN 的 GraphicPageEx / GraphicProjectEx 没有配色方案参数，导出永远是
    /// 白底 + 蓝色符号 + 红色连接 + 黑色图框；而用户开着深色显示时看到的是
    /// 黑底 + 黄色符号 + 红色连接 + 浅色图框。颜色在原理图里有含义，两种配色
    /// 混着看会误读，所以渲染完按像素重新上色。
    ///
    /// 映射规则（导出图里的墨色 → 深色墨色，背景由白变黑）：
    ///   灰色墨（图框、标题栏、栅格）→ 白色
    ///   蓝色墨（符号、文字）        → 黄色
    ///   红色墨（连接线）            → 红色（不变）
    /// 抗锯齿像素按「离白多远」算覆盖度，再按覆盖度混到黑底上。
    /// </summary>
    internal static class DarkScheme
    {
        public static void Apply(string path)
        {
            byte[] bytes = File.ReadAllBytes(path);
            using (MemoryStream stream = new MemoryStream(bytes))
            using (Bitmap source = new Bitmap(stream))
            using (Bitmap target = new Bitmap(source.Width, source.Height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(target))
                {
                    graphics.DrawImage(source, 0, 0, source.Width, source.Height);
                }

                Rectangle rect = new Rectangle(0, 0, target.Width, target.Height);
                BitmapData data = target.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format24bppRgb);
                try
                {
                    int stride = data.Stride;
                    byte[] row = new byte[stride];
                    for (int y = 0; y < target.Height; y++)
                    {
                        IntPtr line = new IntPtr(data.Scan0.ToInt64() + (long)y * stride);
                        System.Runtime.InteropServices.Marshal.Copy(line, row, 0, stride);
                        for (int x = 0; x < target.Width; x++)
                        {
                            int b = row[x * 3];
                            int g = row[x * 3 + 1];
                            int r = row[x * 3 + 2];
                            int low = Math.Min(r, Math.Min(g, b));
                            int high = Math.Max(r, Math.Max(g, b));
                            int coverage = 255 - low; // 0 = 纯白纸面，255 = 全墨
                            int outR, outG, outB;
                            if (high - low < 12)
                            {
                                // 灰色墨 → 白色
                                outR = outG = outB = coverage;
                            }
                            else if (r >= 180 && g >= 180 && b < 120)
                            {
                                // 黄色墨（黑箱框、器件图形）→ 保持黄色。
                                // 必须排在红色判断前面：黄色的 r 也最大，掉进红色分支会变红。
                                outR = coverage;
                                outG = coverage;
                                outB = 0;
                            }
                            else if (b >= r && b >= g && b - Math.Min(r, g) >= 30)
                            {
                                // 蓝色墨 → 黄色
                                outR = coverage;
                                outG = coverage;
                                outB = 0;
                            }
                            else if (r >= g && r >= b && r - Math.Min(g, b) >= 30)
                            {
                                // 红色墨 → 红色
                                outR = coverage;
                                outG = 0;
                                outB = 0;
                            }
                            else if (g >= 180 && r < 120 && b < 120)
                            {
                                // 绿色墨（连接点代号等）→ 保持绿色。
                                outR = 0;
                                outG = coverage;
                                outB = 0;
                            }
                            else
                            {
                                // 认不出的颜色（多色叠加的抗锯齿）按浅灰处理，不丢笔画。
                                int v = coverage * 200 / 255;
                                outR = outG = outB = v;
                            }
                            row[x * 3] = (byte)outB;
                            row[x * 3 + 1] = (byte)outG;
                            row[x * 3 + 2] = (byte)outR;
                        }
                        System.Runtime.InteropServices.Marshal.Copy(row, 0, line, stride);
                    }
                }
                finally
                {
                    target.UnlockBits(data);
                }

                target.Save(path, ImageFormat.Png);
            }
        }
    }
}
