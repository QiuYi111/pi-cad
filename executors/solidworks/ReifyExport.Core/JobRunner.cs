using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

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
        readonly List<WarningInfo> _warnings = new List<WarningInfo>();
        readonly List<string> _extra = new List<string>();
        bool _finished;

        public JobRunner(string jobDir, Job? job, string jobId, IPartBuilder builder, JobLog log)
        {
            _jobDir = jobDir; _job = job; _jobId = jobId; _builder = builder; _log = log;
        }

        /// <summary>Volume change below this fraction of the part volume counts as "feature did nothing".</summary>
        public const double NoOpRelTol = 1e-9;

        public JobResult Run()
        {
            if (_job == null) return Finish(Fail(new ExecException(ErrorCodes.ExecutorFailed, "no job loaded", null, "read_job")));
            bool docOpen = false;
            try
            {
                if (_job.Kind == "assembly") return Finish(RunAssembly(ref docOpen));
                return Finish(RunPart(ref docOpen));
            }
            catch (Exception ex)
            {
                _log.Error(ex.ToString());
                return Finish(Fail(ex));
            }
            finally
            {
                if (docOpen) CloseQuietly();
            }
        }

        void CloseQuietly()
        {
            try { _builder.Close(); } catch (Exception ce) { _log.Warn("close failed: " + ce.Message); }
        }

        // ------------------------------------------------------------------ single part

        JobResult RunPart(ref bool docOpen)
        {
            var job = _job!;
            SetPos(null, "plan");
            var plan = Planner.Build(job.Features);
            AddWarnings(plan.Warnings);
            _log.Info("plan: " + plan.Steps.Count + " feature(s)");

            SetPos(null, "begin");
            _app = _builder.Begin(plan.PartName);
            docOpen = true;
            _log.Info("app: " + _app);

            BuildFeatures(plan, null);

            string native = job.Output.Native;
            SetPos(null, "save");
            _builder.SaveNative(Path.Combine(_jobDir, native));
            string? stepName = null;
            if (job.Check)
            {
                SetPos(null, "export_step");
                stepName = job.Output.CheckStep;
                _builder.ExportStep(Path.Combine(_jobDir, stepName));
            }
            return Success(native, stepName);
        }

        // ------------------------------------------------------------------ assembly

        JobResult RunAssembly(ref bool docOpen)
        {
            var job = _job!;
            SetPos(null, "plan");
            var plan = AssemblyPlanner.Build(job.Assembly!);
            foreach (var p in plan.Parts) AddWarnings(p.Plan.Warnings);
            _log.Info("assembly plan: " + plan.Parts.Count + " part(s), " + plan.Occurrences.Count + " occurrence(s)");

            var partVolume = new Dictionary<string, double>();
            foreach (var part in plan.Parts)
            {
                SetPos(part.Name, "begin");
                _app = _builder.Begin(part.Name);
                docOpen = true;
                double vol = BuildFeatures(part.Plan, part.Name + "/");
                partVolume[part.Ref] = vol;
                SetPos(part.Name, "save");
                _builder.SaveNative(Path.Combine(_jobDir, part.FileName));
                lock (_gate) { _extra.Add(part.FileName); }
                _builder.Close();
                docOpen = false;
                _log.Info("saved part " + part.FileName);
            }
            lock (_gate) { _volumes.Clear(); }   // per-occurrence volumes replace the per-feature ones

            SetPos(null, "begin_assembly");
            _app = _builder.BeginAssembly(plan.Name);
            docOpen = true;
            foreach (var occ in plan.Occurrences)
            {
                SetPos(occ.Name, "add_component");
                var part = plan.Parts.First(x => x.Ref == occ.PartRef);
                _builder.AddComponent(Path.Combine(_jobDir, part.FileName), occ);
                lock (_gate) { _volumes.Add(new FeatureVolume { Name = occ.Name, VolumeMm3 = partVolume[occ.PartRef] }); }
                _log.Info("placed " + occ.Name);
            }

            string native = job.Output.Native;
            SetPos(null, "save");
            _builder.SaveNative(Path.Combine(_jobDir, native));
            string? stepName = null;
            if (job.Check)
            {
                SetPos(null, "export_step");
                stepName = job.Output.CheckStep;
                _builder.ExportStep(Path.Combine(_jobDir, stepName));
            }
            return Success(native, stepName);
        }

        // ------------------------------------------------------------------ feature loop

        /// <summary>Builds all steps of a plan in the open document. Returns the final volume (mm3).</summary>
        double BuildFeatures(Plan plan, string? partPrefix)
        {
            foreach (var pr in plan.Parameters)
            {
                SetPos(pr.Name, "parameter");
                if (!_builder.AddParameter(pr))
                    AddWarning(new WarningInfo { Feature = pr.Name, Field = "parameter", Reason = "could not create the global variable; features keep their values" });
            }

            double prev = 0.0;
            foreach (var step in plan.Steps)
            {
                string fname = step.FeatureName;
                SetPos(fname, "build");
                switch (step)
                {
                    case ExtrudeStep ex:
                        {
                            FaceInfo? face = ResolveSketchFace(ex.Sketch, ex.FeatureName);
                            SetPos(fname, "sketch");
                            if (ex.ReuseSketch) _builder.ReuseSketch(ex.Sketch.Name);
                            else { _builder.BuildSketch(ex.Sketch, face); BindSketch(ex.Sketch, ex.FeatureName); }
                            FaceInfo? upTo = null;
                            if (ex.End == EndCondition.UpToFace)
                                upTo = FaceMatch.Resolve(_builder.GetFaces(), ex.UpToFace!, _builder.DiagonalMm(), ex.FeatureName);
                            SetPos(fname, "extrude");
                            _builder.Extrude(ex, upTo);
                            break;
                        }
                    case HoleStep h:
                        {
                            FaceInfo? face = ResolveSketchFace(h.Sketch, h.FeatureName);
                            SetPos(fname, "hole");
                            _builder.Hole(h, face);
                            break;
                        }
                    case PatternStep pt: SetPos(fname, "pattern"); _builder.Pattern(pt); break;
                    case LinearPatternStep lp: SetPos(fname, "pattern"); _builder.LinearPattern(lp); break;
                    case MirrorStep mi: SetPos(fname, "mirror"); _builder.Mirror(mi); break;
                    case FilletStep fi:
                        {
                            SetPos(fname, "edge_match");
                            var edges = EdgeMatch.ResolveAll(_builder.GetEdges(), fi.Edges, _builder.DiagonalMm(), fi.FeatureName);
                            SetPos(fname, "fillet");
                            _builder.Fillet(fi, edges);
                            break;
                        }
                    case ChamferStep ch:
                        {
                            SetPos(fname, "edge_match");
                            var edges = EdgeMatch.ResolveAll(_builder.GetEdges(), ch.Edges, _builder.DiagonalMm(), ch.FeatureName);
                            SetPos(fname, "chamfer");
                            _builder.Chamfer(ch, edges);
                            break;
                        }
                    default:
                        throw ExecException.Unsupported(step.FeatureName, "internal: unknown plan step " + step.GetType().Name);
                }

                foreach (var b in step.Bindings) Bind(step.FeatureName, b);

                SetPos(step.FeatureName, "volume");
                double vol = _builder.VolumeMm3();
                double eps = Math.Max(Math.Abs(vol), Math.Abs(prev)) * NoOpRelTol + 1e-12;
                double delta = vol - prev;
                bool isCut = (step is ExtrudeStep e2 && e2.Cut) || step is HoleStep;
                bool isPad = step is ExtrudeStep e3 && !e3.Cut;
                if (isPad && !(delta > eps))
                    throw new ExecException(ErrorCodes.ExecutorFailed, "pad did not add material (volume " + prev + " -> " + vol + " mm3)", step.FeatureName, "extrude");
                if (isCut && !(delta < -eps))
                    throw new ExecException(ErrorCodes.ExecutorFailed, "cut removed no material (volume " + prev + " -> " + vol + " mm3); the cut direction convention is UNVERIFIED, see PlanConventions", step.FeatureName, "extrude");
                prev = vol;
                lock (_gate) { _volumes.Add(new FeatureVolume { Name = step.FeatureName, VolumeMm3 = vol }); _built++; }
                _log.Info("built " + step.FeatureName + " (" + step.TypeName + "), volume " + vol + " mm3");
            }

            if (plan.DensityKgM3 != null)
            {
                SetPos(null, "material");
                if (!_builder.SetDensity(plan.DensityKgM3.Value))
                    AddWarning(new WarningInfo { Field = "material", Reason = "density " + plan.DensityKgM3 + " kg/m3 could not be applied in SolidWorks" });
            }
            foreach (var w in _builder.Warnings.ToList()) AddWarning(w);
            _builder.Warnings.Clear();
            return prev;
        }

        FaceInfo? ResolveSketchFace(SketchPlan sk, string feature)
        {
            if (sk.Face == null) return null;
            SetPos(feature, "face_match");
            return FaceMatch.Resolve(_builder.GetFaces(), sk.Face, _builder.DiagonalMm(), feature);
        }

        void BindSketch(SketchPlan sk, string feature)
        {
            foreach (var d in sk.Dimensions)
                if (d.Binding != null) Bind(feature, d.Binding);
        }

        void Bind(string feature, Binding b)
        {
            SetPos(feature, "bind");
            bool ok;
            try { ok = _builder.BindDimension(b.FullName, b.SwExpr); }
            catch (Exception e) { _log.Warn("bind failed: " + e.Message); ok = false; }
            if (!ok)
                AddWarning(new WarningInfo { Feature = feature, Field = b.Field, Expr = b.SwExpr, Reason = "could not bind " + b.FullName + " to an equation; using the value " + b.Value });
        }

        // ------------------------------------------------------------------ result

        void AddWarnings(IEnumerable<WarningInfo> ws) { foreach (var w in ws) AddWarning(w); }
        void AddWarning(WarningInfo w)
        {
            _log.Warn(w.ToString());
            lock (_gate) { _warnings.Add(w); }
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
            Warnings = new List<WarningInfo>(_warnings),
        };

        JobResult Success(string native, string? stepName)
        {
            lock (_gate)
            {
                var r = Base(true);
                r.Files = new ResultFiles { Native = native, CheckStep = stepName, Log = "log.txt", Extra = new List<string>(_extra) };
                return r;
            }
        }

        JobResult Fail(Exception ex)
        {
            lock (_gate)
            {
                var r = Base(false);
                r.Files = new ResultFiles { Native = null, CheckStep = null, Log = "log.txt", Extra = new List<string>(_extra) };
                r.Error = ExecException.Map(ex, _feature, _step);
                return r;
            }
        }
    }
}
