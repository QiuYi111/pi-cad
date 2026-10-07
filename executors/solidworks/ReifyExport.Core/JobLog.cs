using System;
using System.IO;

namespace Reify.Export
{
    /// <summary>Line log, flushed on every write so a hard kill (watchdog, crash) loses nothing.</summary>
    public sealed class JobLog : IDisposable
    {
        readonly object _gate = new object();
        readonly TextWriter? _w;
        public JobLog(string? path)
        {
            if (path != null)
            {
                try { _w = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true }; }
                catch (IOException) { _w = null; }
                catch (UnauthorizedAccessException) { _w = null; }
            }
        }
        public void Info(string msg) => Write("INFO", msg);
        public void Warn(string msg) => Write("WARN", msg);
        public void Error(string msg) => Write("ERROR", msg);
        void Write(string level, string msg)
        {
            lock (_gate)
            {
                try { _w?.WriteLine(DateTime.UtcNow.ToString("O") + " " + level + " " + msg); } catch (IOException) { }
            }
        }
        public void Dispose() { lock (_gate) { _w?.Dispose(); } }
    }
}
