using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace Reify.Export.Tests
{
    static class Build
    {
        public static FeatureFile Sample() => JsonSerializer.Deserialize<FeatureFile>(Samples.Features, JsonDefaults.Read)!;
        public static FeatureDef Feat(FeatureFile f, string name) => f.Bodies[0].Features.First(x => x.Name == name);

        public static string Dir() { var d = Path.Combine(Path.GetTempPath(), "reify-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(d); return d; }

        public static JobResult Run(string dir, FakeBuilder fb, Job job)
        {
            using var log = new JobLog(null);
            return new JobRunner(dir, job, job.JobId, fb, log).Run();
        }
    }

    public class ExprTests
    {
        static readonly Dictionary<string, double> N = new Dictionary<string, double> { { "width", 40 }, { "t", 5 } };

        [Theory]
        [InlineData("=width/2", 20.0)]
        [InlineData("width - 2*t", 30.0)]
        [InlineData("(width + t) * 2", 90.0)]
        [InlineData("-t + 10", 5.0)]
        [InlineData("5mm + 1", 6.0)]
        [InlineData("90 deg / 2", 45.0)]
        [InlineData("Params.width/4", 10.0)]
        public void EvaluatesGrammar(string expr, double expected)
        {
            Assert.Equal(expected, ExprParser.Parse(expr).Eval(N), 9);
        }

        [Fact]
        public void RendersSolidWorksEquation()
        {
            Assert.Equal("(\"width\" / 2)", ExprParser.Parse("=width/2").ToSw());
            Assert.Equal("(5mm + \"t\")", ExprParser.Parse("5mm + t").ToSw());
        }

        [Theory]
        [InlineData("sin(width)")]
        [InlineData("width ^ 2")]
        [InlineData("3 inch")]
        [InlineData("(1 + 2")]
        [InlineData("")]
        [InlineData("a.b")]
        public void RejectsOutsideGrammar(string expr)
        {
            Assert.Throws<ExprException>(() => ExprParser.Parse(expr));
        }

        [Fact]
        public void UnknownNameAndDivisionByZeroFailOnEval()
        {
            Assert.Throws<ExprException>(() => ExprParser.Parse("nope + 1").Eval(N));
            Assert.Throws<ExprException>(() => ExprParser.Parse("1 / (t - 5)").Eval(N));
        }
    }

    public class ParameterPlanTests
    {
        [Fact]
        public void ExpressionBecomesBindingWhenConsistent()
        {
            var f = Build.Sample();
            f.Parameters.Add(new ParameterDef { Name = "thickness", Value = 5, Unit = "mm" });
            var plan = Planner.Build(f);
            Assert.Equal("thickness", plan.Parameters.Single().Name);
            var pad = (ExtrudeStep)plan.Steps[0];
            var b = Assert.Single(pad.Bindings);
            Assert.Equal("D1@bracket/base", b.FullName);
            Assert.Equal("\"thickness\"", b.SwExpr);
            Assert.Empty(plan.Warnings.Where(w => w.Expr != null));
        }

        [Fact]
        public void UnknownParameterFallsBackToValueWithWarning()
        {
            var f = Build.Sample();   // sample has expr "=thickness" but no parameters
            var plan = Planner.Build(f);
            var pad = (ExtrudeStep)plan.Steps[0];
            Assert.Empty(pad.Bindings);
            Assert.Equal(0.005, pad.DepthM, 12);
            var w = Assert.Single(plan.Warnings, x => x.Expr == "=thickness");
            Assert.Equal("bracket/base", w.Feature);
            Assert.Equal("depth", w.Field);
            Assert.Contains("thickness", w.Reason);
        }

        [Fact]
        public void ExpressionOutsideGrammarOrWrongValueWarnsAndKeepsValue()
        {
            var f = Build.Sample();
            f.Parameters.Add(new ParameterDef { Name = "thickness", Value = 7 });   // evaluates to 7, value is 5
            var plan = Planner.Build(f);
            Assert.Empty(((ExtrudeStep)plan.Steps[0]).Bindings);
            Assert.Contains(plan.Warnings, w => w.Reason.Contains("evaluates to 7"));

            var g = Build.Sample();
            Build.Feat(g, "bracket/base").Extent!.Length!.Expr = "sqrt(2)";
            var p2 = Planner.Build(g);
            Assert.Contains(p2.Warnings, w => w.Expr == "sqrt(2)");
            Assert.Equal(0.005, ((ExtrudeStep)p2.Steps[0]).DepthM, 12);
        }

        [Fact]
        public void RunnerCreatesParametersAndBindsAndWarnsOnBindFailure()
        {
            var f = Build.Sample();
            f.Parameters.Add(new ParameterDef { Name = "thickness", Value = 5, Unit = "mm" });
            string json = JsonSerializer.Serialize(f);
            var job = JobLoader.Parse(Samples.Job(json));
            string dir = Build.Dir();
            var fb = new FakeBuilder { FailBind = true };
            var r = Build.Run(dir, fb, job);
            Assert.True(r.Ok);
            Assert.Equal("param:thickness", fb.Calls[1]);
            Assert.Contains(fb.Calls, c => c.StartsWith("bind:D1@bracket/base="));
            var w = Assert.Single(r.Warnings, x => x.Feature == "bracket/base");
            Assert.Contains("could not bind", w.Reason);
        }

        [Fact]
        public void MaterialDensityIsAppliedAndWarned()
        {
            var f = Build.Sample();
            f.Material = new MaterialDef { Name = "steel", DensityKgM3 = 7850 };
            var job = JobLoader.Parse(Samples.Job(JsonSerializer.Serialize(f)));
            var fb = new FakeBuilder();
            var r = Build.Run(Build.Dir(), fb, job);
            Assert.True(r.Ok);
            Assert.Contains("density:7850", fb.Calls);
            Assert.Contains(r.Warnings, w => w.Field == "material");
        }
    }

    public class P2PlanTests
    {
        static FeatureFile WithFeature(FeatureDef d) { var f = Build.Sample(); f.Bodies[0].Features.Add(d); return f; }

        [Fact]
        public void LinearPatternPlans()
        {
            var f = WithFeature(new FeatureDef
            {
                Name = "bracket/row", Type = "linear_pattern", Originals = new List<string> { "bracket/holes" },
                Direction = new double[] { 0, -1, 0 }, Length = new Dim { Value = 30 }, Occurrences = 4, Spacing = new Dim { Value = 10 },
            });
            var st = (LinearPatternStep)Planner.Build(f).Steps.Last();
            Assert.Equal(1, st.AxisIndex);
            Assert.True(st.Reverse);
            Assert.Equal(4, st.Count);
            Assert.Equal(0.010, st.SpacingM, 12);
        }

        [Fact]
        public void LinearPatternRejectsInconsistentSpacingAndObliqueDirection()
        {
            var f = WithFeature(new FeatureDef
            {
                Name = "p", Type = "linear_pattern", Originals = new List<string> { "bracket/holes" },
                Direction = new double[] { 1, 0, 0 }, Length = new Dim { Value = 30 }, Occurrences = 4, Spacing = new Dim { Value = 9 },
            });
            Assert.Equal(ErrorCodes.ExecutorFailed, Assert.Throws<ExecException>(() => Planner.Build(f)).Code);
            var g = WithFeature(new FeatureDef
            {
                Name = "p", Type = "linear_pattern", Originals = new List<string> { "bracket/holes" },
                Direction = new double[] { 1, 1, 0 }, Spacing = new Dim { Value = 9 }, Occurrences = 3,
            });
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(g)).Code);
        }

        [Fact]
        public void MirrorOnBasePlaneAndOffsetPlane()
        {
            var f = WithFeature(new FeatureDef
            {
                Name = "m1", Type = "mirror", Originals = new List<string> { "bracket/holes" },
                Plane = new MirrorPlaneDef { Origin = new double[] { 0, 0, 0 }, Normal = new double[] { 1, 0, 0 } },
            });
            f.Bodies[0].Features.Add(new FeatureDef
            {
                Name = "m2", Type = "mirror", Originals = new List<string> { "bracket/holes" },
                Plane = new MirrorPlaneDef { Origin = new double[] { 20, 0, 0 }, Normal = new double[] { -1, 0, 0 } },
            });
            var steps = Planner.Build(f).Steps.OfType<MirrorStep>().ToList();
            Assert.Equal(SwBasePlane.Right, steps[0].Plane);
            Assert.Equal(0.0, steps[0].OffsetM);
            Assert.Equal(SwBasePlane.Right, steps[1].Plane);
            Assert.Equal(0.020, steps[1].OffsetM, 12);
        }

        [Fact]
        public void MirrorWithTiltedNormalIsUnsupported()
        {
            var f = WithFeature(new FeatureDef
            {
                Name = "m", Type = "mirror", Originals = new List<string> { "bracket/holes" },
                Plane = new MirrorPlaneDef { Origin = new double[] { 0, 0, 0 }, Normal = new double[] { 1, 1, 0 } },
            });
            var e = Assert.Throws<ExecException>(() => Planner.Build(f));
            Assert.Equal(ErrorCodes.UnsupportedOp, e.Code);
            Assert.Equal("m", e.Feature);
        }

        static void AddDims(FeatureFile f, params DimensionDef[] dims) => f.Bodies[0].Sketches[0].Dimensions.AddRange(dims);

        [Fact]
        public void SketchDimensionsPlanInSiUnits()
        {
            var f = Build.Sample();
            AddDims(f,
                new DimensionDef { Name = "len", Kind = "distance", Refs = new[] { new[] { 0, 0 } }, Value = new Dim { Value = 40 } },
                new DimensionDef { Name = "rad", Kind = "radius", Refs = new[] { new[] { 4, 0 } }, Value = new Dim { Value = 2 } },
                new DimensionDef { Name = "ang", Kind = "angle", Refs = new[] { new[] { 0, 0 }, new[] { 1, 0 } }, Value = new Dim { Value = 90 } },
                new DimensionDef { Name = "ox", Kind = "distance_x", Refs = new[] { new[] { -1, 1 }, new[] { 0, 2 } }, Value = new Dim { Value = 40 } });
            var dims = ((ExtrudeStep)Planner.Build(f).Steps[0]).Sketch.Dimensions;
            Assert.Equal(4, dims.Count);
            Assert.Equal(0.040, dims[0].ValueSi, 12);
            Assert.Equal(Math.PI / 2, dims[2].ValueSi, 12);
            Assert.Equal(-1, dims[3].Refs[0].GeomId);
        }

        [Fact]
        public void BadSketchDimensionsAreRejected()
        {
            var f = Build.Sample();
            AddDims(f, new DimensionDef { Name = "x", Kind = "distance", Refs = new[] { new[] { 99, 0 } }, Value = new Dim { Value = 1 } });
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(f)).Code);
            var g = Build.Sample();
            AddDims(g, new DimensionDef { Name = "x", Kind = "ordinate", Refs = new[] { new[] { 0, 0 } }, Value = new Dim { Value = 1 } });
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(g)).Code);
        }

        [Fact]
        public void DimensionKindsMapToSolidWorksValues()
        {
            Assert.Equal(0.004, SketchMath.ExpectedSwDimensionValue("radius", "circle", 0.002), 12);
            Assert.Equal(0.002, SketchMath.ExpectedSwDimensionValue("radius", "arc", 0.002), 12);
            Assert.Equal(0.001, SketchMath.ExpectedSwDimensionValue("diameter", "arc", 0.002), 12);
            Assert.Equal(0.002, SketchMath.ExpectedSwDimensionValue("diameter", "circle", 0.002), 12);
            Assert.True(SketchMath.IsHorizontalInSketch("distance_x", 1, 0, 0, 1));
            Assert.False(SketchMath.IsHorizontalInSketch("distance_y", 1, 0, 0, 1));
            Assert.True(SketchMath.IsHorizontalInSketch("distance_x", 1, 0, 0, -1));
            Assert.False(SketchMath.IsHorizontalInSketch("distance_x", 0, 1, 1, 0));
            Assert.True(SketchMath.IsHorizontalInSketch("distance_y", 0, 1, 1, 0));
        }

        [Fact]
        public void IslandDepthTwoStaysRejected()
        {
            var f = Build.Sample();
            f.Bodies[0].Sketches[0].Loops.Add(new LoopDef { Id = 5, Closed = true, Depth = 2 });
            var e = Assert.Throws<ExecException>(() => Planner.Build(f));
            Assert.Equal(ErrorCodes.UnsupportedOp, e.Code);
            Assert.Contains("depth 2", e.Message);
        }
    }

    public class P2RunnerTests
    {
        [Fact]
        public void PatternMirrorStepsRunInOrder()
        {
            var f = Build.Sample();
            f.Bodies[0].Features.Add(new FeatureDef
            {
                Name = "bracket/row", Type = "linear_pattern", Originals = new List<string> { "bracket/holes" },
                Direction = new double[] { 1, 0, 0 }, Spacing = new Dim { Value = 5 }, Occurrences = 3,
            });
            f.Bodies[0].Features.Add(new FeatureDef
            {
                Name = "bracket/mir", Type = "mirror", Originals = new List<string> { "bracket/row" },
                Plane = new MirrorPlaneDef { Origin = new double[] { 0, 0, 0 }, Normal = new double[] { 0, 1, 0 } },
            });
            var fb = new FakeBuilder();
            var r = Build.Run(Build.Dir(), fb, JobLoader.Parse(Samples.Job(JsonSerializer.Serialize(f))));
            Assert.True(r.Ok);
            Assert.Equal(5, r.FeaturesBuilt);
            Assert.Contains("linear:bracket/row", fb.Calls);
            Assert.True(fb.Calls.IndexOf("mirror:bracket/mir") > fb.Calls.IndexOf("linear:bracket/row"));
        }

        [Fact]
        public void AssemblyJobBuildsPartsPlacesOccurrencesAndListsExtraFiles()
        {
            var asm = new AssemblyFile
            {
                Schema = "reify.assembly/1", Units = "mm", Name = "asm",
                Parts =
                {
                    new AssemblyPartDef { Ref = "parts/a.FCStd", Name = "axle", Features = Build.Sample() },
                    new AssemblyPartDef { Ref = "parts/b.FCStd", Name = "plate", Features = Build.Sample() },
                },
                Occurrences =
                {
                    new OccurrenceDef { Name = "asm/axle_1", Part = "parts/a.FCStd", Transform = new TransformDef { Origin = new double[] { 10, 0, 0 }, Rotation = Identity() } },
                    new OccurrenceDef { Name = "asm/axle_2", Part = "parts/a.FCStd", Transform = new TransformDef { Origin = new double[] { 20, 0, 0 }, Rotation = Identity() } },
                    new OccurrenceDef { Name = "asm/plate_1", Part = "parts/b.FCStd", Transform = new TransformDef { Origin = new double[] { 0, 0, 0 }, Rotation = Identity() } },
                },
            };
            string json = @"{ ""schema"": ""reify.transfer.job/1"", ""jobId"": ""a1"", ""target"": ""solidworks"", ""kind"": ""assembly"", ""assembly"": " +
                JsonSerializer.Serialize(asm) + @", ""output"": { ""native"": ""part.SLDASM"", ""check_step"": ""check.step"" }, ""check"": true, ""timeoutS"": 300 }";
            string dir = Build.Dir();
            var fb = new FakeBuilder();
            var r = Build.Run(dir, fb, JobLoader.Parse(json));
            Assert.True(r.Ok, r.Error?.Message);
            Assert.Equal(new[] { "axle.SLDPRT", "plate.SLDPRT" }, r.Files.Extra.ToArray());
            Assert.Equal("part.SLDASM", r.Files.Native);
            Assert.Equal(new[] { "asm/axle_1", "asm/axle_2", "asm/plate_1" }, r.FeatureVolumes.Select(v => v.Name).ToArray());
            Assert.All(r.FeatureVolumes, v => Assert.Equal(600.0, v.VolumeMm3));   // 1000 - 100 - 300 from the fake
            Assert.Contains("component:asm/axle_2:axle.SLDPRT", fb.Calls);
            Assert.True(fb.Calls.IndexOf("begin_asm:asm") > fb.Calls.IndexOf("save:plate.SLDPRT"));
            Assert.True(fb.Calls.IndexOf("save:part.SLDASM") > fb.Calls.IndexOf("component:asm/plate_1:plate.SLDPRT"));
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "result.json")));
            Assert.Equal(2, doc.RootElement.GetProperty("files").GetProperty("extra").GetArrayLength());
        }

        static double[][] Identity() => new[] { new double[] { 1, 0, 0 }, new double[] { 0, 1, 0 }, new double[] { 0, 0, 1 } };

        [Fact]
        public void AssemblyPlannerRejectsBadTransformAndUnknownPart()
        {
            var a = new AssemblyFile
            {
                Schema = "reify.assembly/1", Units = "mm", Name = "x",
                Parts = { new AssemblyPartDef { Ref = "p", Name = "p", Features = Build.Sample() } },
                Occurrences = { new OccurrenceDef { Name = "o", Part = "p", Transform = new TransformDef { Origin = new double[3], Rotation = new[] { new double[] { 2, 0, 0 }, new double[] { 0, 1, 0 }, new double[] { 0, 0, 1 } } } } },
            };
            Assert.Equal(ErrorCodes.ExecutorFailed, Assert.Throws<ExecException>(() => AssemblyPlanner.Build(a)).Code);
            a.Occurrences[0].Transform.Rotation = Identity();
            a.Occurrences[0].Part = "missing";
            Assert.Equal(ErrorCodes.ExecutorFailed, Assert.Throws<ExecException>(() => AssemblyPlanner.Build(a)).Code);
        }

        [Fact]
        public void TransformArrayLayout()
        {
            var t = new TransformDef { Origin = new double[] { 10, 20, 30 }, Rotation = new[] { new double[] { 0, -1, 0 }, new double[] { 1, 0, 0 }, new double[] { 0, 0, 1 } } };
            var a = TransformMath.ToSwArray(t);
            Assert.Equal(16, a.Length);
            Assert.Equal(new double[] { 0, -1, 0, 1, 0, 0, 0, 0, 1 }, a.Take(9).ToArray());
            Assert.Equal(0.010, a[9], 12);
            Assert.Equal(0.030, a[11], 12);
            Assert.Equal(1.0, a[12]);
            Assert.True(TransformMath.IsRotation(t.Rotation));
        }

        [Fact]
        public void FailureInsideAssemblyPartNamesTheFeature()
        {
            var asm = new AssemblyFile
            {
                Schema = "reify.assembly/1", Units = "mm", Name = "asm",
                Parts = { new AssemblyPartDef { Ref = "p", Name = "axle", Features = Build.Sample() } },
                Occurrences = { new OccurrenceDef { Name = "o", Part = "p", Transform = new TransformDef { Origin = new double[3], Rotation = Identity() } } },
            };
            string json = @"{ ""schema"": ""reify.transfer.job/1"", ""jobId"": ""a2"", ""target"": ""solidworks"", ""kind"": ""assembly"", ""assembly"": " +
                JsonSerializer.Serialize(asm) + @", ""output"": { ""native"": ""part.SLDASM"", ""check_step"": ""check.step"" }, ""check"": true, ""timeoutS"": 300 }";
            var fb = new FakeBuilder { FailOn = "bracket/holes" };
            var r = Build.Run(Build.Dir(), fb, JobLoader.Parse(json));
            Assert.False(r.Ok);
            Assert.Equal("bracket/holes", r.Error!.Feature);
            Assert.Contains("close", fb.Calls);
        }
    }

    public class MatchTests
    {
        static EdgeInfo Line(int i, double x, double y, double z, double len) =>
            new EdgeInfo { Index = i, Curve = "line", Midpoint = new[] { x, y, z }, Length = len };

        static EdgeRefDef Ref(double x, double y, double z, double len) =>
            new EdgeRefDef { Curve = "line", Midpoint = new[] { x, y, z }, Length = len };

        [Fact]
        public void FindsTheUniqueEdge()
        {
            var edges = new List<EdgeInfo> { Line(0, 20, 0, 5, 40), Line(1, 20, 30, 5, 40), Line(2, 20, 0, 5, 12) };
            Assert.Equal(1, EdgeMatch.Resolve(edges, Ref(20, 30, 5, 40), 60, "f").Index);
            Assert.Equal(2, EdgeMatch.Resolve(edges, Ref(20, 0, 5, 12), 60, "f").Index);   // same midpoint as edge 0, different length
        }

        [Fact]
        public void ToleranceIsRelativeToDiagonal()
        {
            var edges = new List<EdgeInfo> { Line(0, 20, 0, 5, 40) };
            // diagonal 100 mm -> tolerance 0.01 mm
            Assert.Equal(0, EdgeMatch.Resolve(edges, Ref(20.005, 0, 5, 40), 100, "f").Index);
            Assert.Throws<ExecException>(() => EdgeMatch.Resolve(edges, Ref(20.5, 0, 5, 40), 100, "f"));
        }

        [Fact]
        public void ZeroOrSeveralMatchesNameTheFeature()
        {
            var edges = new List<EdgeInfo> { Line(0, 1, 1, 1, 10), Line(1, 1, 1, 1, 10) };
            var amb = Assert.Throws<ExecException>(() => EdgeMatch.Resolve(edges, Ref(1, 1, 1, 10), 50, "bracket/fillet"));
            Assert.Equal("bracket/fillet", amb.Feature);
            Assert.Contains("not unique", amb.Message);
            var none = Assert.Throws<ExecException>(() => EdgeMatch.Resolve(edges, Ref(9, 9, 9, 10), 50, "bracket/fillet"));
            Assert.Contains("no edge", none.Message);
            Assert.Equal(ErrorCodes.ExecutorFailed, none.Code);
        }

        [Fact]
        public void CurveTypeMustMatchAndCirclesUseCentre()
        {
            var circle = new EdgeInfo { Index = 0, Curve = "circle", Midpoint = new double[] { 99, 99, 99 }, Length = 18.85, Centre = new double[] { 10, 10, 5 }, Radius = 3 };
            var r = new EdgeRefDef { Curve = "circle", Midpoint = new double[] { 13, 10, 5 }, Length = 18.85, Centre = new double[] { 10, 10, 5 }, Radius = 3 };
            Assert.Equal(0, EdgeMatch.Resolve(new[] { circle }, r, 50, "f").Index);
            r.Curve = "arc";
            Assert.Throws<ExecException>(() => EdgeMatch.Resolve(new[] { circle }, r, 50, "f"));
        }

        [Fact]
        public void DuplicateRefsResolveOnce()
        {
            var edges = new List<EdgeInfo> { Line(0, 1, 1, 1, 10), Line(1, 5, 5, 5, 10) };
            var list = EdgeMatch.ResolveAll(edges, new[] { Ref(1, 1, 1, 10), Ref(1, 1, 1, 10), Ref(5, 5, 5, 10) }, 50, "f");
            Assert.Equal(new[] { 0, 1 }, list.Select(e => e.Index).ToArray());
        }

        static FaceInfo Face(int i, double z, double area, bool planar = true, double nz = 1) =>
            new FaceInfo { Index = i, Planar = planar, Origin = new double[] { 0, 0, z }, Normal = new double[] { 0, 0, nz }, Area = area };

        [Fact]
        public void FaceMatchChecksPlaneNormalAndArea()
        {
            var faces = new List<FaceInfo> { Face(0, 5, 1200), Face(1, 0, 1200, nz: -1), Face(2, 5, 300), Face(3, 5, 1200, planar: false) };
            var r = new FaceRefDef { Origin = new double[] { 7, 7, 5 }, Normal = new double[] { 0, 0, 1 }, Area = 1200 };
            Assert.Equal(0, FaceMatch.Resolve(faces, r, 60, "f").Index);
            var bottom = new FaceRefDef { Origin = new double[] { 1, 1, 0 }, Normal = new double[] { 0, 0, 1 }, Area = 1200 };   // either sign accepted
            Assert.Equal(1, FaceMatch.Resolve(faces, bottom, 60, "f").Index);
            var none = new FaceRefDef { Origin = new double[] { 1, 1, 3 }, Normal = new double[] { 0, 0, 1 }, Area = 1200 };
            Assert.Throws<ExecException>(() => FaceMatch.Resolve(faces, none, 60, "f"));
        }

        [Fact]
        public void FaceMatchAmbiguityIsAnError()
        {
            var faces = new List<FaceInfo> { Face(0, 5, 1200), Face(1, 5, 1200) };
            var r = new FaceRefDef { Origin = new double[] { 0, 0, 5 }, Normal = new double[] { 0, 0, 1 }, Area = 1200 };
            var e = Assert.Throws<ExecException>(() => FaceMatch.Resolve(faces, r, 60, "g"));
            Assert.Equal("g", e.Feature);
        }
    }

    public class P3PlanTests
    {
        static FeatureFile WithFeature(FeatureDef d) { var f = Build.Sample(); f.Bodies[0].Features.Add(d); return f; }

        static EdgeRefDef E(double x) => new EdgeRefDef { Curve = "line", Midpoint = new double[] { x, 0, 5 }, Length = 40 };

        [Fact]
        public void FilletAndChamferPlanWithBindings()
        {
            var f = WithFeature(new FeatureDef { Name = "bracket/fillet", Type = "fillet", Edges = new List<EdgeRefDef> { E(1), E(2) }, Radius = new Dim { Value = 1.5, Expr = "=r" } });
            f.Bodies[0].Features.Add(new FeatureDef { Name = "bracket/chamfer", Type = "chamfer", Edges = new List<EdgeRefDef> { E(3) }, Size = new Dim { Value = 0.5 } });
            f.Parameters.Add(new ParameterDef { Name = "r", Value = 1.5, Unit = "mm" });
            var plan = Planner.Build(f);
            var fi = (FilletStep)plan.Steps[3];
            Assert.Equal(0.0015, fi.RadiusM, 12);
            Assert.Equal(2, fi.Edges.Count);
            Assert.Equal("D1@bracket/fillet", Assert.Single(fi.Bindings).FullName);
            Assert.Equal(0.0005, ((ChamferStep)plan.Steps[4]).SizeM, 12);
        }

        [Fact]
        public void BadEdgeRefsFailInPlanning()
        {
            var f = WithFeature(new FeatureDef { Name = "x", Type = "fillet", Edges = new List<EdgeRefDef> { new EdgeRefDef { Curve = "spline", Midpoint = new double[3], Length = 1 } }, Radius = new Dim { Value = 1 } });
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(f)).Code);
            var g = WithFeature(new FeatureDef { Name = "y", Type = "chamfer", Edges = new List<EdgeRefDef>(), Size = new Dim { Value = 1 } });
            Assert.Throws<ExecException>(() => Planner.Build(g));
        }

        [Fact]
        public void RunnerResolvesEdgesBeforeCallingBuilder()
        {
            var f = WithFeature(new FeatureDef { Name = "bracket/fillet", Type = "fillet", Edges = new List<EdgeRefDef> { E(1) }, Radius = new Dim { Value = 1 } });
            var fb = new FakeBuilder();
            fb.Edges.Add(new EdgeInfo { Index = 7, Curve = "line", Midpoint = new double[] { 1, 0, 5 }, Length = 40 });
            fb.Edges.Add(new EdgeInfo { Index = 8, Curve = "line", Midpoint = new double[] { 2, 0, 5 }, Length = 40 });
            var r = Build.Run(Build.Dir(), fb, JobLoader.Parse(Samples.Job(JsonSerializer.Serialize(f))));
            Assert.True(r.Ok, r.Error?.Message);
            Assert.Contains("fillet:bracket/fillet:7", fb.Calls);
        }

        [Fact]
        public void UnmatchedEdgeFailsTheJobNamingTheFeature()
        {
            var f = WithFeature(new FeatureDef { Name = "bracket/fillet", Type = "fillet", Edges = new List<EdgeRefDef> { E(1) }, Radius = new Dim { Value = 1 } });
            var fb = new FakeBuilder();
            var r = Build.Run(Build.Dir(), fb, JobLoader.Parse(Samples.Job(JsonSerializer.Serialize(f))));
            Assert.False(r.Ok);
            Assert.Equal("bracket/fillet", r.Error!.Feature);
            Assert.Equal("edge_match", r.Error.Step);
            Assert.DoesNotContain(fb.Calls, c => c.StartsWith("fillet:"));
        }

        [Fact]
        public void UpToFacePlansAndRunnerPassesTheMatchedFace()
        {
            var f = Build.Sample();
            var pad = Build.Feat(f, "bracket/base");
            pad.Extent = new ExtentDef { Type = "up_to_face", FaceRef = new FaceRefDef { Origin = new double[] { 0, 0, 9 }, Normal = new double[] { 0, 0, 1 }, Area = 100 } };
            var step = (ExtrudeStep)Planner.Build(f).Steps[0];
            Assert.Equal(EndCondition.UpToFace, step.End);
            var fb = new FakeBuilder();
            fb.Faces.Add(new FaceInfo { Index = 4, Planar = true, Origin = new double[] { 3, 3, 9 }, Normal = new double[] { 0, 0, 1 }, Area = 100 });
            var r = Build.Run(Build.Dir(), fb, JobLoader.Parse(Samples.Job(JsonSerializer.Serialize(f))));
            Assert.True(r.Ok, r.Error?.Message);
            Assert.Contains("extrude:bracket/base@face4", fb.Calls);
        }

        [Fact]
        public void UpToFaceOnPocketOrWithoutFaceRefIsUnsupported()
        {
            var f = Build.Sample();
            Build.Feat(f, "bracket/base").Extent = new ExtentDef { Type = "up_to_face" };
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(f)).Code);
        }

        [Fact]
        public void TiltedFaceSketchUsesFaceNormalForDirection()
        {
            var f = Build.Sample();
            var sk = f.Bodies[0].Sketches[0];
            double s = Math.Sqrt(0.5);
            sk.Frame = new FrameDef { Origin = new double[] { 0, 0, 0 }, U = new double[] { 1, 0, 0 }, V = new double[] { 0, s, s }, N = new double[] { 0, -s, s } };
            sk.FaceRef = new FaceRefDef { Origin = new double[] { 0, 0, 0 }, Normal = new double[] { 0, -s, s }, Area = 1200 };
            Build.Feat(f, "bracket/base").Direction = new double[] { 0, -s, s };
            var st = (ExtrudeStep)Planner.Build(f).Steps[0];
            Assert.NotNull(st.Sketch.Face);
            Assert.False(st.Reverse);
            Build.Feat(f, "bracket/base").Direction = new double[] { 0, s, -s };
            Assert.True(((ExtrudeStep)Planner.Build(f).Steps[0]).Reverse);

            var fb = new FakeBuilder();
            fb.Faces.Add(new FaceInfo { Index = 2, Planar = true, Origin = new double[] { 0, 0, 0 }, Normal = new double[] { 0, -s, s }, Area = 1200 });
            Build.Feat(f, "bracket/base").Direction = new double[] { 0, -s, s };
            var r = Build.Run(Build.Dir(), fb, JobLoader.Parse(Samples.Job(JsonSerializer.Serialize(f))));
            Assert.True(r.Ok, r.Error?.Message);
            Assert.Contains("sketch:bracket/base_profile@face2", fb.Calls);
        }

        [Fact]
        public void TiltedFrameWithoutFaceRefIsUnsupported()
        {
            var f = Build.Sample();
            double s = Math.Sqrt(0.5);
            f.Bodies[0].Sketches[0].Frame.N = new double[] { 0, -s, s };
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(f)).Code);
        }

        static FeatureFile HoleFile(Action<FeatureDef> edit)
        {
            var f = Build.Sample();
            edit(Build.Feat(f, "bracket/holes"));
            return f;
        }

        [Fact]
        public void BlindHoleWithOptionsPlans()
        {
            var f = HoleFile(h =>
            {
                h.Extent = new ExtentDef { Type = "blind", Depth = new Dim { Value = 8 } };
                h.DrillPoint = new DrillPointDef { Type = "angled" };
                h.Counterbore = new CounterboreDef { Diameter = new Dim { Value = 10 }, Depth = new Dim { Value = 3 } };
                h.Thread = new ThreadDef { Standard = "ISO", Size = "M6", PitchMm = 1.0, Modeled = false };
            });
            var hs = (HoleStep)Planner.Build(f).Steps[1];
            Assert.False(hs.Through);
            Assert.Equal(0.008, hs.DepthM, 12);
            Assert.Equal(118.0, hs.DrillPointAngleDeg);
            Assert.Equal(0.010, hs.CounterboreDiameterM, 12);
            Assert.Equal(0.003, hs.CounterboreDepthM, 12);
            Assert.True(hs.CosmeticThread);
            Assert.Equal("M6", hs.ThreadSize);
            Assert.False(hs.IsPlain);
        }

        [Fact]
        public void CountersinkAndFlatDrillPoint()
        {
            var f = HoleFile(h =>
            {
                h.Extent = new ExtentDef { Type = "blind", Depth = new Dim { Value = 8 } };
                h.DrillPoint = new DrillPointDef { Type = "flat" };
                h.Countersink = new CountersinkDef { Diameter = new Dim { Value = 12 }, AngleDeg = 90 };
            });
            var hs = (HoleStep)Planner.Build(f).Steps[1];
            Assert.Equal(0.0, hs.DrillPointAngleDeg);
            Assert.Equal(90.0, hs.CountersinkAngleDeg);
            Assert.Equal(0.012, hs.CountersinkDiameterM, 12);
        }

        [Fact]
        public void BadHolesAreRejected()
        {
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(HoleFile(h => h.Thread = new ThreadDef { Size = "M6", Modeled = true }))).Code);
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(HoleFile(h =>
            {
                h.Counterbore = new CounterboreDef { Diameter = new Dim { Value = 10 }, Depth = new Dim { Value = 3 } };
                h.Countersink = new CountersinkDef { Diameter = new Dim { Value = 10 }, AngleDeg = 90 };
            }))).Code);
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(HoleFile(h => h.Counterbore = new CounterboreDef { Diameter = new Dim { Value = 4 }, Depth = new Dim { Value = 3 } }))).Code);
            Assert.Equal(ErrorCodes.UnsupportedOp, Assert.Throws<ExecException>(() => Planner.Build(HoleFile(h => h.Extent = new ExtentDef { Type = "blind" }))).Code);
        }

        [Fact]
        public void HoleDiameterExpressionWarnsBecauseHoleDimsAreNotBound()
        {
            var f = HoleFile(h => h.Diameter = new Dim { Value = 6, Expr = "=d" });
            f.Parameters.Add(new ParameterDef { Name = "d", Value = 6 });
            var plan = Planner.Build(f);
            Assert.Contains(plan.Warnings, w => w.Feature == "bracket/holes" && w.Field == "diameter");
        }

        [Fact]
        public void FinalUnsupportedStillNamesFeaturesBeforeAnySolidWorksCall()
        {
            var f = Build.Sample();
            f.Bodies[0].Features.Add(new FeatureDef { Name = "bracket/loft", Type = "loft" });
            var fb = new FakeBuilder();
            var r = Build.Run(Build.Dir(), fb, JobLoader.Parse(Samples.Job(JsonSerializer.Serialize(f))));
            Assert.False(r.Ok);
            Assert.Equal(ErrorCodes.UnsupportedOp, r.Error!.Code);
            Assert.Equal("bracket/loft", r.Error.Feature);
            Assert.Empty(fb.Calls);
        }
    }
}
