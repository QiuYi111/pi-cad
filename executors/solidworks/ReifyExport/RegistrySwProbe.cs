using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace Reify.Export.Sw
{
    /// <summary>Real registry probe for --check. UNVERIFIED: key layout HKLM\SOFTWARE\SolidWorks\SOLIDWORKS 20xx.</summary>
    internal sealed class RegistrySwProbe : ISwProbe
    {
        public bool ProgIdRegistered()
        {
            try
            {
                using var k = Registry.ClassesRoot.OpenSubKey(@"SldWorks.Application\CLSID");
                return k != null;
            }
            catch (Exception) { return false; }
        }

        public IReadOnlyList<string> SolidWorksKeyNames()
        {
            try
            {
                using var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\SolidWorks");
                return k == null ? Array.Empty<string>() : k.GetSubKeyNames();
            }
            catch (Exception) { return Array.Empty<string>(); }
        }
    }
}
