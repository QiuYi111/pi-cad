using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace Reify.Export.Tests
{
    public class ParsingTests
    {
        [Fact]
        public void ParsesSampleFeatureFile()
        {
            var f = JsonSerializer.Deserialize<FeatureFile>(Samples.Features, JsonDefaults.Read)!;
            Assert.Equal("reify.features/1", f.Schema);
            Assert.Single(f.Bodies);
            var b = f.Bodies[0];
            Assert.Equal(2, b.Sketches.Count);
            Assert.Equal(3, b.Features.Count);
            Assert.Equal(5.0, b.Features[0].Extent!.Length!.Value);
            Assert.Equal("=thickness", b.Features[0].Extent!.Length!.Expr);
            Assert.Equal(2.0, b.Sketches[0].Geometry[4].Radius!.Value);
            Assert.Equal(4, b.Features[2].Occurrences);
            Assert.True(b.Features[2].FullCircle);
        }

        [Fact]
        public void BareNumberDimensionIsAccepted()
        {
            var g = JsonSerializer.Deserialize<GeometryDef>(@"{""id"":1,""type"":""circle"",""center"":[0,0],""radius"":4.5}", JsonDefaults.Read)!;
            Assert.Equal(4.5, g.Radius!.Value);
        }

        [Fact]
        public void JobParsesAndChecksSchemaAndTarget()
        {
            var job = JobLoader.Parse(Samples.Job(Samples.Features));
            Assert.Equal("20261007-abc123", job.JobId);
            Assert.Equal("check.step", job.Output.CheckStep);
            Assert.Equal(300, job.TimeoutS);
            var bad = Assert.Throws<ExecException>(() => JobLoader.Parse(Samples.Job(Samples.Features).Replace("\"solidworks\"", "\"fusion\"")));
            Assert.Equal(ErrorCodes.ExecutorFailed, bad.Code);
        }
    }

    public class UnitTests
    {
        [Fact]
        public void MmToMeters() { Assert.Equal(0.0125, Units.MmToM(12.5), 12); }
        [Fact]
        public void VolumeMm3FromM3() { Assert.Equal(6000.0, Units.M3ToMm3(6e-6), 6); }
        [Fact]
        public void DegToRad() { Assert.Equal(Math.PI, Units.DegToRad(180), 12); }
    }

    public class PlanTests
    {
        static FeatureFile Sample() => JsonSerializer.Deserialize<FeatureFile>(Samples.Features, JsonDefaults.Read)!;

        [Fact]
        public void StepsFollowDocumentOrder()
        {
            var plan = Planner.Build(Sample());
            Assert.Equal(new[] { "bracket/base", "bracket/holes", "bracket/ring" }, plan.Steps.Select(s => s.FeatureName).ToArray());
            Assert.IsType<ExtrudeStep>(plan.Steps[0]);
            Assert.IsType<PatternStep>(plan.Steps[2]);
        }

        [Fact]
        public void PadGeometryIsInMetersAndPlaneIsFront()
        {
            var ex = (ExtrudeStep)Planner.Build(Sample()).Steps[0];
            Assert.False(ex.Cut);
            Assert.Equal(0.005, ex.DepthM, 12);
            Assert.Equal(SwBasePlane.Front, ex.Sketch.Plane);
            Assert.Equal(0, PlaneMap.TypeOrderIndex(ex.Sketch.Plane));
            Assert.Equal(0.0, ex.Sketch.OffsetM);
            Assert.False(ex.Reverse);            // +Z pad on Front plane (+Z normal)
            Assert.Equal(0.04, ex.Sketch.Geometry[0].End[0], 12);
            var arc = ex.Sketch.Geometry[4];
            Assert.Equal(GeomKind.Arc, arc.Kind);
            Assert.Equal(0.022, arc.Start[0], 12);
        }

        [Fact]
        public void HoleIsThroughAllCutAndReversedPerConvention()
        {
            var ex = (ExtrudeStep)Planner.Build(Sample()).Steps[1];
            Assert.True(ex.Cut);
            Assert.Equal(EndCondition.ThroughAll, ex.End);
            Assert.Equal(0.005, ex.Sketch.OffsetM, 12);   // sketch plane at z = +5 mm
            // cut removes toward -Z and the convention says cuts default to -normal => no reverse
            Assert.False(ex.Reverse);
        }

        [Fact]
        public void PatternUsesAxisZAndEqualSpacing()
        {
            var p = (PatternStep)Planner.Build(Sample()).Steps[2];
            Assert.Equal(2, p.AxisIndex);
            Assert.True(p.EqualSpacing);
            Assert.Equal(4, p.Count);
            Assert.Equal(2 * Math.PI, p.SpacingRad, 12);
            Assert.False(p.FlipDirection);
        }

        [Fact]
        public void ReverseDecision()
        {
            var nz = new double[] { 0, 0, 1 };
            Assert.True(Planner.DecideReverse(false, EndCondition.Blind, new double[] { 0, 0, -1 }, nz, "f"));
            Assert.False(Planner.DecideReverse(false, EndCondition.Blind, new double[] { 0, 0, 1 }, nz, "f"));
            Assert.True(Planner.DecideReverse(true, EndCondition.Blind, new double[] { 0, 0, 1 }, nz, "f"));
            Assert.False(Planner.DecideReverse(false, EndCondition.MidPlane, new double[] { 0, 0, -1 }, nz, "f"));
            var e = Assert.Throws<ExecException>(() => Planner.DecideReverse(false, EndCondition.Blind, new double[] { 1, 0, 1 }, nz, "oblique"));
            Assert.Equal(ErrorCodes.UnsupportedOp, e.Code);
        }

        [Fact]
        public void UnsupportedFeatureTypeNamesTheFeature()
        {
            var f = Sample();
            f.Bodies[0].Features[1].Type = "fillet";
            var e = Assert.Throws<ExecException>(() => Planner.Build(f));
            Assert.Equal(ErrorCodes.UnsupportedOp, e.Code);
            Assert.Equal("bracket/holes", e.Feature);
        }

        [Fact]
        public void UnsupportedGeometryAndDeepNestingAreRejected()
        {
            var f = Sample();
            f.Bodies[0].Sketches[0].Geometry[0].Type = "bspline";
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(f)).Code);

            var g = Sample();
            g.Bodies[0].Sketches[0].Loops.Add(new LoopDef { Id = 9, Closed = true, Depth = 2 });
            var e = Assert.Throws<ExecException>(() => Planner.Build(g));
            Assert.Equal(ErrorCodes.UnsupportedOp, e.Code);
            Assert.Equal("bracket/base", e.Feature);
        }

        [Fact]
        public void PatternAxisOffOriginIsRejected()
        {
            var f = Sample();
            f.Bodies[0].Features[2].Axis!.Origin = new double[] { 5, 0, 0 };
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(f)).Code);
        }

        [Fact]
        public void SharedSketchIsReusedOnSecondUse()
        {
            var f = Sample();
            f.Bodies[0].Features.Insert(1, new FeatureDef
            {
                Name = "bracket/second", Type = "pad", Sketch = "bracket/base_profile", Direction = new double[] { 0, 0, 1 },
                Extent = new ExtentDef { Type = "length", Length = new Dim { Value = 1 } },
            });
            var steps = Planner.Build(f).Steps.OfType<ExtrudeStep>().ToList();
            Assert.False(steps[0].ReuseSketch);
            Assert.True(steps[1].ReuseSketch);
        }
    }

    public class SketchMathTests
    {
        [Fact]
        public void WorldPointFromFrame()
        {
            var fr = new FrameDef { Origin = new double[] { 0, 0, 5 }, U = new double[] { 1, 0, 0 }, V = new double[] { 0, 1, 0 }, N = new double[] { 0, 0, 1 } };
            var w = SketchMath.ToWorldM(fr, 10, 20);
            Assert.Equal(new[] { 0.010, 0.020, 0.005 }, w.Select(x => Math.Round(x, 12)).ToArray());
        }

        [Fact]
        public void ExpectedSketchCoordsPerPlane()
        {
            var p = new[] { 1.0, 2.0, 3.0 };
            Assert.Equal(new[] { 1.0, 2.0, 3.0 }, SketchMath.ExpectedSketchCoords(SwBasePlane.Front, p));
            Assert.Equal(new[] { 1.0, -3.0, 2.0 }, SketchMath.ExpectedSketchCoords(SwBasePlane.Top, p));
            Assert.Equal(new[] { -3.0, 2.0, 1.0 }, SketchMath.ExpectedSketchCoords(SwBasePlane.Right, p));
        }

        [Fact]
        public void ArcDirectionFlipsOnMirroredFrame()
        {
            Assert.Equal((short)1, SketchMath.ArcDirection(1, 0, 0, 1));
            Assert.Equal((short)-1, SketchMath.ArcDirection(1, 0, 0, -1));
        }

        [Fact]
        public void OnPlaneCheck()
        {
            Assert.True(SketchMath.IsOnSketchPlane(new[] { 1.0, 1.0, 1e-9 }));
            Assert.False(SketchMath.IsOnSketchPlane(new[] { 1.0, 1.0, 1e-3 }));
        }
    }

    public class FakeBuilder : IPartBuilder
    {
        public List<string> Calls = new List<string>();
        public string? FailOn;
        double _vol;
        public string Begin(string n) { Calls.Add("begin"); return "FAKE 1.0"; }
        public void BuildSketch(SketchPlan s) { Calls.Add("sketch:" + s.Name); }
        public void ReuseSketch(string n) { Calls.Add("reuse:" + n); }
        public void Extrude(ExtrudeStep s)
        {
            Calls.Add("extrude:" + s.FeatureName);
            if (FailOn == s.FeatureName) throw new InvalidOperationException("boom");
            _vol += s.Cut ? -100 : 1000;
        }
        public void Pattern(PatternStep s) { Calls.Add("pattern:" + s.FeatureName); _vol -= 300; }
        public double VolumeMm3() => _vol;
        public void SaveNative(string p) { Calls.Add("save"); File.WriteAllText(p, "x"); }
        public void ExportStep(string p) { Calls.Add("step"); File.WriteAllText(p, "x"); }
        public void Close() { Calls.Add("close"); }
    }

    public class RunnerTests : IDisposable
    {
        readonly string _dir = Path.Combine(Path.GetTempPath(), "reify-" + Guid.NewGuid().ToString("N"));
        public RunnerTests() { Directory.CreateDirectory(_dir); }
        public void Dispose() { try { Directory.Delete(_dir, true); } catch (IOException) { } }

        JobResult Run(FakeBuilder fb, Job job)
        {
            using var log = new JobLog(Path.Combine(_dir, "log.txt"));
            return new JobRunner(_dir, job, job.JobId, fb, log).Run();
        }

        [Fact]
        public void SuccessWritesResultJson()
        {
            var fb = new FakeBuilder();
            var r = Run(fb, JobLoader.Parse(Samples.Job(Samples.Features)));
            Assert.True(r.Ok);
            Assert.Equal(3, r.FeaturesBuilt);
            Assert.Equal(new[] { "begin", "sketch:bracket/base_profile", "extrude:bracket/base", "sketch:bracket/hole_sketch", "extrude:bracket/holes", "pattern:bracket/ring", "save", "step", "close" }, fb.Calls.ToArray());
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(_dir, "result.json")));
            var root = doc.RootElement;
            Assert.Equal("reify.transfer.result/1", root.GetProperty("schema").GetString());
            Assert.True(root.GetProperty("ok").GetBoolean());
            Assert.Equal("solidworks", root.GetProperty("target").GetString());
            Assert.Equal("ReifyExport", root.GetProperty("executor").GetProperty("name").GetString());
            Assert.Equal("0.1.0", root.GetProperty("executor").GetProperty("version").GetString());
            Assert.Equal("part.SLDPRT", root.GetProperty("files").GetProperty("native").GetString());
            Assert.Equal(JsonValueKind.Null, root.GetProperty("error").ValueKind);
            var vols = root.GetProperty("feature_volumes");
            Assert.Equal(3, vols.GetArrayLength());
            Assert.Equal(1000.0, vols[0].GetProperty("volume_mm3").GetDouble());
            Assert.True(File.Exists(Path.Combine(_dir, "part.SLDPRT")));
        }

        [Fact]
        public void BuilderFailureMapsToErrorWithFeatureAndStep()
        {
            var fb = new FakeBuilder { FailOn = "bracket/holes" };
            var r = Run(fb, JobLoader.Parse(Samples.Job(Samples.Features)));
            Assert.False(r.Ok);
            Assert.Equal(ErrorCodes.ExecutorFailed, r.Error!.Code);
            Assert.Equal("bracket/holes", r.Error.Feature);
            Assert.Equal("extrude", r.Error.Step);
            Assert.Equal(1, r.FeaturesBuilt);
            Assert.Contains("close", fb.Calls);
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(_dir, "result.json")));
            Assert.False(doc.RootElement.GetProperty("ok").GetBoolean());
            Assert.Equal("bracket/holes", doc.RootElement.GetProperty("error").GetProperty("feature").GetString());
        }

        [Fact]
        public void UnsupportedOpFailsBeforeSolidWorksIsTouched()
        {
            var fb = new FakeBuilder();
            var job = JobLoader.Parse(Samples.Job(Samples.Features.Replace("\"polar_pattern\"", "\"loft\"")));
            var r = Run(fb, job);
            Assert.False(r.Ok);
            Assert.Equal(ErrorCodes.UnsupportedOp, r.Error!.Code);
            Assert.Equal("bracket/ring", r.Error.Feature);
            Assert.Empty(fb.Calls);
        }

        [Fact]
        public void TimeoutResultIsExecutorFailedTimeout()
        {
            using var log = new JobLog(null);
            var runner = new JobRunner(_dir, null, "j1", new FakeBuilder(), log);
            var r = runner.TimeoutResult(5)!;
            Assert.False(r.Ok);
            Assert.Equal(ErrorCodes.ExecutorFailed, r.Error!.Code);
            Assert.StartsWith("timeout", r.Error.Message);
            Assert.True(File.Exists(Path.Combine(_dir, "result.json")));
        }

        [Fact]
        public void CutThatRemovesNothingIsAnError()
        {
            var f = JsonSerializer.Deserialize<FeatureFile>(Samples.Features, JsonDefaults.Read)!;
            var fb = new NoOpCutBuilder();
            using var log = new JobLog(null);
            var job = JobLoader.Parse(Samples.Job(Samples.Features));
            var r = new JobRunner(_dir, job, job.JobId, fb, log).Run();
            Assert.False(r.Ok);
            Assert.Equal("bracket/holes", r.Error!.Feature);
            Assert.Contains("removed no material", r.Error.Message);
        }

        sealed class NoOpCutBuilder : IPartBuilder
        {
            double _v;
            public string Begin(string n) => "x";
            public void BuildSketch(SketchPlan s) { }
            public void ReuseSketch(string n) { }
            public void Extrude(ExtrudeStep s) { if (!s.Cut) _v += 100; }
            public void Pattern(PatternStep s) { }
            public double VolumeMm3() => _v;
            public void SaveNative(string p) { }
            public void ExportStep(string p) { }
            public void Close() { }
        }
    }

    public class CliTests
    {
        sealed class FakeProbe : ISwProbe
        {
            public bool ProgId; public string[] Keys = Array.Empty<string>();
            public bool ProgIdRegistered() => ProgId;
            public IReadOnlyList<string> SolidWorksKeyNames() => Keys;
        }

        [Fact]
        public void ParsesArguments()
        {
            Assert.Equal(CliKind.Version, CliParser.Parse(new[] { "--version" }).Kind);
            Assert.Equal(CliKind.Check, CliParser.Parse(new[] { "--check" }).Kind);
            var j = CliParser.Parse(new[] { "--job", @"C:\x\y" });
            Assert.Equal(CliKind.Job, j.Kind);
            Assert.Equal(@"C:\x\y", j.JobDir);
            Assert.Equal(CliKind.Invalid, CliParser.Parse(new[] { "--job" }).Kind);
            Assert.Equal(CliKind.Invalid, CliParser.Parse(Array.Empty<string>()).Kind);
        }

        [Fact]
        public void VersionLine() { Assert.Equal("ReifyExport 0.1.0", AppInfo.VersionLine); }

        [Fact]
        public void CheckReportNotInstalled()
        {
            var rep = CheckReport.Build(new FakeProbe());
            Assert.False(rep.SwInstalled);
            using var d = JsonDocument.Parse(rep.ToJson());
            Assert.Equal("0.1.0", d.RootElement.GetProperty("version").GetString());
            Assert.False(d.RootElement.GetProperty("swInstalled").GetBoolean());
            Assert.False(d.RootElement.TryGetProperty("swVersion", out _));
        }

        [Fact]
        public void CheckReportPicksNewestYear()
        {
            var rep = CheckReport.Build(new FakeProbe { ProgId = true, Keys = new[] { "SOLIDWORKS 2022", "Applications", "SOLIDWORKS 2024" } });
            Assert.True(rep.SwInstalled);
            Assert.Equal("2024", rep.SwVersion);
        }
    }
}
