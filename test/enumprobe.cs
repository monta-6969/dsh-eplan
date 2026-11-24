using System;
using System.IO;
using System.Reflection;
internal static class EnumProbe {
  private const string Bin = @"D:\EPLAN\Platform\2.9.4\Bin";
  private static int Main() {
    AppDomain.CurrentDomain.AssemblyResolve += (s,e)=>{ string n=e.Name.Split(',')[0]; string p=Path.Combine(Bin,n+".dll"); return File.Exists(p)?(Assembly)Assembly.LoadFrom(p):null; };
    Assembly dm = Assembly.LoadFrom(Path.Combine(Bin,"Eplan.EplApi.DataModelu.dll"));
    foreach (string name in new string[]{"ConnectionPointSide","Directions","RoutingDirections","ConnectionCategory"}) {
      Type t = dm.GetType("Eplan.EplApi.DataModel."+name);
      Console.WriteLine(name+": "+(t==null?"(not found)":String.Join(", ", Enum.GetNames(t))));
    }
    Type cat = dm.GetType("Eplan.EplApi.DataModel.Function+Enums+Category");
    if (cat!=null) { string[] names=Enum.GetNames(cat); Console.WriteLine("Function.Category count="+names.Length); for(int i=0;i<names.Length && i<12;i++) Console.WriteLine("   "+names[i]); }
    return 0;
  }
}
