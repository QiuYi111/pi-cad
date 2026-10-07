using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
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
        MathUtility? _mu;

        public SwPartBuilder(JobLog log) { _log = log; }

        static ExecException Fail(string msg, string step) => new ExecException(ErrorCodes.ExecutorFailed, msg, null, step);

        // ---------------------------------------------------------------- session

        public string Begin(string partName)
        {
            // 1. attach to a running SolidWorks, else start one. (First export starts SW: slow, 30 s+.)
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
                _app.Visible = true;     // UNVERIFIED: needed so a started instance is usable / the user can see dialogs
                _log.Info("started a new SolidWorks instance");
            }
            // Tell SW this is API-driven (UNVERIFIED effect). Modal dialogs still block every COM call.
            try { _app.UserControl = false; } catch (Exception e) { _log.Warn("UserControl=false failed: " + e.Message); }

            // 2. new part from the default part template
            string template = _app.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swDefaultTemplatePart);
            if (string.IsNullOrEmpty(template)) throw Fail("SolidWorks has no default part template configured", "begin");
            _model = (ModelDoc2?)_app.NewDocument(template, 0, 0.0, 0.0);
            if (_model == null) throw Fail("NewDocument failed for template " + template, "begin");
            _title = _model.GetTitle();
            _mu = (MathUtility)_app.GetMathUtility();

            // 3. document units: mm
            bool ok = _model.Extension.SetUserPreferenceInteger(
                (int)swUserPreferenceIntegerValue_e.swUnitsLinear, 0, (int)swLengthUnit_e.swMM);
            if (!ok) _log.Warn("could not set document length units to mm (API values are SI anyway)");

            // 4. base planes by TYPE ORDER: first three RefPlane features = Front, Top, Right (UNVERIFIED for custom templates)
            for (var f = (Feature?)_model.FirstFeature(); f != null; f = (Feature?)f.GetNextFeature())
            {
                if (f.GetTypeName2() == "RefPlane") _basePlanes.Add(f);
            }
            if (_basePlanes.Count < 3) throw Fail("the part template has fewer than 3 reference planes", "begin");
            _log.Info("base planes by type order: " + _basePlanes[0].Name + ", " + _basePlanes[1].Name + ", " + _basePlanes[2].Name);

            return "SOLIDWORKS " + (_app.RevisionNumber() ?? "?");   // e.g. "31.0.0.0063"; UNVERIFIED format
        }

        // ---------------------------------------------------------------- sketches

        public void BuildSketch(SketchPlan sk)
        {
            var model = Model();
            var mu = _mu!;
            Feature baseFeat = _basePlanes[PlaneMap.TypeOrderIndex(sk.Plane)];
            Feature planeFeat = baseFeat;

            model.ClearSelection2(true);
            if (Math.Abs(sk.OffsetM) > 1e-12)
            {
                // Offset plane: select the base plane and insert a distance reference plane.
                // UNVERIFIED: sign of the distance (assumed positive along the base plane normal) and the
                // argument order of InsertRefPlane (FirstConstraint, FirstConstraintAngleOrDistance, Second..., Third...).
                if (!baseFeat.Select2(false, 0)) throw Fail("cannot select base plane for offset", "sketch");
                var rp = (Feature?)model.FeatureManager.InsertRefPlane(
                    (int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance, sk.OffsetM, 0, 0, 0, 0);
                if (rp == null) throw Fail("InsertRefPlane failed for sketch " + sk.Name, "sketch");
                rp.Name = sk.Name + ".plane";
                planeFeat = rp;
                model.ClearSelection2(true);
            }

            if (!planeFeat.Select2(false, 0)) throw Fail("cannot select the sketch plane", "sketch");
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

            // Fallback / consistency checks on the plane choice and on the transform.
            var o = Tx(sk.OriginM);
            if (!SketchMath.IsOnSketchPlane(o))
                throw Fail("sketch origin is not in the SolidWorks sketch plane (w=" + o[2].ToString("R", CultureInfo.InvariantCulture) +
                           " m): wrong base plane by type order or wrong offset sign", "sketch");
            if (Math.Abs(sk.OffsetM) < 1e-12)
            {
                var expected = SketchMath.ExpectedSketchCoords(sk.Plane, sk.OriginM);
                if (!SketchMath.Near(o, expected))
                    _log.Warn("sketch transform differs from the predicted axes mapping; using SolidWorks' transform");
            }
            var ue = Tx(sk.UAxisEndM); var ve = Tx(sk.VAxisEndM);
            short dir = SketchMath.ArcDirection(ue[0] - o[0], ue[1] - o[1], ve[0] - o[0], ve[1] - o[1]);

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
                                var a = Tx(g.Start); var b = Tx(g.End);
                                seg = sm.CreateLine(a[0], a[1], 0, b[0], b[1], 0);
                                break;
                            }
                        case GeomKind.Circle:
                            {
                                var c = Tx(g.Center);
                                seg = sm.CreateCircleByRadius(c[0], c[1], 0, g.RadiusM);
                                break;
                            }
                        default:
                            {
                                var c = Tx(g.Center); var a = Tx(g.Start); var b = Tx(g.End);
                                seg = sm.CreateArc(c[0], c[1], 0, a[0], a[1], 0, b[0], b[1], 0, dir);
                                break;
                            }
                    }
                    if (seg == null) throw Fail("sketch geometry (" + g.Kind + ") could not be created in " + sk.Name, "sketch");
                }
            }
            finally { sm.AddToDB = false; }

            sm.InsertSketch(true);     // leave the sketch
            var sf = (Feature?)model.FeatureByPositionReverse(0);
            if (sf == null || sf.GetTypeName2() != "ProfileFeature")
                throw Fail("could not find the new sketch feature after leaving the sketch", "sketch");
            Rename(sf, sk.Name);
            _features[sk.Name] = sf;
            model.ClearSelection2(true);
        }

        public void ReuseSketch(string sketchName)
        {
            if (!_features.ContainsKey(sketchName)) throw Fail("sketch " + sketchName + " was not built earlier", "sketch");
        }

        // ---------------------------------------------------------------- features

        public void Extrude(ExtrudeStep s)
        {
            var model = Model();
            var fm = model.FeatureManager;
            var sketchFeat = _features[s.Sketch.Name];
            model.ClearSelection2(true);
            if (!sketchFeat.Select2(false, 0)) throw Fail("cannot select sketch " + s.Sketch.Name, "extrude");

            int t1 = s.End == EndCondition.ThroughAll ? (int)swEndConditions_e.swEndCondThroughAll
                   : s.End == EndCondition.MidPlane ? (int)swEndConditions_e.swEndCondMidPlane
                   : (int)swEndConditions_e.swEndCondBlind;
            double d1 = s.End == EndCondition.ThroughAll ? 0.0 : s.DepthM;   // MidPlane: D1 is the TOTAL depth (UNVERIFIED)
            int t0 = (int)swStartConditions_e.swStartSketchPlane;

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
                // FeatureCut4(Sd, Flip, Dir, T1, T2, D1, D2, Dchk1, Dchk2, Ddir1, Ddir2, Dang1, Dang2,
                //   OffsetReverse1, OffsetReverse2, TranslateSurface1, TranslateSurface2, NormalCut, UseFeatScope,
                //   UseAutoSelect, AssemblyFeatureScope, AutoSelectComponents, PropagateFeatureToParts,
                //   T0, StartOffset, FlipStartOffset, OptimizeGeometry)           -- 27 args, UNVERIFIED
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

        public void Pattern(PatternStep s)
        {
            var model = Model();
            var fm = model.FeatureManager;
            Feature axis = GetAxis(s.AxisIndex);

            model.ClearSelection2(true);
            if (!axis.Select2(false, 1)) throw Fail("cannot select the pattern axis", "pattern");     // mark 1 = axis (UNVERIFIED)
            foreach (var name in s.Originals)
            {
                if (!_features.TryGetValue(name, out var of)) throw Fail("pattern original " + name + " was not built", "pattern");
                if (!of.Select2(true, 4)) throw Fail("cannot select pattern original " + name, "pattern");   // mark 4 = features to pattern (UNVERIFIED)
            }
            // FeatureCircularPattern5(Number, Spacing, FlipDirection, DName, GeometryPattern, EqualSpacing,
            //   VaryInstance, SyncSubAssemblies, BDir2, BSymmetric, Number2, Spacing2, DName2, EqualSpacing2)  -- UNVERIFIED
            var f = (Feature?)fm.FeatureCircularPattern5(s.Count, s.SpacingRad, s.FlipDirection, "NULL",
                false, s.EqualSpacing, false, false, false, false, 1, 0.0, "NULL", false);
            if (f == null) throw Fail("FeatureCircularPattern5 failed for " + s.FeatureName, "pattern");
            Rename(f, s.FeatureName);
            _features[s.FeatureName] = f;
            model.ClearSelection2(true);
        }

        /// <summary>Reference axis = intersection of the two base planes whose normals are the other two world axes (axis passes through the origin).</summary>
        Feature GetAxis(int axisIndex)
        {
            if (_axes.TryGetValue(axisIndex, out var cached)) return cached;
            var model = Model();
            // plane index (type order) by its SW normal axis: Front->Z(2), Top->Y(1), Right->X(0)
            // The axis runs along world axis A; use the two planes whose normals are NOT A.
            var planeForNormalAxis = new Dictionary<int, Feature>
            {
                { 2, _basePlanes[(int)SwBasePlane.Front] },
                { 1, _basePlanes[(int)SwBasePlane.Top] },
                { 0, _basePlanes[(int)SwBasePlane.Right] },
            };
            var sel = new List<Feature>();
            for (int n = 0; n < 3; n++) if (n != axisIndex) sel.Add(planeForNormalAxis[n]);
            model.ClearSelection2(true);
            if (!sel[0].Select2(false, 0) || !sel[1].Select2(true, 0)) throw Fail("cannot select base planes for the pattern axis", "pattern");
            model.InsertAxis2(true);                           // UNVERIFIED: creates axis from two selected planes
            var ax = (Feature?)model.FeatureByPositionReverse(0);
            if (ax == null || ax.GetTypeName2() != "RefAxis") throw Fail("InsertAxis2 did not create a reference axis", "pattern");
            _axes[axisIndex] = ax;
            model.ClearSelection2(true);
            return ax;
        }

        public double VolumeMm3()
        {
            var model = Model();
            // UNVERIFIED: ModelDocExtension.CreateMassProperty / MassProperty.Volume (m^3 with UseSystemUnits)
            var mp = model.Extension.CreateMassProperty();
            if (mp == null) throw Fail("CreateMassProperty returned null", "volume");
            mp.UseSystemUnits = true;
            return Units.M3ToMm3(mp.Volume);
        }

        // ---------------------------------------------------------------- output

        public void SaveNative(string path)
        {
            var model = Model();
            int err = 0, warn = 0;
            // UNVERIFIED: ModelDocExtension.SaveAs3 signature (Name, Version, Options, ExportData, AdvancedSaveAsOptions, ref Errors, ref Warnings)
            bool ok = model.Extension.SaveAs3(path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref err, ref warn);
            if (!ok || err != 0) throw Fail("SaveAs " + path + " failed (errors=" + err + ", warnings=" + warn + ")", "save");
            _title = model.GetTitle();
        }

        public void ExportStep(string path)
        {
            var model = Model();
            // STEP AP214 (UNVERIFIED enum name: swUserPreferenceIntegerValue_e.swStepAP).
            try { _app!.SetUserPreferenceIntegerValue((int)swUserPreferenceIntegerValue_e.swStepAP, 214); }
            catch (Exception e) { _log.Warn("could not set STEP AP214: " + e.Message); }
            int err = 0, warn = 0;
            bool ok = model.Extension.SaveAs3(path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref err, ref warn);
            if (!ok || err != 0) throw Fail("STEP export to " + path + " failed (errors=" + err + ", warnings=" + warn + ")", "export_step");
        }

        public void Close()
        {
            if (_app == null || _model == null) return;
            try
            {
                // CloseDoc never prompts to save, so the session is not left with a dirty/modal document.
                _app.CloseDoc(_title ?? _model.GetTitle());
            }
            finally { _model = null; }
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
