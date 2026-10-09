using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Reify.Export.Sw
{
    /// <summary>
    /// SolidWorks implementation of IPartBuilder. Every API call here is written from memory of the public
    /// SolidWorks API help; nothing was run against a real SolidWorks. Places that are guesses are marked
    /// UNVERIFIED and are collected in README.md.
    /// All lengths passed to the API are METERS (SI), angles radians.
    /// </summary>
    internal sealed class SwPartBuilder : IPartBuilder
    {
        readonly JobLog _log;
        SldWorks? _app;
        ModelDoc2? _model;
        string? _title;
        readonly List<Feature> _basePlanes = new List<Feature>();
        readonly Dictionary<string, Feature> _features = new Dictionary<string, Feature>();   // semantic name -> SW feature (sketches and features)
        readonly Dictionary<int, Feature> _axes = new Dictionary<int, Feature>();
        readonly List<string> _openedPartTitles = new List<string>();
        List<Face2> _lastFaces = new List<Face2>();
        List<Edge> _lastEdges = new List<Edge>();
        MathUtility? _mu;
        bool _isAssembly;

        public IList<WarningInfo> Warnings { get; } = new List<WarningInfo>();

        public SwPartBuilder(JobLog log) { _log = log; }

        static ExecException Fail(string msg, string step) => new ExecException(ErrorCodes.ExecutorFailed, msg, null, step);

        // ---------------------------------------------------------------- session

        string Connect()
        {
            if (_app == null)
            {
                // attach to a running SolidWorks, else start one. (First export starts SW: slow, 30 s+.)
                object? running = ComHelper.TryGetActiveObject("SldWorks.Application");
                if (running != null)
                {
                    _app = (SldWorks)running;
                    _log.Info("attached to running SolidWorks");
                }
                else
                {
                    Type? t = Type.GetTypeFromProgID("SldWorks.Application");
                    if (t == null) throw Fail("SolidWorks is not installed (ProgID SldWorks.Application is not registered)", "begin");
                    _app = (SldWorks)Activator.CreateInstance(t)!;
                    _app.Visible = true;     // UNVERIFIED
                    _log.Info("started a new SolidWorks instance");
                }
                // UNVERIFIED effect. Modal dialogs still block every COM call.
                try { _app.UserControl = false; } catch (Exception e) { _log.Warn("UserControl=false failed: " + e.Message); }
                _mu = (MathUtility)_app.GetMathUtility();
            }
            return "SOLIDWORKS " + (_app.RevisionNumber() ?? "?");   // UNVERIFIED format
        }

        void ResetDocState()
        {
            _basePlanes.Clear(); _features.Clear(); _axes.Clear();
            _lastFaces = new List<Face2>(); _lastEdges = new List<Edge>();
        }

        void NewDoc(int templatePref, string what)
        {
            string template = _app!.GetUserPreferenceStringValue(templatePref);
            if (string.IsNullOrEmpty(template)) throw Fail("SolidWorks has no default " + what + " template configured", "begin");
            _model = (ModelDoc2?)_app.NewDocument(template, 0, 0.0, 0.0);
            if (_model == null) throw Fail("NewDocument failed for template " + template, "begin");
            _title = _model.GetTitle();
            bool ok = _model.Extension.SetUserPreferenceInteger(
                (int)swUserPreferenceIntegerValue_e.swUnitsLinear, 0, (int)swLengthUnit_e.swMM);
            if (!ok) _log.Warn("could not set document length units to mm (API values are SI anyway)");
        }

        public string Begin(string partName)
        {
            string app = Connect();
            ResetDocState();
            _isAssembly = false;
            NewDoc((int)swUserPreferenceStringValue_e.swDefaultTemplatePart, "part");

            // base planes by TYPE ORDER: first three RefPlane features = Front, Top, Right (UNVERIFIED for custom templates)
            for (var f = (Feature?)_model!.FirstFeature(); f != null; f = (Feature?)f.GetNextFeature())
                if (f.GetTypeName2() == "RefPlane") _basePlanes.Add(f);
            if (_basePlanes.Count < 3) throw Fail("the part template has fewer than 3 reference planes", "begin");
            _log.Info("base planes by type order: " + _basePlanes[0].Name + ", " + _basePlanes[1].Name + ", " + _basePlanes[2].Name);
            return app;
        }

        public string BeginAssembly(string name)
        {
            string app = Connect();
            ResetDocState();
            _isAssembly = true;
            NewDoc((int)swUserPreferenceStringValue_e.swDefaultTemplateAssembly, "assembly");
            return app;
        }

        // ---------------------------------------------------------------- parameters and equations

        public bool AddParameter(ParameterPlan p)
        {
            // Global variable: "name" = 40mm. UNVERIFIED: EquationMgr.Add3 signature (Index, Equation, Solve, ConfigOption, ConfigNames)
            // and the unit suffix syntax.
            string unit = p.Unit == "mm" || p.Unit == "deg" ? p.Unit : "";
            string eq = "\"" + p.Name + "\" = " + p.Value.ToString("R", CultureInfo.InvariantCulture) + unit;
            return AddEquation(eq);
        }

        public bool BindDimension(string fullName, string swExpr) =>
            AddEquation("\"" + fullName + "\" = " + swExpr);

        bool AddEquation(string equation)
        {
            var em = Model().GetEquationMgr();
            em.IgnoreSolveOrder = false;
            int idx = em.Add3(-1, equation, true, (int)swInConfigurationOpts_e.swAllConfiguration, null);
            _log.Info("equation " + equation + " -> index " + idx);
            return idx >= 0;
        }

        // ---------------------------------------------------------------- planes and sketches

        /// <summary>Base plane, or a distance reference plane at offsetM from it along its normal. UNVERIFIED: InsertRefPlane args and distance sign.</summary>
        Feature GetPlane(SwBasePlane plane, double offsetM, string name)
        {
            var model = Model();
            Feature baseFeat = _basePlanes[PlaneMap.TypeOrderIndex(plane)];
            if (Math.Abs(offsetM) <= 1e-12) return baseFeat;
            model.ClearSelection2(true);
            if (!baseFeat.Select2(false, 0)) throw Fail("cannot select base plane for offset", "sketch");
            var rp = (Feature?)model.FeatureManager.InsertRefPlane(
                (int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance, offsetM, 0, 0, 0, 0);
            if (rp == null) throw Fail("InsertRefPlane failed for " + name, "sketch");
            rp.Name = name;
            model.ClearSelection2(true);
            return rp;
        }

        sealed class OpenSketch
        {
            public Func<double[], double[]> Tx = null!;
            public double[] O = null!;
            public double[] UImg = null!;
            public double[] VImg = null!;
            public short ArcDir;
        }

        OpenSketch Open(SketchPlan sk, FaceInfo? face)
        {
            var model = Model();
            var mu = _mu!;
            model.ClearSelection2(true);
            if (sk.Face != null)
            {
                if (face == null || face.Index < 0 || face.Index >= _lastFaces.Count) throw Fail("face for sketch " + sk.Name + " was not resolved", "sketch");
                // UNVERIFIED: Entity.Select4 on a Face2
                if (!((Entity)_lastFaces[face.Index]).Select4(false, null)) throw Fail("cannot select the face for sketch " + sk.Name, "sketch");
            }
            else
            {
                var planeFeat = GetPlane(sk.Plane, sk.OffsetM, sk.Name + ".plane");
                if (!planeFeat.Select2(false, 0)) throw Fail("cannot select the sketch plane", "sketch");
            }
            var sm = model.SketchManager;
            sm.InsertSketch(true);
            var sketch = sm.ActiveSketch;
            if (sketch == null) throw Fail("InsertSketch did not open a sketch", "sketch");
            var xf = (MathTransform)sketch.ModelToSketchTransform;

            double[] Tx(double[] worldM)
            {
                var p = (MathPoint)mu.CreatePoint(worldM);
                var q = (MathPoint)p.MultiplyTransform(xf);
                return (double[])q.ArrayData;
            }

            var o = Tx(sk.OriginM);
            if (!SketchMath.IsOnSketchPlane(o))
                throw Fail("sketch origin is not in the SolidWorks sketch plane (w=" + o[2].ToString("R", CultureInfo.InvariantCulture) +
                           " m): wrong base plane by type order, wrong offset sign or wrong face", "sketch");
            if (sk.Face == null && Math.Abs(sk.OffsetM) < 1e-12)
            {
                var expected = SketchMath.ExpectedSketchCoords(sk.Plane, sk.OriginM);
                if (!SketchMath.Near(o, expected))
                    _log.Warn("sketch transform differs from the predicted axes mapping; using SolidWorks' transform");
            }
            var ue = Tx(sk.UAxisEndM); var ve = Tx(sk.VAxisEndM);
            return new OpenSketch
            {
                Tx = Tx, O = o,
                UImg = new[] { ue[0] - o[0], ue[1] - o[1] },
                VImg = new[] { ve[0] - o[0], ve[1] - o[1] },
                ArcDir = SketchMath.ArcDirection(ue[0] - o[0], ue[1] - o[1], ve[0] - o[0], ve[1] - o[1]),
            };
        }

        Feature CloseAndRename(string name)
        {
            var model = Model();
            model.SketchManager.InsertSketch(true);     // leave the sketch
            var sf = (Feature?)model.FeatureByPositionReverse(0);
            if (sf == null || sf.GetTypeName2() != "ProfileFeature")
                throw Fail("could not find the new sketch feature after leaving the sketch", "sketch");
            Rename(sf, name);
            _features[name] = sf;
            model.ClearSelection2(true);
            return sf;
        }

        public void BuildSketch(SketchPlan sk, FaceInfo? face)
        {
            var model = Model();
            var sm = model.SketchManager;
            var os = Open(sk, face);
            var segs = new List<(GeomPlan g, SketchSegment seg)>();

            sm.AddToDB = true;     // draw without inference / relation solving
            try
            {
                foreach (var g in sk.Geometry)
                {
                    object? seg;
                    switch (g.Kind)
                    {
                        case GeomKind.Line:
                            {
                                var a = os.Tx(g.Start); var b = os.Tx(g.End);
                                seg = sm.CreateLine(a[0], a[1], 0, b[0], b[1], 0);
                                break;
                            }
                        case GeomKind.Circle:
                            {
                                var c = os.Tx(g.Center);
                                seg = sm.CreateCircleByRadius(c[0], c[1], 0, g.RadiusM);
                                break;
                            }
                        default:
                            {
                                var c = os.Tx(g.Center); var a = os.Tx(g.Start); var b = os.Tx(g.End);
                                seg = sm.CreateArc(c[0], c[1], 0, a[0], a[1], 0, b[0], b[1], 0, os.ArcDir);
                                break;
                            }
                    }
                    if (seg == null) throw Fail("sketch geometry (" + g.Kind + ") could not be created in " + sk.Name, "sketch");
                    segs.Add((g, (SketchSegment)seg));
                }
            }
            finally { sm.AddToDB = false; }

            AddDimensions(sk, os, segs);
            CloseAndRename(sk.Name);
        }

        // ---------------------------------------------------------------- sketch dimensions

        ExecException DimFail(SketchPlan sk, string dim, string why) =>
            new ExecException(ErrorCodes.ExecutorFailed, "sketch " + sk.Name + ": dimension " + dim + " failed: " + why, null, "sketch_dimension");

        void AddDimensions(SketchPlan sk, OpenSketch os, List<(GeomPlan g, SketchSegment seg)> segs)
        {
            var model = Model();
            foreach (var d in sk.Dimensions)
            {
                try
                {
                    model.ClearSelection2(true);
                    foreach (var r in d.Refs) SelectDimRef(r, segs);

                    // text position: near the first referenced geometry (sketch coordinates)
                    double[] pos = { 0.0, 0.0 };
                    var first = d.Refs[0];
                    var fg = segs.FirstOrDefault(s => s.g.SourceId == first.GeomId).g;
                    if (fg != null)
                    {
                        var p = os.Tx(fg.Kind == GeomKind.Line ? fg.Start : fg.Kind == GeomKind.Circle ? fg.Center : fg.Start);
                        pos = new[] { p[0] + 0.01, p[1] + 0.01 };
                    }

                    object? dd;
                    if (d.Kind == "distance_x" || d.Kind == "distance_y")
                    {
                        if (Math.Abs(os.UImg[0]) > 1e-9 && Math.Abs(os.UImg[1]) > 1e-9)
                            throw new InvalidOperationException("sketch axes are not axis aligned");
                        bool horizontal = SketchMath.IsHorizontalInSketch(d.Kind, os.UImg[0], os.UImg[1], os.VImg[0], os.VImg[1]);
                        dd = horizontal ? model.AddHorizontalDimension2(pos[0], pos[1], 0) : model.AddVerticalDimension2(pos[0], pos[1], 0);
                    }
                    else dd = model.AddDimension2(pos[0], pos[1], 0);
                    if (dd == null) throw new InvalidOperationException("SolidWorks did not create the dimension");

                    var dim = (Dimension)((DisplayDimension)dd).GetDimension2(0);
                    dim.Name = d.Name;
                    // The geometry already has this value: verify instead of overwriting it (nothing may move).
                    string srcType = fg?.SourceType ?? "";
                    double expected = SketchMath.ExpectedSwDimensionValue(d.Kind, srcType, d.ValueSi);
                    double actual = dim.SystemValue;
                    double tol = d.Kind == "angle" ? 1e-6 : 1e-7;
                    if (Math.Abs(actual - expected) > tol)
                        throw new InvalidOperationException("measured " + actual.ToString("R", CultureInfo.InvariantCulture) + " but expected " + expected.ToString("R", CultureInfo.InvariantCulture));
                    model.ClearSelection2(true);
                }
                catch (ExecException) { throw; }
                catch (Exception e) { throw DimFail(sk, d.Name, e.Message); }
            }
        }

        void SelectDimRef(DimRef r, List<(GeomPlan g, SketchSegment seg)> segs)
        {
            var model = Model();
            if (r.GeomId == -1)
            {
                // UNVERIFIED: origin point name/type
                if (!model.Extension.SelectByID2("Point1@Origin", "EXTSKETCHPOINT", 0, 0, 0, true, 0, null, 0))
                    throw new InvalidOperationException("cannot select the sketch origin");
                return;
            }
            var match = segs.FirstOrDefault(s => s.g.SourceId == r.GeomId);
            if (match.seg == null) throw new InvalidOperationException("geometry " + r.GeomId + " not drawn");
            object target;
            if (r.Pos == 0) target = match.seg;
            else
            {
                object? pt = null;
                if (match.seg is SketchLine ln) pt = r.Pos == 1 ? ln.GetStartPoint2() : r.Pos == 2 ? ln.GetEndPoint2() : null;
                else if (match.seg is SketchArc ar) pt = r.Pos == 1 ? ar.GetStartPoint2() : r.Pos == 2 ? ar.GetEndPoint2() : ar.GetCenterPoint2();
                if (pt == null) throw new InvalidOperationException("geometry " + r.GeomId + " has no point at position " + r.Pos);
                target = pt;
            }
            // UNVERIFIED: SketchSegment/SketchPoint.Select4(Append, Data)
            bool ok = target is SketchSegment ss ? ss.Select4(true, null) : ((SketchPoint)target).Select4(true, null);
            if (!ok) throw new InvalidOperationException("cannot select geometry " + r.GeomId + " position " + r.Pos);
        }

        public void ReuseSketch(string sketchName)
        {
            if (!_features.ContainsKey(sketchName)) throw Fail("sketch " + sketchName + " was not built earlier", "sketch");
        }

        // ---------------------------------------------------------------- extrude

        public void Extrude(ExtrudeStep s, FaceInfo? upTo)
        {
            var model = Model();
            var fm = model.FeatureManager;
            var sketchFeat = _features[s.Sketch.Name];
            model.ClearSelection2(true);
            if (!sketchFeat.Select2(false, 0)) throw Fail("cannot select sketch " + s.Sketch.Name, "extrude");

            int t1 = s.End == EndCondition.ThroughAll ? (int)swEndConditions_e.swEndCondThroughAll
                   : s.End == EndCondition.MidPlane ? (int)swEndConditions_e.swEndCondMidPlane
                   : s.End == EndCondition.UpToFace ? (int)swEndConditions_e.swEndCondUpToSurface
                   : (int)swEndConditions_e.swEndCondBlind;
            double d1 = (s.End == EndCondition.ThroughAll || s.End == EndCondition.UpToFace) ? 0.0 : s.DepthM;
            int t0 = (int)swStartConditions_e.swStartSketchPlane;

            if (s.End == EndCondition.UpToFace)
            {
                if (upTo == null || upTo.Index < 0 || upTo.Index >= _lastFaces.Count) throw Fail("up_to_face was not resolved", "extrude");
                // UNVERIFIED: end-condition reference face selected with mark 1 via SelectData
                var sd = model.SelectionManager.CreateSelectData();
                sd.Mark = 1;
                if (!((Entity)_lastFaces[upTo.Index]).Select4(true, sd)) throw Fail("cannot select the up-to face", "extrude");
            }

            Feature? f;
            if (!s.Cut)
            {
                // FeatureExtrusion3(Sd, Flip, Dir, T1, T2, D1, D2, Dchk1, Dchk2, Ddir1, Ddir2, Dang1, Dang2,
                //   OffsetReverse1, OffsetReverse2, TranslateSurface1, TranslateSurface2, Merge, UseFeatScope,
                //   UseAutoSelect, T0, StartOffset, FlipStartOffset)               -- 23 args, UNVERIFIED
                f = (Feature?)fm.FeatureExtrusion3(true, false, s.Reverse, t1, 0, d1, 0.0,
                    false, false, false, false, 0.0, 0.0, false, false, false, false,
                    true, false, true, t0, 0.0, false);
            }
            else
            {
                // FeatureCut4(... 27 args), UNVERIFIED
                f = (Feature?)fm.FeatureCut4(true, false, s.Reverse, t1, 0, d1, 0.0,
                    false, false, false, false, 0.0, 0.0, false, false, false, false,
                    false, false, true, true, true, true,
                    t0, 0.0, false, false);
            }
            if (f == null) throw Fail("SolidWorks refused the " + (s.Cut ? "cut" : "boss") + " extrude of " + s.FeatureName, "extrude");
            Rename(f, s.FeatureName);
            _features[s.FeatureName] = f;
            model.ClearSelection2(true);
        }

        // ---------------------------------------------------------------- hole wizard

        /// <summary>
        /// All Hole Wizard constants in one place. EVERY value here is a PLACEHOLDER (UNVERIFIED): record a Hole Wizard
        /// macro in the target SolidWorks version and copy the integers/strings. Plain through/blind holes fall back to a
        /// cut-extrude when HoleWizard5 returns null, with a warning in result.json.
        /// </summary>
        static class Hw
        {
            public const int TypeCounterbore = 0, TypeCountersink = 1, TypeHole = 2, TypeTap = 4;   // swWzdGeneralHoleTypes_e
            public const int StandardIso = 5;                                                       // swWzdHoleStandards_e (guess)
            public const int FastenerDrilledHole = 0;                                               // guess
            public const int FastenerTappedHole = 0;                                                // guess
        }

        public void Hole(HoleStep h, FaceInfo? face)
        {
            var model = Model();
            var fm = model.FeatureManager;

            // 1. placement sketch with POINTS at the hole centres
            var os = Open(h.Sketch, face);
            var sm = model.SketchManager;
            sm.AddToDB = true;
            try
            {
                foreach (var c in h.CentersWorldM)
                {
                    var p = os.Tx(c);
                    if (sm.CreatePoint(p[0], p[1], 0) == null) throw Fail("could not create hole position point in " + h.Sketch.Name, "hole");
                }
            }
            finally { sm.AddToDB = false; }
            var posSketch = CloseAndRename(h.Sketch.Name);

            // 2. Hole Wizard on the pre-selected position sketch (UNVERIFIED: selection of a point sketch)
            model.ClearSelection2(true);
            posSketch.Select2(false, 0);
            int generic = h.CosmeticThread ? Hw.TypeTap : h.CounterboreDiameterM > 0 ? Hw.TypeCounterbore : h.CountersinkDiameterM > 0 ? Hw.TypeCountersink : Hw.TypeHole;
            short endType = (short)(h.Through ? (int)swEndConditions_e.swEndCondThroughAll : (int)swEndConditions_e.swEndCondBlind);
            double v1 = h.CounterboreDiameterM > 0 ? h.CounterboreDiameterM : h.CountersinkDiameterM;     // head diameter   (guess)
            double v2 = h.CounterboreDiameterM > 0 ? h.CounterboreDepthM : Units.DegToRad(h.CountersinkAngleDeg);   // head depth / angle (guess)
            double v3 = Units.DegToRad(h.DrillPointAngleDeg);                                                  // drill point angle (guess)

            Feature? f = null;
            try
            {
                // HoleWizard5(GenericHoleType, StandardIndex, FastenerTypeIndex, SSize, EndType, Diameter, Depth, Length,
                //   Value1..Value12, ThreadClass, RevDir, FeatureScope, AutoSelect, AssemblyFeatureScope,
                //   AutoSelectComponents, PropagateFeatureToParts)                                  -- 27 args, UNVERIFIED
                f = (Feature?)fm.HoleWizard5(generic, Hw.StandardIso, Hw.FastenerDrilledHole, h.ThreadSize ?? "", endType,
                    h.DiameterM, h.Through ? 0.0 : h.DepthM, h.Through ? 0.0 : h.DepthM,
                    v1, v2, v3, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    "", h.Reverse, true, true, true, true, false);
            }
            catch (Exception e) { _log.Warn("HoleWizard5 threw: " + e.Message); }

            if (f == null)
            {
                if (!h.IsPlain || h.CounterboreDiameterM > 0 || h.CountersinkDiameterM > 0)
                    throw Fail("Hole Wizard failed for " + h.FeatureName + " and the hole has options (counterbore, countersink, thread or drill point) that a cut cannot reproduce", "hole");
                // fall back to circles + cut
                Warnings.Add(new WarningInfo { Feature = h.FeatureName, Reason = "Hole Wizard failed; hole built as a cut-extrude (the tree shows Cut-Extrude, not Hole)" });
                BuildHoleCut(h, face);
                return;
            }
            Rename(f, h.FeatureName);
            _features[h.FeatureName] = f;
            model.ClearSelection2(true);
        }

        void BuildHoleCut(HoleStep h, FaceInfo? face)
        {
            var circles = new SketchPlan
            {
                Name = h.Sketch.Name + ".cut", Plane = h.Sketch.Plane, OffsetM = h.Sketch.OffsetM, OriginM = h.Sketch.OriginM,
                UAxisEndM = h.Sketch.UAxisEndM, VAxisEndM = h.Sketch.VAxisEndM, Face = h.Sketch.Face, Geometry = h.Sketch.Geometry,
            };
            BuildSketch(circles, face);
            Extrude(new ExtrudeStep
            {
                FeatureName = h.FeatureName, TypeName = "hole", Sketch = circles, Cut = true,
                End = h.Through ? EndCondition.ThroughAll : EndCondition.Blind, DepthM = h.DepthM, Reverse = h.Reverse,
            }, null);
        }

        // ---------------------------------------------------------------- patterns, mirror

        public void Pattern(PatternStep s)
        {
            var model = Model();
            var fm = model.FeatureManager;
            Feature axis = GetAxis(s.AxisIndex);

            model.ClearSelection2(true);
            if (!axis.Select2(false, 1)) throw Fail("cannot select the pattern axis", "pattern");     // mark 1 = axis (UNVERIFIED)
            SelectOriginals(s.Originals, "pattern");
            // FeatureCircularPattern5(Number, Spacing, FlipDirection, DName, GeometryPattern, EqualSpacing,
            //   VaryInstance, SyncSubAssemblies, BDir2, BSymmetric, Number2, Spacing2, DName2, EqualSpacing2)  -- UNVERIFIED
            var f = (Feature?)fm.FeatureCircularPattern5(s.Count, s.SpacingRad, s.FlipDirection, "NULL",
                false, s.EqualSpacing, false, false, false, false, 1, 0.0, "NULL", false);
            if (f == null) throw Fail("FeatureCircularPattern5 failed for " + s.FeatureName, "pattern");
            Rename(f, s.FeatureName);
            _features[s.FeatureName] = f;
            model.ClearSelection2(true);
        }

        void SelectOriginals(List<string> names, string step)
        {
            foreach (var name in names)
            {
                if (!_features.TryGetValue(name, out var of)) throw Fail("original " + name + " was not built", step);
                if (!of.Select2(true, 4)) throw Fail("cannot select original " + name, step);   // mark 4 = features to pattern (UNVERIFIED)
            }
        }

        public void LinearPattern(LinearPatternStep s)
        {
            var model = Model();
            var fm = model.FeatureManager;
            Feature dirAxis = GetAxis(s.AxisIndex);      // direction reference: the world-axis reference axis (sign UNVERIFIED)
            model.ClearSelection2(true);
            if (!dirAxis.Select2(false, 1)) throw Fail("cannot select the pattern direction", "pattern");
            SelectOriginals(s.Originals, "pattern");
            // FeatureLinearPattern5(NumD1, SpacingD1, NumD2, SpacingD2, ReverseDirD1, ReverseDirD2, DName1, DName2,
            //   GeometryPattern, VaryInstance, HSyncSubAssemblies, BDir2, BSymmetric, ...)   -- argument list UNVERIFIED
            var f = (Feature?)fm.FeatureLinearPattern5(s.Count, s.SpacingM, 1, 0.0, s.Reverse, false, "NULL", "NULL",
                false, false, false, false, false, false, false);
            if (f == null) throw Fail("FeatureLinearPattern5 failed for " + s.FeatureName, "pattern");
            Rename(f, s.FeatureName);
            _features[s.FeatureName] = f;
            model.ClearSelection2(true);
        }

        public void Mirror(MirrorStep s)
        {
            var model = Model();
            var fm = model.FeatureManager;
            Feature plane = GetPlane(s.Plane, s.OffsetM, s.FeatureName + ".plane");
            model.ClearSelection2(true);
            foreach (var name in s.Originals)
            {
                if (!_features.TryGetValue(name, out var of)) throw Fail("mirror original " + name + " was not built", "mirror");
                if (!of.Select2(true, 1)) throw Fail("cannot select mirror original " + name, "mirror");     // mark 1 = features (UNVERIFIED)
            }
            if (!plane.Select2(true, 2)) throw Fail("cannot select the mirror plane", "mirror");              // mark 2 = plane (UNVERIFIED)
            // InsertMirrorFeature2(BMirrorBody, BGeometryPattern, BMerge, BKnit, ScopeOptions)  -- UNVERIFIED
            var f = (Feature?)fm.InsertMirrorFeature2(false, false, false, false, 0);
            if (f == null) throw Fail("InsertMirrorFeature2 failed for " + s.FeatureName, "mirror");
            Rename(f, s.FeatureName);
            _features[s.FeatureName] = f;
            model.ClearSelection2(true);
        }

        /// <summary>Reference axis = intersection of the two base planes whose normals are the other two world axes (axis passes through the origin).</summary>
        Feature GetAxis(int axisIndex)
        {
            if (_axes.TryGetValue(axisIndex, out var cached)) return cached;
            var model = Model();
            var planeForNormalAxis = new Dictionary<int, Feature>
            {
                { 2, _basePlanes[(int)SwBasePlane.Front] },
                { 1, _basePlanes[(int)SwBasePlane.Top] },
                { 0, _basePlanes[(int)SwBasePlane.Right] },
            };
            var sel = new List<Feature>();
            for (int n = 0; n < 3; n++) if (n != axisIndex) sel.Add(planeForNormalAxis[n]);
            model.ClearSelection2(true);
            if (!sel[0].Select2(false, 0) || !sel[1].Select2(true, 0)) throw Fail("cannot select base planes for the axis", "pattern");
            model.InsertAxis2(true);                           // UNVERIFIED
            var ax = (Feature?)model.FeatureByPositionReverse(0);
            if (ax == null || ax.GetTypeName2() != "RefAxis") throw Fail("InsertAxis2 did not create a reference axis", "pattern");
            _axes[axisIndex] = ax;
            model.ClearSelection2(true);
            return ax;
        }

        // ---------------------------------------------------------------- fillet / chamfer, edge and face queries

        PartDoc Part() => (PartDoc)Model();

        Body2 SolidBody()
        {
            var bodies = (object[]?)Part().GetBodies2((int)swBodyType_e.swSolidBody, true);
            if (bodies == null || bodies.Length == 0) throw Fail("the part has no solid body yet", "query");
            return (Body2)bodies[0];
        }

        public double DiagonalMm()
        {
            var b = (double[])SolidBody().GetBodyBox();   // [xlow,ylow,zlow,xhigh,yhigh,zhigh] meters (UNVERIFIED)
            double dx = b[3] - b[0], dy = b[4] - b[1], dz = b[5] - b[2];
            return Units.MToMm(Math.Sqrt(dx * dx + dy * dy + dz * dz));
        }

        public IReadOnlyList<EdgeInfo> GetEdges()
        {
            var res = new List<EdgeInfo>();
            _lastEdges = new List<Edge>();
            var edges = (object[]?)SolidBody().GetEdges();
            if (edges == null) return res;
            foreach (var o in edges)
            {
                var e = (Edge)o;
                var curve = (Curve?)e.GetCurve();
                if (curve == null) continue;
                // UNVERIFIED: Curve.GetEndParams, Evaluate2, GetLength3, CircleParams
                double s = 0, en = 0; bool closed = false, periodic = false;
                if (!curve.GetEndParams(out s, out en, out closed, out periodic)) continue;
                var mid = (double[])curve.Evaluate2((s + en) / 2.0, 0);
                var info = new EdgeInfo
                {
                    Index = _lastEdges.Count,
                    Midpoint = new[] { Units.MToMm(mid[0]), Units.MToMm(mid[1]), Units.MToMm(mid[2]) },
                    Length = Units.MToMm(curve.GetLength3(s, en)),
                };
                if (curve.IsLine()) info.Curve = "line";
                else if (curve.IsCircle())
                {
                    var cp = (double[])curve.CircleParams;     // [cx,cy,cz, ax,ay,az, r]
                    info.Curve = closed ? "circle" : "arc";
                    info.Centre = new[] { Units.MToMm(cp[0]), Units.MToMm(cp[1]), Units.MToMm(cp[2]) };
                    info.Radius = Units.MToMm(cp[6]);
                }
                else info.Curve = "other";
                res.Add(info);
                _lastEdges.Add(e);
            }
            return res;
        }

        public IReadOnlyList<FaceInfo> GetFaces()
        {
            var res = new List<FaceInfo>();
            _lastFaces = new List<Face2>();
            var faces = (object[]?)SolidBody().GetFaces();
            if (faces == null) return res;
            foreach (var o in faces)
            {
                var f = (Face2)o;
                var surf = (Surface?)f.GetSurface();
                bool planar = surf != null && surf.IsPlane();
                var info = new FaceInfo { Index = _lastFaces.Count, Planar = planar, Area = f.GetArea() * 1e6 };
                if (planar)
                {
                    var pp = (double[])surf!.PlaneParams;      // [nx,ny,nz, px,py,pz]  (UNVERIFIED layout)
                    var n = (double[])f.Normal;                // outward (accounts for face sense)
                    info.Normal = new[] { n[0], n[1], n[2] };
                    info.Origin = new[] { Units.MToMm(pp[3]), Units.MToMm(pp[4]), Units.MToMm(pp[5]) };
                }
                res.Add(info);
                _lastFaces.Add(f);
            }
            return res;
        }

        void SelectEdges(IReadOnlyList<EdgeInfo> edges, string step)
        {
            var model = Model();
            model.ClearSelection2(true);
            bool append = false;
            foreach (var e in edges)
            {
                bool ok = e.Index >= 0 && e.Index < _lastEdges.Count && ((Entity)_lastEdges[e.Index]).Select4(append, null);   // UNVERIFIED
                if (!ok)   // fallback: select by the point of the matched edge
                    ok = model.Extension.SelectByID2("", "EDGE", Units.MmToM(e.Midpoint[0]), Units.MmToM(e.Midpoint[1]), Units.MmToM(e.Midpoint[2]), append, 0, null, 0);
                if (!ok) throw Fail("cannot select a matched edge", step);
                append = true;
            }
        }

        public void Fillet(FilletStep s, IReadOnlyList<EdgeInfo> edges)
        {
            var model = Model();
            SelectEdges(edges, "fillet");
            // FeatureFillet3(Options, R1, Rho, Radius2, SetBackDistance, PointRadiusArray, PointDist2Array, PointDistArray,
            //   ..., 14 args as recorded by the macro recorder for a constant radius fillet)   -- UNVERIFIED, HIGH RISK
            var f = (Feature?)model.FeatureManager.FeatureFillet3(195, s.RadiusM, 0.0, 0.0, 0, 0, 0, null, null, null, null, null, null, null);
            if (f == null) throw Fail("FeatureFillet3 failed for " + s.FeatureName, "fillet");
            Rename(f, s.FeatureName);
            _features[s.FeatureName] = f;
            model.ClearSelection2(true);
        }

        public void Chamfer(ChamferStep s, IReadOnlyList<EdgeInfo> edges)
        {
            var model = Model();
            SelectEdges(edges, "chamfer");
            // InsertFeatureChamfer(Options, ChamferType, Width, Angle, OtherDist, VertexChamDist1..3)  -- UNVERIFIED
            // ChamferType 4 = equal distance (swChamferEqualDistance, UNVERIFIED value)
            var f = (Feature?)model.FeatureManager.InsertFeatureChamfer(0, 4, s.SizeM, 0.0, 0.0, 0.0, 0.0, 0.0);
            if (f == null) throw Fail("InsertFeatureChamfer failed for " + s.FeatureName, "chamfer");
            Rename(f, s.FeatureName);
            _features[s.FeatureName] = f;
            model.ClearSelection2(true);
        }

        // ---------------------------------------------------------------- measurement, material

        public double VolumeMm3()
        {
            var model = Model();
            var mp = model.Extension.CreateMassProperty();      // UNVERIFIED
            if (mp == null) throw Fail("CreateMassProperty returned null", "volume");
            mp.UseSystemUnits = true;
            return Units.M3ToMm3(mp.Volume);
        }

        public bool SetDensity(double kgPerM3)
        {
            try
            {
                var mp = Model().Extension.CreateMassProperty();
                mp.UseSystemUnits = true;
                double volM3 = mp.Volume;
                mp.OverrideMass = kgPerM3 * volM3;     // UNVERIFIED: IMassProperty.OverrideMass persists in the document
                return true;
            }
            catch (Exception e) { _log.Warn("SetDensity failed: " + e.Message); return false; }
        }

        // ---------------------------------------------------------------- output

        public void SaveNative(string path) => SaveAs(path, "save");

        public void ExportStep(string path)
        {
            // STEP AP214 (UNVERIFIED enum name: swUserPreferenceIntegerValue_e.swStepAP).
            try { _app!.SetUserPreferenceIntegerValue((int)swUserPreferenceIntegerValue_e.swStepAP, 214); }
            catch (Exception e) { _log.Warn("could not set STEP AP214: " + e.Message); }
            SaveAs(path, "export_step");
        }

        void SaveAs(string path, string step)
        {
            var model = Model();
            int err = 0, warn = 0;
            // UNVERIFIED: ModelDocExtension.SaveAs3 signature
            bool ok = model.Extension.SaveAs3(path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref err, ref warn);
            if (!ok || err != 0) throw Fail("SaveAs " + path + " failed (errors=" + err + ", warnings=" + warn + ")", step);
            _title = model.GetTitle();
        }

        public void Close()
        {
            if (_app == null) return;
            try
            {
                if (_model != null) _app.CloseDoc(_title ?? _model.GetTitle());   // CloseDoc never prompts to save
            }
            finally
            {
                _model = null;
                foreach (var t in _openedPartTitles)
                {
                    try { _app.CloseDoc(t); } catch (Exception e) { _log.Warn("closing " + t + " failed: " + e.Message); }
                }
                _openedPartTitles.Clear();
            }
        }

        // ---------------------------------------------------------------- assembly

        public void AddComponent(string partPath, OccurrencePlan occ)
        {
            if (!_isAssembly || _model == null) throw Fail("no assembly open", "add_component");
            var asm = (AssemblyDoc)_model;
            // The part must be loaded: open it silently first (UNVERIFIED OpenDoc6 usage).
            int e = 0, w = 0;
            var pdoc = (ModelDoc2?)_app!.OpenDoc6(partPath, (int)swDocumentTypes_e.swDocPART, (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref e, ref w);
            if (pdoc == null) throw Fail("cannot open " + partPath + " (error " + e + ")", "add_component");
            _openedPartTitles.Add(pdoc.GetTitle());
            _app.ActivateDoc3(_title ?? _model.GetTitle(), false, (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, ref e);

            // UNVERIFIED: AddComponent5 args (Name, ConfigOption, NewConfigName, UseConfigForPartReferencedInAssy, ExistingConfigName, X, Y, Z)
            var comp = (Component2?)asm.AddComponent5(partPath, (int)swAddComponentConfigOptions_e.swAddComponentConfigOptions_CurrentSelectedConfig,
                "", false, "", 0, 0, 0);
            if (comp == null) throw Fail("AddComponent5 failed for " + occ.Name, "add_component");
            // UNVERIFIED: MathTransform data layout (see TransformMath) and Component2.Transform2 setter
            comp.Transform2 = (MathTransform)_mu!.CreateTransform(occ.TransformArray);
            _log.Info("component " + comp.Name2 + " placed for occurrence " + occ.Name);
        }

        // ---------------------------------------------------------------- helpers

        ModelDoc2 Model() => _model ?? throw Fail("no open document", "internal");

        void Rename(Feature f, string semanticName)
        {
            // Semantic names contain '/'. UNVERIFIED that SolidWorks accepts that in feature names.
            f.Name = semanticName;
            if (f.Name != semanticName)
                _log.Warn("SolidWorks kept the name '" + f.Name + "' instead of '" + semanticName + "'");
        }
    }
}
