using System;
using System.Collections.Generic;
using System.IO;

namespace Reify.Export
{
    /// <summary>Runs a planned job against an IPartBuilder and owns the result. Thread-safe enough for the watchdog to call TimeoutResult.</summary>
    public sealed class JobRunner
    {
        readonly string _jobDir;
        readonly string _jobId;
        readonly Job? _job;
        readonly IPartBuilder _builder;
        readonly JobLog _log;
        readonly object _gate = new object();

        string? _app;
        string? _feature;
        string? _step;
        int _built;
        readonly List<FeatureVolume> _volumes = new List<FeatureVolume>();
        bool _finished;

        public JobRunner(string jobDir, Job? job, string jobId, IPartBuilder builder, JobLog log)
        {
            _jobDir = jobDir; _job = job; _jobId = jobId; _builder = builder; _log = log;
        }

        /// <summary>Volume change below this fraction of the part volume (or this absolute mm^3 when empty) counts as "feature did nothing".</summary>
        public const double NoOpRelTol = 1e-9;

        public JobResult Run()
        {
            if (_job == null) return Finish(Fail(new ExecException(ErrorCodes.ExecutorFailed, "no job loaded", null, "read_job")));
            bool begun = false;
            try
            {
                SetPos(null, "plan");
                var plan = Planner.Build(_job.Features);
                foreach (var w in plan.Warnings) _log.Warn(w);
                _log.Info("plan: " + plan.Steps.Count + " feature(s)");

                SetPos(null, "begin");
                _app = _builder.Begin(plan.PartName);
                begun = true;
                _log.Info("app: " + _app);

                double prev = 0.0;
                foreach (var step in plan.Steps)
                {
                    if (step is ExtrudeStep ex)
                    {
                        SetPos(ex.FeatureName, "sketch");
                        if (ex.ReuseSketch) _builder.ReuseSketch(ex.Sketch.Name); else _builder.BuildSketch(ex.Sketch);
                        SetPos(ex.FeatureName, "extrude");
                        _builder.Extrude(ex);
                    }
                    else if (step is PatternStep pt)
                    {
                        SetPos(pt.FeatureName, "pattern");
                        _builder.Pattern(pt);
                    }
                    SetPos(step.FeatureName, "volume");
                    double vol = _builder.VolumeMm3();
                    double eps = Math.Max(Math.Abs(vol), Math.Abs(prev)) * NoOpRelTol + 1e-12;
                    if (step is ExtrudeStep e2)
                    {
                        double delta = vol - prev;
                        if (!e2.Cut && !(delta > eps))
                            throw new ExecException(ErrorCodes.ExecutorFailed, "pad did not add material (volume " + prev + " -> " + vol + " mm3)", step.FeatureName, "extrude");
                        if (e2.Cut && !(delta < -eps))
                            throw new ExecException(ErrorCodes.ExecutorFailed, "cut removed no material (volume " + prev + " -> " + vol + " mm3); the cut direction convention is UNVERIFIED, see PlanConventions", step.FeatureName, "extrude");
                    }
                    prev = vol;
                    lock (_gate) { _volumes.Add(new FeatureVolume { Name = step.FeatureName, VolumeMm3 = vol }); _built++; }
                    _log.Info("built " + step.FeatureName + " (" + step.TypeName + "), volume " + vol + " mm3");
                }

                string native = _job.Output.Native;
                SetPos(null, "save");
                _builder.SaveNative(Path.Combine(_jobDir, native));
                string? stepName = null;
                if (_job.Check)
                {
                    SetPos(null, "export_step");
                    stepName = _job.Output.CheckStep;
                    _builder.ExportStep(Path.Combine(_jobDir, stepName));
                }
                return Finish(Success(native, stepName));
            }
            catch (Exception ex)
            {
                _log.Error(ex.ToString());
                return Finish(Fail(ex));
            }
            finally
            {
                if (begun)
                {
                    try { _builder.Close(); } catch (Exception ce) { _log.Warn("close failed: " + ce.Message); }
                }
            }
        }

        JobResult Finish(JobResult r)
        {
            lock (_gate)
            {
                if (_finished) return r;
                _finished = true;
                ResultWriter.Write(_jobDir, r);
            }
            return r;
        }

        /// <summary>Called from the watchdog thread. Writes result.json unless the job already finished.</summary>
        public JobResult? TimeoutResult(int timeoutS)
        {
            JobResult r;
            lock (_gate)
            {
                if (_finished) return null;
                r = Fail(new ExecException(ErrorCodes.ExecutorFailed, "timeout after " + timeoutS + " s", _feature, _step));
                _finished = true;
                ResultWriter.Write(_jobDir, r);
            }
            _log.Error("timeout after " + timeoutS + " s at feature=" + _feature + " step=" + _step);
            return r;
        }

        void SetPos(string? feature, string step) { lock (_gate) { _feature = feature; _step = step; } }

        JobResult Base(bool ok) => new JobResult
        {
            JobId = _jobId,
            Ok = ok,
            Executor = new ExecutorInfo { App = _app },
            FeaturesBuilt = _built,
            FeatureVolumes = new List<FeatureVolume>(_volumes),
        };

        JobResult Success(string native, string? stepName)
        {
            lock (_gate)
            {
                var r = Base(true);
                r.Files = new ResultFiles { Native = native, CheckStep = stepName, Log = "log.txt" };
                return r;
            }
        }

        JobResult Fail(Exception ex)
        {
            lock (_gate)
            {
                var r = Base(false);
                r.Files = new ResultFiles { Native = null, CheckStep = null, Log = "log.txt" };
                r.Error = ExecException.Map(ex, _feature, _step);
                return r;
            }
        }
    }
}
