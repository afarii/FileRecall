using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

internal static class HostLauncher
{
    private static int Main()
    {
        try
        {
            // Process creates a StreamWriter for child stdin. Suppress its UTF-8 BOM.
            Console.InputEncoding = new UTF8Encoding(false);
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string node = File.ReadAllText(Path.Combine(folder, "node-path.txt")).Trim();
            string host = Path.GetFullPath(Path.Combine(folder, "..", "electron", "native-host.cjs"));
            var start = new ProcessStartInfo(node, "\"" + host + "\"") {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            byte[] message;
            using (var input = new BinaryReader(Console.OpenStandardInput()))
            {
                int length = input.ReadInt32();
                if (length < 1 || length > 4 * 1024 * 1024) return 1;
                message = input.ReadBytes(length);
                if (message.Length != length) return 1;
            }
            using (var child = Process.Start(start))
            {
                Task output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task errors = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                var destination = child.StandardInput.BaseStream;
                destination.Write(BitConverter.GetBytes(message.Length), 0, 4);
                destination.Write(message, 0, message.Length);
                destination.Flush();
                child.StandardInput.Close();
                Task.WaitAll(output, errors);
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
