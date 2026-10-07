using System;
using System.Runtime.InteropServices;

namespace Reify.Export.SolidWorks
{
    /// <summary>Marshal.GetActiveObject does not exist on .NET (Core) 5+, so call the OLE function directly.</summary>
    internal static class ComHelper
    {
        [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
        static extern int CLSIDFromProgID(string progId, out Guid clsid);

        [DllImport("oleaut32.dll")]
        static extern int GetActiveObject(ref Guid rclsid, IntPtr reserved, [MarshalAs(UnmanagedType.IUnknown)] out object? ppunk);

        /// <summary>Running instance registered in the ROT, or null.</summary>
        public static object? TryGetActiveObject(string progId)
        {
            if (CLSIDFromProgID(progId, out Guid clsid) != 0) return null;
            if (GetActiveObject(ref clsid, IntPtr.Zero, out object? obj) != 0) return null;
            return obj;
        }
    }
}
