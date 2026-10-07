using System;
using System.IO;
using System.Threading;

namespace Reify.Export.Sw
{
    internal static class Program
    {
        const string MutexName = @"Global\ReifyExport.SolidWorks";

        // COM objects of SolidWorks are used from this thread only: it must be an STA thread.
        [STAThread]
        static int Main(string[] args)
        {
            var cmd = CliParser.Parse(args);
            switch (cmd.Kind)
            {
                case CliKind.Version:
                    Console.Out.WriteLine(AppInfo.VersionLine);
                    return 0;
                case CliKind.Check:
                    Console.Out.WriteLine(CheckReport.Build(new RegistrySwProbe()).ToJson());
                    return 0;
                case CliKind.Job:
                    return RunJob(cmd.JobDir!);
                default:
                    Console.Error.WriteLine(cmd.Error);
                    return 2;
            }
        }

        static int RunJob(string jobDir)
        {
            jobDir = Path.GetFullPath(jobDir);
            string jobId = Path.GetFileName(jobDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            Directory.CreateDirectory(jobDir);
            using var log = new JobLog(Path.Combine(jobDir, "log.txt"));
            log.Info(AppInfo.VersionLine + " job dir " + jobDir);

            Job? job = null;
            try { job = JobLoader.Load(jobDir); jobId = job.JobId.Length > 0 ? job.JobId : jobId; }
            catch (Exception ex)
            {
                log.Error(ex.ToString());
                var r = new JobResult { JobId = jobId, Ok = false, Error = ExecException.Map(ex, null, "read_job") };
                ResultWriter.Write(jobDir, r);
                return 1;
            }

            int timeoutS = job.TimeoutS > 0 ? job.TimeoutS : 300;
            var builder = new SwPartBuilder(log);
            var runner = new JobRunner(jobDir, job, jobId, builder, log);

            // Serialize jobs (one SolidWorks session, one COM client at a time).
            using var mutex = new Mutex(false, MutexName);
            bool owned = false;
            try
            {
                try { owned = mutex.WaitOne(TimeSpan.FromSeconds(Math.Min(timeoutS, 60))); }
                catch (AbandonedMutexException) { owned = true; log.Warn("previous ReifyExport died holding the mutex"); }
                if (!owned)
                {
                    var busy = new JobResult
                    {
                        JobId = jobId, Ok = false,
                        Error = new ErrorInfo { Code = ErrorCodes.Busy, Message = "another ReifyExport job is running", Step = "lock" },
                    };
                    ResultWriter.Write(jobDir, busy);
                    return 1;
                }

                // The watchdog covers the whole job after the lock was taken. A modal SolidWorks dialog blocks
                // every COM call, so the worker thread cannot be interrupted; the watchdog writes result.json and
                // kills the process. It cannot close the dialog or the open document (documented limit).
                using var dog = new Watchdog(TimeSpan.FromSeconds(timeoutS), () =>
                {
                    var r = runner.TimeoutResult(timeoutS);
                    if (r != null) { try { log.Dispose(); } catch { } Environment.Exit(1); }
                });
                var result = runner.Run();
                return result.Ok ? 0 : 1;
            }
            finally
            {
                if (owned) { try { mutex.ReleaseMutex(); } catch (ApplicationException) { } }
            }
        }
    }
}
