using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;

namespace Reify.Export
{
    public enum CliKind { Version, Check, Job, Invalid }

    public sealed class CliCommand
    {
        public CliKind Kind { get; set; }
        public string? JobDir { get; set; }
        public string? Error { get; set; }
    }

    public static class CliParser
    {
        public static CliCommand Parse(string[] args)
        {
            if (args.Length == 0) return new CliCommand { Kind = CliKind.Invalid, Error = "usage: ReifyExport --version | --check | --job <dir>" };
            if (args[0] == "--version") return new CliCommand { Kind = CliKind.Version };
            if (args[0] == "--check") return new CliCommand { Kind = CliKind.Check };
            if (args[0] == "--job")
            {
                if (args.Length < 2 || string.IsNullOrWhiteSpace(args[1]))
                    return new CliCommand { Kind = CliKind.Invalid, Error = "--job needs a directory" };
                return new CliCommand { Kind = CliKind.Job, JobDir = args[1] };
            }
            return new CliCommand { Kind = CliKind.Invalid, Error = "unknown argument " + args[0] };
        }
    }

    /// <summary>Registry access behind an interface so --check can be faked in tests.</summary>
    public interface ISwProbe
    {
        /// <summary>Is ProgID SldWorks.Application registered (HKCR\SldWorks.Application\CLSID)?</summary>
        bool ProgIdRegistered();
        /// <summary>Sub key names below HKLM\SOFTWARE\SolidWorks (e.g. "SOLIDWORKS 2023", "Applications").</summary>
        IReadOnlyList<string> SolidWorksKeyNames();
    }

    public sealed class CheckReport
    {
        [JsonPropertyName("version")] public string Version { get; set; } = AppInfo.Version;
        [JsonPropertyName("swInstalled")] public bool SwInstalled { get; set; }
        [JsonPropertyName("swVersion")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? SwVersion { get; set; }

        static readonly Regex YearRx = new Regex(@"SOLIDWORKS\s+(\d{4})", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        public static CheckReport Build(ISwProbe probe)
        {
            var rep = new CheckReport();
            int best = 0;
            foreach (var k in probe.SolidWorksKeyNames())
            {
                var m = YearRx.Match(k);
                if (m.Success && int.TryParse(m.Groups[1].Value, out int y) && y > best) best = y;
            }
            rep.SwInstalled = probe.ProgIdRegistered();
            if (best > 0) rep.SwVersion = best.ToString();
            return rep;
        }

        public string ToJson() => JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = false });
    }

    /// <summary>Calls onTimeout once if not disposed within the time. The callback runs on a thread-pool thread.</summary>
    public sealed class Watchdog : IDisposable
    {
        readonly Timer _timer;
        public Watchdog(TimeSpan after, Action onTimeout)
        {
            _timer = new Timer(_ => onTimeout(), null, after, Timeout.InfiniteTimeSpan);
        }
        public void Dispose() => _timer.Dispose();
    }
}
