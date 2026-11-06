// Isolated console-subsystem executable. Never discovers or stops host processes.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ConsoleInheritanceFixture {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    static string Info() {
        var window = GetConsoleWindow();
        var name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        return "{\"pid\":" + Process.GetCurrentProcess().Id + ",\"window\":" + window.ToInt64() + ",\"windowClass\":\"" + name + "\",\"visible\":" + IsWindowVisible(window).ToString().ToLowerInvariant() + "}";
    }
    public static int Main(string[] args) {
        if (args.Length < 2) return 2;
        if (args[0] == "child") {
            File.WriteAllText(Path.Combine(args[1], "child.json"), Info());
            Console.WriteLine("stdio-roundtrip-ok");
            return 0;
        }
        if (args[0] != "parent" || args.Length != 4) return 3;
        var psi = new ProcessStartInfo {
            FileName = args[2],
            Arguments = "\"" + args[3] + "\" \"" + Process.GetCurrentProcess().MainModule.FileName + "\" \"" + args[1] + "\"",
            UseShellExecute = false,
            CreateNoWindow = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var child = Process.Start(psi)) {
            child.StandardInput.Close();
            var output = child.StandardOutput.ReadToEnd();
            var error = child.StandardError.ReadToEnd();
            child.WaitForExit();
            File.WriteAllText(Path.Combine(args[1], "stdio.txt"), output);
            File.WriteAllText(Path.Combine(args[1], "parent.json"), Info());
            if (child.ExitCode != 0 || error.Length != 0 || output.Trim() != "stdio-roundtrip-ok") return 4;
        }
        // Keep the audited parent alive until the test signals it. A bounded
        // lifetime also prevents leaked fixtures when assertions fail.
        for (int i = 0; i < 400 && !File.Exists(Path.Combine(args[1], "exit-now")); i++) Thread.Sleep(25);
        return 0;
    }
}
