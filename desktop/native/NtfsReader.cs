using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class NtfsReader
{
    private const uint EnumUsn = 0x900b3, ReadUsn = 0x900bb, QueryUsn = 0x900f4;
    private const uint OpenExisting = 3, ShareAll = 7, GenericRead = 0x80000000;
    private const uint OpenDirectory = 0x02000000, OpenReparsePoint = 0x00200000;
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private static readonly Encoding Wire = new UTF8Encoding(false, true);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileId
    {
        public uint Size;
        public int Type;
        public ulong Low, High;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle OpenFileById(SafeFileHandle volume, ref FileId id, uint access,
        uint share, IntPtr security, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeNameForVolumeMountPoint(string root, StringBuilder name, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(SafeFileHandle volume, uint code, byte[] input, int inputLength,
        byte[] output, int outputLength, out int returned, IntPtr overlapped);

    private static string Number(ulong n) { return n.ToString(Invariant); }
    private static string Encoded(string value) { return Convert.ToBase64String(Encoding.Unicode.GetBytes(value)); }

    private static int Control(SafeFileHandle volume, uint code, byte[] input, byte[] result)
    {
        int length;
        if (!DeviceIoControl(volume, code, input, input == null ? 0 : input.Length,
                result, result.Length, out length, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return length;
    }

    private static bool Listable(string path, string root, Dictionary<string, bool> checkedPaths)
    {
        bool allowed;
        if (checkedPaths.TryGetValue(path, out allowed)) return allowed;
        var uncheckedPaths = new List<string>();
        string current = path;
        while (!checkedPaths.TryGetValue(current, out allowed))
        {
            uncheckedPaths.Add(current);
            try
            {
                using (var handle = CreateFile(@"\\?\" + current, 1, ShareAll, IntPtr.Zero, OpenExisting,
                        OpenDirectory | OpenReparsePoint, IntPtr.Zero))
                {
                    if (handle.IsInvalid || (File.GetAttributes(current) & (FileAttributes.Directory | FileAttributes.ReparsePoint))
                        != FileAttributes.Directory) break;
                }
            }
            catch (IOException) { break; }
            catch (UnauthorizedAccessException) { break; }
            if (String.Equals(current, root, StringComparison.OrdinalIgnoreCase)) { allowed = true; break; }
            int split = current.LastIndexOf('\\');
            current = split < root.Length ? root : current.Substring(0, split);
        }
        foreach (string checkedPath in uncheckedPaths) checkedPaths[checkedPath] = allowed;
        return allowed;
    }

    private static string ParentPath(NamedPipeServerStream pipe, SafeFileHandle volume, ulong reference, string root,
        Dictionary<string, bool> checkedPaths)
    {
        string resolved = null;
        pipe.RunAsClient(delegate {
            var id = new FileId { Size = 24, Type = 0, Low = reference };
            // Test the ordinary user's directory-listing permission before returning names.
            using (var handle = OpenFileById(volume, ref id, 1, ShareAll, IntPtr.Zero, OpenDirectory | OpenReparsePoint))
            {
                if (handle.IsInvalid) return;
                var candidate = new StringBuilder(512);
                uint length = GetFinalPathNameByHandle(handle, candidate, (uint)candidate.Capacity, 0);
                if (length >= candidate.Capacity && length < 32768)
                {
                    candidate = new StringBuilder((int)length + 1);
                    length = GetFinalPathNameByHandle(handle, candidate, (uint)candidate.Capacity, 0);
                }
                if (length == 0 || length >= candidate.Capacity) return;
                string path = candidate.ToString();
                if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path.Substring(4);
                if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return;
                if (Listable(path, root, checkedPaths)) resolved = path;
            }
        });
        return resolved;
    }

    private static void Request(string line, TextWriter writer, NamedPipeServerStream pipe)
    {
        string[] args = line.Split('\t');
        if (args.Length < 2 || args[1].Length != 1 || args[1][0] < 'A' || args[1][0] > 'Z')
            throw new InvalidDataException("Invalid drive.");
        string root = args[1] + @":\";
        var drive = new DriveInfo(root);
        if (drive.DriveType != DriveType.Fixed || !drive.IsReady || drive.DriveFormat != "NTFS")
            throw new Win32Exception(50);
        var volumeName = new StringBuilder(64);
        if (!GetVolumeNameForVolumeMountPoint(root, volumeName, (uint)volumeName.Capacity))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        using (var volume = CreateFile(volumeName.ToString().TrimEnd('\\'), GenericRead, ShareAll, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero))
        {
            if (volume.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var journal = new byte[80];
            if (Control(volume, QueryUsn, null, journal) < 32) throw new InvalidDataException("Invalid journal.");
            ulong id = BitConverter.ToUInt64(journal, 0);
            long first = Math.Max(BitConverter.ToInt64(journal, 8), BitConverter.ToInt64(journal, 24));
            long next = BitConverter.ToInt64(journal, 16);
            if (args[0] == "probe" && args.Length == 2)
            {
                writer.WriteLine("V\t" + volumeName + "\t" + Number(id) + "\t" + first.ToString(Invariant) + "\t" + next.ToString(Invariant));
                return;
            }
            if (args.Length != 5 || !String.Equals(args[2], volumeName.ToString(), StringComparison.OrdinalIgnoreCase)
                || args[3] != Number(id)) throw new Win32Exception(1178);
            ulong cursor = UInt64.Parse(args[4], NumberStyles.None, Invariant);
            bool snapshot = args[0] == "enum";
            if (!snapshot && (args[0] != "read" || cursor < (ulong)first || cursor > (ulong)next))
                throw new Win32Exception(1181);
            var input = new byte[snapshot ? 24 : 48];
            Buffer.BlockCopy(BitConverter.GetBytes(cursor), 0, input, 0, 8);
            if (snapshot) Buffer.BlockCopy(BitConverter.GetBytes(Int64.MaxValue), 0, input, 16, 8);
            else
            {
                Buffer.BlockCopy(BitConverter.GetBytes(0xffffffffU), 0, input, 8, 4);
                Buffer.BlockCopy(BitConverter.GetBytes(id), 0, input, 32, 8);
                input[40] = input[42] = 2;
            }
            var result = new byte[256 * 1024];
            int bytes;
            try { bytes = Control(volume, snapshot ? EnumUsn : ReadUsn, input, result); }
            catch (Win32Exception error) {
                if (!snapshot || error.NativeErrorCode != 38) throw;
                writer.WriteLine("END");
                return;
            }
            if (bytes < 8) throw new InvalidDataException("Invalid records.");
            var parents = new Dictionary<ulong, string>();
            var checkedPaths = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            for (int offset = 8; offset < bytes;)
            {
                if (bytes - offset < 60) throw new InvalidDataException("Incomplete USN record.");
                int length = BitConverter.ToInt32(result, offset);
                if (length < 60 || length > bytes - offset || BitConverter.ToUInt16(result, offset + 4) != 2)
                    throw new InvalidDataException("Unsupported USN record.");
                ulong file = BitConverter.ToUInt64(result, offset + 8);
                ulong parent = BitConverter.ToUInt64(result, offset + 16);
                uint reason = BitConverter.ToUInt32(result, offset + 40);
                uint attributes = BitConverter.ToUInt32(result, offset + 52);
                int nameLength = BitConverter.ToUInt16(result, offset + 56);
                int nameOffset = BitConverter.ToUInt16(result, offset + 58);
                if (nameOffset < 60 || nameLength % 2 != 0 || nameOffset + nameLength > length)
                    throw new InvalidDataException("Invalid NTFS name.");
                string name = Encoding.Unicode.GetString(result, offset + nameOffset, nameLength);
                offset += length;
                if ((file & 0x0000ffffffffffffUL) < 24 || name == "." || name == ".." || name.Length == 0
                    || name.IndexOfAny(new[] { '\0', ':', '\\', '/' }) >= 0) continue;
                string directory;
                if (!parents.TryGetValue(parent, out directory))
                {
                    directory = (attributes & 1024U) != 0 ? null : ParentPath(pipe, volume, parent, root, checkedPaths);
                    // A reparse point is excluded without restricting other entries in its parent.
                    if ((attributes & 1024U) == 0) parents[parent] = directory;
                }
                if ((attributes & 1024U) != 0) directory = null;
                if (directory == null && snapshot) continue;
                writer.WriteLine("R\t" + Number(file) + "\t" + Number(parent) + "\t" + reason.ToString(Invariant)
                    + "\t" + attributes.ToString(Invariant) + "\t" + (directory == null ? "" : Encoded(directory))
                    + "\t" + (directory == null ? "" : Encoded(name)));
            }
            writer.WriteLine("NEXT\t" + Number(BitConverter.ToUInt64(result, 0)));
        }
    }

    private static string PipeName(string value)
    {
        Guid id;
        if (!Guid.TryParseExact(value, "D", out id)) throw new InvalidDataException("Invalid session.");
        return "FileRecall-Ntfs-" + id.ToString("D");
    }

    private static void Serve(string session)
    {
        var acl = new PipeSecurity();
        acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        using (var pipe = new NamedPipeServerStream(PipeName(session), PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 65536, acl))
        {
            var waiting = pipe.BeginWaitForConnection(null, null);
            using (var ready = waiting.AsyncWaitHandle)
            {
                if (!ready.WaitOne(60000)) return;
                pipe.EndWaitForConnection(waiting);
            }
            using (var input = new StreamReader(pipe, Wire, false, 4096, true))
            using (var output = new StreamWriter(pipe, Wire, 65536, true))
            {
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    try { Request(line, output, pipe); }
                    catch (Win32Exception error) { output.WriteLine("ERR\t" + error.NativeErrorCode.ToString(Invariant)); }
                    catch (IOException) { output.WriteLine("ERR\t13"); }
                    catch (UnauthorizedAccessException) { output.WriteLine("ERR\t5"); }
                    catch (FormatException) { output.WriteLine("ERR\t87"); }
                    catch (OverflowException) { output.WriteLine("ERR\t87"); }
                    output.WriteLine(".");
                    output.Flush();
                }
            }
        }
    }

    private static void Proxy(string session)
    {
        using (var pipe = new NamedPipeClientStream(".", PipeName(session), PipeDirection.InOut,
                PipeOptions.None, TokenImpersonationLevel.Impersonation))
        {
            pipe.Connect(60000);
            Console.WriteLine("READY");
            using (var input = new StreamReader(pipe, Wire, false, 65536, true))
            using (var output = new StreamWriter(pipe, Wire, 4096, true) { AutoFlush = true })
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    output.WriteLine(line);
                    string reply;
                    do {
                        reply = input.ReadLine();
                        if (reply == null) return;
                        Console.WriteLine(reply);
                    } while (reply != ".");
                }
            }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) return 2;
            if (args[0] == "serve") Serve(args[1]);
            else if (args[0] == "proxy") Proxy(args[1]);
            else if (args[0] == "probe") Request("probe\t" + args[1], Console.Out, null);
            else return 2;
            return 0;
        }
        catch (Win32Exception error) { Console.Error.WriteLine(error.NativeErrorCode); }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().Name); }
        return 1;
    }
}
