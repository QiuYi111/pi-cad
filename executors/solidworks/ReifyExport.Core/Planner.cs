using System;
using System.Collections.Generic;
using System.Linq;

namespace Reify.Export
{
    public sealed class WarningInfo
    {
        [System.Text.Json.Serialization.JsonPropertyName("feature")] public string? Feature { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("field")] public string? Field { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("expr")] public string? Expr { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("reason")] public string Reason { get; set; } = "";
        public override string ToString() => (Feature ?? "-") + (Field != null ? "." + Field : "") + ": " + Reason;
    }

    public static class Planner
    {
        public const string SupportedSchema = "reify.features/1";
        const double ParallelTol = 1e-6;

        static readonly HashSet<string> DimKinds = new HashSet<string> { "distance", "distance_x", "distance_y", "radius", "diameter", "angle" };

        sealed class Ctx
        {
            public Dictionary<string, SketchDef> Sketches = new Dictionary<string, SketchDef>();
            public HashSet<string> UsedSketches = new HashSet<string>();
            public HashSet<string> Features = new HashSet<string>();
            public Dictionary<string, double> Names = new Dictionary<string, double>();
            public Plan Plan = new Plan();

            public void Warn(string? feature, string? field, string? expr, string reason) =>
                Plan.Warnings.Add(new WarningInfo { Feature = feature, Field = field, Expr = expr, Reason = reason });

            /// <summary>
            /// Value of a scalar. If it has an expression in the supported grammar that evaluates to the exported value,
            /// a Binding (equation) is added to 'into'. Otherwise the exported value is used and a warning is recorded.
            /// Never throws for expression problems: a feature is never skipped because of its expression.
            /// </summary>
            public double Scalar(Dim d, string feature, string field, List<Binding>? into, string? fullName)
            {
                if (string.IsNullOrWhiteSpace(d.Expr)) return d.Value;
                try
                {
                    var node = ExprParser.Parse(d.Expr!);
                    double v = node.Eval(Names);
                    if (Math.Abs(v - d.Value) > 1e-6 * Math.Max(1.0, Math.Abs(d.Value)))
                    {
                        Warn(feature, field, d.Expr, "expression evaluates to " + v + " but the exported value is " + d.Value + "; using the value");
                    }
                    else if (into == null || fullName == null)
                    {
                        Warn(feature, field, d.Expr, "this dimension is not bound to an equation by the SolidWorks executor; using the value");
                    }
                    else
                    {
                        into.Add(new Binding { Field = field, FullName = fullName, SwExpr = node.ToSw(), Value = d.Value });
                    }
                }
                catch (ExprException e)
                {
                    Warn(feature, field, d.Expr, e.Message + "; using the value");
                }
                return d.Value;
            }
        }

        /// <summary>
        /// Validate the whole file and produce the ordered steps. Nothing touches SolidWorks here, so every
        /// unsupported construct is reported (UNSUPPORTED_OP, naming the feature) before a part is created.
        ///
        /// Profiles / nested contours: every geometry element of a canonical sketch is drawn into ONE
        /// SolidWorks sketch, the sketch feature is pre-selected and FeatureExtrusion3 / FeatureCut4 is called.
        /// SolidWorks then forms the regions itself from the closed contours. Depth 0 loops with depth 1 loops
        /// inside (plate with holes) equal the even-odd rule of the protocol. Depth >= 2 (island inside a hole)
        /// stays REJECTED with UNSUPPORTED_OP: how SolidWorks treats it with a whole-sketch pre-selection cannot be
        /// confirmed without running it, and splitting it into several features would change the feature tree.
        /// </summary>
        public static Plan Build(FeatureFile f)
        {
            if (f == null) throw new ExecException(ErrorCodes.ExecutorFailed, "no features in job", null, "plan");
            if (f.Schema != SupportedSchema)
                throw new ExecException(ErrorCodes.ExecutorFailed, "unsupported feature schema '" + f.Schema + "'", null, "plan");
            if (f.Units != "mm")
                throw new ExecException(ErrorCodes.ExecutorFailed, "units must be 'mm', got '" + f.Units + "'", null, "plan");
            if (f.Bodies.Count != 1)
                throw ExecException.Unsupported(f.Part, "exactly one body is supported, got " + f.Bodies.Count);

            var body = f.Bodies[0];
            var cx = new Ctx();
            var plan = cx.Plan;
            plan.PartName = string.IsNullOrEmpty(f.Part) ? body.Name : f.Part;

            foreach (var p in f.Parameters)
            {
                if (string.IsNullOrEmpty(p.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "parameter without a name", null, "plan");
                if (cx.Names.ContainsKey(p.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "duplicate parameter " + p.Name, null, "plan");
                cx.Names[p.Name] = p.Value;
                plan.Parameters.Add(new ParameterPlan { Name = p.Name, Value = p.Value, Unit = p.Unit ?? "" });
            }
            if (f.Material != null)
            {
                if (!(f.Material.DensityKgM3 > 0)) throw new ExecException(ErrorCodes.ExecutorFailed, "material.density_kg_m3 must be positive", null, "plan");
                plan.DensityKgM3 = f.Material.DensityKgM3;
            }

            foreach (var s in body.Sketches)
            {
                if (cx.Sketches.ContainsKey(s.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "duplicate sketch name " + s.Name, s.Name, "plan");
                cx.Sketches[s.Name] = s;
            }

            foreach (var feat in body.Features)
            {
                if (string.IsNullOrEmpty(feat.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "feature without a name", null, "plan");
                if (!cx.Features.Add(feat.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "duplicate feature name " + feat.Name, feat.Name, "plan");

                switch (feat.Type)
                {
                    case "pad":
                    case "pocket":
                        plan.Steps.Add(PlanExtrude(feat, cx));
                        break;
                    case "hole":
                        plan.Steps.Add(PlanHole(feat, cx));
                        break;
                    case "polar_pattern":
                        plan.Steps.Add(PlanPattern(feat, cx));
                        break;
                    case "linear_pattern":
                        plan.Steps.Add(PlanLinearPattern(feat, cx));
                        break;
                    case "mirror":
                        plan.Steps.Add(PlanMirror(feat, cx));
                        break;
                    case "fillet":
                    case "chamfer":
                        plan.Steps.Add(PlanEdgeFeature(feat, cx));
                        break;
                    default:
                        throw ExecException.Unsupported(feat.Name, "feature type '" + feat.Type + "' is not supported by the SolidWorks executor");
                }
            }
            if (plan.DensityKgM3 != null)
                cx.Warn(null, "material", null, "density is applied as a mass override (mass = density x volume); the SolidWorks material itself is not set");
            return plan;
        }

        // ------------------------------------------------------------------ extrude (pad / pocket)

        static ExtrudeStep PlanExtrude(FeatureDef feat, Ctx cx)
        {
            var sk = LookupSketch(feat, cx);
            var step = new ExtrudeStep { FeatureName = feat.Name, TypeName = feat.Type, Cut = feat.Type != "pad" };

            var ext = feat.Extent;
            if (ext == null) throw ExecException.Unsupported(feat.Name, "feature has no extent");
            if (ext.Type == "length")
            {
                if (ext.Length == null) throw ExecException.Unsupported(feat.Name, "extent length missing");
                double mm = cx.Scalar(ext.Length, feat.Name, "depth", step.Bindings, "D1@" + feat.Name);
                if (!(mm > 0)) throw ExecException.Unsupported(feat.Name, "extent length must be positive");
                step.DepthM = Units.MmToM(mm);
                step.End = feat.Midplane ? EndCondition.MidPlane : EndCondition.Blind;
            }
            else if (ext.Type == "through_all" && feat.Type == "pocket")
            {
                if (feat.Midplane) throw ExecException.Unsupported(feat.Name, "midplane together with through_all is not supported");
                step.End = EndCondition.ThroughAll;
            }
            else if (ext.Type == "up_to_face" && feat.Type == "pad")
            {
                if (ext.FaceRef == null) throw ExecException.Unsupported(feat.Name, "up_to_face without face_ref");
                if (feat.Midplane) throw ExecException.Unsupported(feat.Name, "midplane together with up_to_face is not supported");
                ValidateFaceRef(ext.FaceRef, feat.Name);
                step.End = EndCondition.UpToFace;
                step.UpToFace = ext.FaceRef;
            }
            else
            {
                throw ExecException.Unsupported(feat.Name, "extent type '" + ext.Type + "' is not supported for " + feat.Type);
            }

            double[] nSw;
            step.Sketch = PlanSketch(sk, feat.Name, cx, out nSw);
            step.ReuseSketch = !cx.UsedSketches.Add(sk.Name);
            step.Reverse = DecideReverse(step.Cut, step.End, feat.Direction, nSw, feat.Name);
            return step;
        }

        static SketchDef LookupSketch(FeatureDef feat, Ctx cx)
        {
            if (feat.Sketch == null || !cx.Sketches.TryGetValue(feat.Sketch, out var sk))
                throw new ExecException(ErrorCodes.ExecutorFailed, "feature references unknown sketch '" + feat.Sketch + "'", feat.Name, "plan");
            return sk;
        }

        static void ValidateFaceRef(FaceRefDef r, string feature)
        {
            if (!Vec.IsFinite3(r.Origin) || !Vec.IsFinite3(r.Normal) || Vec.Len(r.Normal) < 1e-9 || !(r.Area > 0))
                throw ExecException.Unsupported(feature, "face_ref is incomplete (origin, normal, area > 0 are required)");
        }

        /// <summary>Reverse flag for the SW "Dir" argument. Pad default = +normal. Cut default = per PlanConventions.</summary>
        public static bool DecideReverse(bool cut, EndCondition end, double[]? direction, double[] nSw, string featureName)
        {
            if (end == EndCondition.MidPlane) return false;
            if (!Vec.IsFinite3(direction) || Vec.Len(direction!) < 1e-9)
                throw ExecException.Unsupported(featureName, "feature has no usable direction");
            double d = Vec.Dot(Vec.Unit(direction!), nSw);
            if (Math.Abs(Math.Abs(d) - 1.0) > ParallelTol)
                throw ExecException.Unsupported(featureName, "extrusion direction is not parallel to the sketch normal (oblique extrusion is not supported)");
            bool wantPlus = d > 0;
            bool defaultPlus = !cut || !PlanConventions.CutDefaultsToMinusNormal;
            return wantPlus != defaultPlus;
        }

        // ------------------------------------------------------------------ hole

        static HoleStep PlanHole(FeatureDef feat, Ctx cx)
        {
            var sk = LookupSketch(feat, cx);
            var step = new HoleStep { FeatureName = feat.Name, TypeName = "hole" };
            var ext = feat.Extent;
            if (ext == null) throw ExecException.Unsupported(feat.Name, "hole has no extent");
            if (feat.Midplane) throw ExecException.Unsupported(feat.Name, "midplane is not supported for holes");
            if (ext.Type == "through_all") step.Through = true;
            else if (ext.Type == "blind")
            {
                if (ext.Depth == null) throw ExecException.Unsupported(feat.Name, "blind hole without depth");
                double mm = cx.Scalar(ext.Depth, feat.Name, "depth", null, null);
                if (!(mm > 0)) throw ExecException.Unsupported(feat.Name, "blind hole depth must be positive");
                step.DepthM = Units.MmToM(mm);
            }
            else throw ExecException.Unsupported(feat.Name, "hole extent '" + ext.Type + "' is not supported");

            if (feat.Thread != null)
            {
                if (feat.Thread.Modeled) throw ExecException.Unsupported(feat.Name, "modeled threads are not supported (cosmetic only)");
                step.CosmeticThread = true;
                step.ThreadStandard = feat.Thread.Standard;
                step.ThreadSize = feat.Thread.Size;
                if (string.IsNullOrEmpty(feat.Thread.Size)) throw ExecException.Unsupported(feat.Name, "thread without size");
            }
            if (feat.Counterbore != null && feat.Countersink != null)
                throw ExecException.Unsupported(feat.Name, "counterbore together with countersink is not supported");

            // circles = hole centres
            foreach (var g in sk.Geometry)
                if (g.Type != "circle") throw ExecException.Unsupported(feat.Name, "hole sketch " + sk.Name + " may only contain circles, found '" + g.Type + "'");
            if (sk.Geometry.Count == 0) throw ExecException.Unsupported(feat.Name, "hole sketch has no circles");
            double dia;
            if (feat.Diameter != null) dia = cx.Scalar(feat.Diameter, feat.Name, "diameter", null, null);
            else dia = 2 * sk.Geometry[0].Radius!.Value;
            if (!(dia > 0)) throw ExecException.Unsupported(feat.Name, "hole diameter must be positive");
            foreach (var g in sk.Geometry)
                if (g.Radius != null && Math.Abs(2 * g.Radius.Value - dia) > 1e-6 * Math.Max(1, dia))
                    throw ExecException.Unsupported(feat.Name, "hole sketch circles have different diameters than the hole diameter " + dia);
            step.DiameterM = Units.MmToM(dia);

            if (feat.Counterbore != null)
            {
                if (feat.Counterbore.Diameter == null || feat.Counterbore.Depth == null) throw ExecException.Unsupported(feat.Name, "counterbore needs diameter and depth");
                double cd = cx.Scalar(feat.Counterbore.Diameter, feat.Name, "counterbore.diameter", null, null);
                double cdp = cx.Scalar(feat.Counterbore.Depth, feat.Name, "counterbore.depth", null, null);
                if (!(cd > dia) || !(cdp > 0)) throw ExecException.Unsupported(feat.Name, "counterbore must be wider than the hole and have positive depth");
                step.CounterboreDiameterM = Units.MmToM(cd); step.CounterboreDepthM = Units.MmToM(cdp);
            }
            if (feat.Countersink != null)
            {
                if (feat.Countersink.Diameter == null || feat.Countersink.AngleDeg == null) throw ExecException.Unsupported(feat.Name, "countersink needs diameter and angle_deg");
                double cd = cx.Scalar(feat.Countersink.Diameter, feat.Name, "countersink.diameter", null, null);
                double ca = feat.Countersink.AngleDeg.Value;
                if (!(cd > dia) || !(ca > 0 && ca < 180)) throw ExecException.Unsupported(feat.Name, "countersink must be wider than the hole and have an angle between 0 and 180 degrees");
                step.CountersinkDiameterM = Units.MmToM(cd); step.CountersinkAngleDeg = ca;
            }
            if (!step.Through && feat.DrillPoint != null)
            {
                if (feat.DrillPoint.Type == "angled") step.DrillPointAngleDeg = feat.DrillPoint.AngleDeg ?? 118.0;
                else if (feat.DrillPoint.Type == "flat") step.DrillPointAngleDeg = 0;
                else throw ExecException.Unsupported(feat.Name, "drill_point type '" + feat.DrillPoint.Type + "' is not supported");
                if (step.DrillPointAngleDeg < 0 || step.DrillPointAngleDeg >= 180) throw ExecException.Unsupported(feat.Name, "drill point angle out of range");
            }
            if (feat.Diameter?.Expr != null || ext.Depth?.Expr != null)
                { /* warnings were added by Scalar: hole dimensions are not bound */ }

            double[] nSw;
            step.Sketch = PlanSketch(sk, feat.Name, cx, out nSw);
            if (!cx.UsedSketches.Add(sk.Name)) throw ExecException.Unsupported(feat.Name, "hole sketch " + sk.Name + " is shared with another feature");
            foreach (var g in step.Sketch.Geometry) step.CentersWorldM.Add(g.Center);
            step.Reverse = DecideReverse(true, EndCondition.Blind, feat.Direction, nSw, feat.Name);
            return step;
        }

        // ------------------------------------------------------------------ sketches

        static SketchPlan PlanSketch(SketchDef sk, string featureName, Ctx cx, out double[] nSw)
        {
            var fr = sk.Frame;
            if (!Vec.IsFinite3(fr.Origin) || !Vec.IsFinite3(fr.U) || !Vec.IsFinite3(fr.V) || !Vec.IsFinite3(fr.N))
                throw new ExecException(ErrorCodes.ExecutorFailed, "sketch frame of " + sk.Name + " is incomplete", featureName, "plan");

            SwBasePlane plane = SwBasePlane.Front;
            double offsetMm = 0;
            if (sk.FaceRef != null)
            {
                ValidateFaceRef(sk.FaceRef, featureName);
                nSw = Vec.Unit(sk.FaceRef.Normal);
                if (Math.Abs(Math.Abs(Vec.Dot(Vec.Unit(fr.N), nSw)) - 1.0) > ParallelTol)
                    throw ExecException.Unsupported(featureName, "sketch frame normal is not parallel to its face_ref normal");
            }
            else
            {
                try { plane = PlaneMap.FromCanonical(sk.Plane.Base); }
                catch (ArgumentException e) { throw ExecException.Unsupported(featureName, e.Message); }
                nSw = PlaneMap.Normal(plane);
                if (Math.Abs(Math.Abs(Vec.Dot(Vec.Unit(fr.N), nSw)) - 1.0) > ParallelTol)
                    throw ExecException.Unsupported(featureName, "sketch normal is not parallel to base plane " + sk.Plane.Base);
                offsetMm = Vec.Dot(fr.Origin, nSw);
                if (Math.Abs(Math.Abs(offsetMm) - Math.Abs(sk.Plane.Offset)) > 1e-6)
                    cx.Warn(featureName, null, null, sk.Name + ": frame origin distance " + offsetMm + " mm differs from plane.offset " + sk.Plane.Offset + " mm; the frame origin wins");
            }

            foreach (var l in sk.Loops)
            {
                if (!l.Closed) throw ExecException.Unsupported(featureName, "sketch " + sk.Name + " has an open loop");
                if (l.Depth >= 2)
                    throw ExecException.Unsupported(featureName, "sketch " + sk.Name + " has a loop nested at depth " + l.Depth +
                        " (island inside a hole); nesting deeper than 1 is not supported by the SolidWorks executor");
            }
            return BuildSketchPlan(sk, plane, offsetMm, featureName, cx);
        }

        static SketchPlan BuildSketchPlan(SketchDef sk, SwBasePlane plane, double offsetMm, string featureName, Ctx cx)
        {
            var fr = sk.Frame;
            var sp = new SketchPlan
            {
                Name = sk.Name,
                Plane = plane,
                OffsetM = Math.Abs(offsetMm) < 1e-9 ? 0.0 : Units.MmToM(offsetMm),
                OriginM = SketchMath.ToWorldM(fr, 0, 0),
                UAxisEndM = SketchMath.ToWorldM(fr, 1, 0),
                VAxisEndM = SketchMath.ToWorldM(fr, 0, 1),
                Face = sk.FaceRef,
            };
            foreach (var g in sk.Geometry)
            {
                switch (g.Type)
                {
                    case "line":
                        sp.Geometry.Add(Line(fr, Pt(g.Start, featureName, g), Pt(g.End, featureName, g), g));
                        break;
                    case "polyline":
                        {
                            if (g.Points == null || g.Points.Length < 2) throw ExecException.Unsupported(featureName, "polyline " + g.Id + " has fewer than 2 points");
                            for (int i = 0; i + 1 < g.Points.Length; i++) sp.Geometry.Add(Line(fr, g.Points[i], g.Points[i + 1], g));
                            if (g.Closed == true) sp.Geometry.Add(Line(fr, g.Points[g.Points.Length - 1], g.Points[0], g));
                            break;
                        }
                    case "circle":
                        {
                            var c = Pt(g.Center, featureName, g);
                            if (g.Radius == null || !(g.Radius.Value > 0)) throw ExecException.Unsupported(featureName, "circle " + g.Id + " has no positive radius");
                            sp.Geometry.Add(new GeomPlan { Kind = GeomKind.Circle, SourceId = g.Id, SourceType = g.Type, Center = SketchMath.ToWorldM(fr, c[0], c[1]), RadiusM = Units.MmToM(g.Radius.Value) });
                            break;
                        }
                    case "arc":
                        {
                            var c = Pt(g.Center, featureName, g);
                            if (g.Radius == null || !(g.Radius.Value > 0)) throw ExecException.Unsupported(featureName, "arc " + g.Id + " has no positive radius");
                            double r = g.Radius.Value;
                            double[] s = g.Start ?? AnglePoint(c, r, g.StartAngle, featureName, g);
                            double[] e = g.End ?? AnglePoint(c, r, g.EndAngle, featureName, g);
                            sp.Geometry.Add(new GeomPlan
                            {
                                Kind = GeomKind.Arc, SourceId = g.Id, SourceType = g.Type,
                                Center = SketchMath.ToWorldM(fr, c[0], c[1]),
                                Start = SketchMath.ToWorldM(fr, s[0], s[1]),
                                End = SketchMath.ToWorldM(fr, e[0], e[1]),
                                RadiusM = Units.MmToM(r),
                            });
                            break;
                        }
                    default:
                        throw ExecException.Unsupported(featureName, "sketch geometry type '" + g.Type + "' (id " + g.Id + ") is not supported");
                }
            }
            if (sp.Geometry.Count == 0) throw ExecException.Unsupported(featureName, "sketch " + sk.Name + " has no geometry");
            PlanDimensions(sk, sp, featureName, cx);
            return sp;
        }

        static void PlanDimensions(SketchDef sk, SketchPlan sp, string featureName, Ctx cx)
        {
            var byId = sk.Geometry.ToDictionary(g => g.Id, g => g);
            foreach (var d in sk.Dimensions)
            {
                if (!DimKinds.Contains(d.Kind)) throw ExecException.Unsupported(featureName, "sketch dimension kind '" + d.Kind + "' (" + d.Name + ") is not supported");
                if (d.Value == null || string.IsNullOrEmpty(d.Name)) throw ExecException.Unsupported(featureName, "sketch dimension without name or value in " + sk.Name);
                int need = (d.Kind == "radius" || d.Kind == "diameter") ? 1 : (d.Kind == "distance" ? -1 : 2);
                int n = d.Refs?.Length ?? 0;
                if ((need == -1 && n != 1 && n != 2) || (need > 0 && n != need))
                    throw ExecException.Unsupported(featureName, "sketch dimension " + d.Name + " (" + d.Kind + ") has " + n + " refs");
                if (sp.Face != null && (d.Kind == "distance_x" || d.Kind == "distance_y"))
                    throw ExecException.Unsupported(featureName, "sketch dimension " + d.Name + ": distance_x/distance_y on a sketch attached to a tilted face is not supported");
                var dp = new SketchDimPlan { Name = d.Name, Kind = d.Kind };
                foreach (var r in d.Refs!)
                {
                    if (r == null || r.Length != 2) throw ExecException.Unsupported(featureName, "sketch dimension ref of " + d.Name + " must be [id, position]");
                    bool origin = r[0] == -1;
                    if (origin && r[1] != 1) throw ExecException.Unsupported(featureName, "sketch dimension " + d.Name + ": origin ref must be [-1, 1]");
                    if (!origin)
                    {
                        if (!byId.TryGetValue(r[0], out var g)) throw ExecException.Unsupported(featureName, "sketch dimension " + d.Name + " refers to unknown geometry " + r[0]);
                        if (g.Type == "polyline") throw ExecException.Unsupported(featureName, "sketch dimension " + d.Name + " refers to a polyline");
                        if (r[1] < 0 || r[1] > 3) throw ExecException.Unsupported(featureName, "sketch dimension " + d.Name + ": bad position " + r[1]);
                    }
                    dp.Refs.Add(new DimRef { GeomId = r[0], Pos = r[1] });
                }
                var tmp = new List<Binding>();
                double v = cx.Scalar(d.Value, featureName, "dimension " + d.Name, tmp, d.Name + "@" + sk.Name);
                dp.ValueSi = d.Kind == "angle" ? Units.DegToRad(v) : Units.MmToM(v);
                dp.Binding = tmp.FirstOrDefault();
                sp.Dimensions.Add(dp);
            }
        }

        static GeomPlan Line(FrameDef fr, double[] a, double[] b, GeometryDef src) =>
            new GeomPlan { Kind = GeomKind.Line, SourceId = src.Id, SourceType = src.Type, Start = SketchMath.ToWorldM(fr, a[0], a[1]), End = SketchMath.ToWorldM(fr, b[0], b[1]) };

        static double[] Pt(double[]? p, string feature, GeometryDef g)
        {
            if (p == null || p.Length != 2 || double.IsNaN(p[0] + p[1]))
                throw ExecException.Unsupported(feature, "geometry " + g.Id + " (" + g.Type + ") has a missing or invalid 2D point");
            return p;
        }

        static double[] AnglePoint(double[] c, double r, double? deg, string feature, GeometryDef g)
        {
            if (deg == null) throw ExecException.Unsupported(feature, "arc " + g.Id + " has neither start/end points nor angles");
            double a = Units.DegToRad(deg.Value);
            return new[] { c[0] + r * Math.Cos(a), c[1] + r * Math.Sin(a) };
        }

        // ------------------------------------------------------------------ patterns / mirror

        static void CheckOriginals(FeatureDef feat, Ctx cx)
        {
            if (feat.Originals == null || feat.Originals.Count == 0)
                throw new ExecException(ErrorCodes.ExecutorFailed, feat.Type + " without originals", feat.Name, "plan");
            foreach (var o in feat.Originals)
                if (o == feat.Name || !cx.Features.Contains(o))
                    throw new ExecException(ErrorCodes.ExecutorFailed, feat.Type + " original '" + o + "' is not an earlier feature", feat.Name, "plan");
        }

        static int AxisParallel(double[] v, string feature, string what)
        {
            if (!Vec.IsFinite3(v) || Vec.Len(v) < 1e-9) throw new ExecException(ErrorCodes.ExecutorFailed, what + " has no usable direction", feature, "plan");
            var d = Vec.Unit(v);
            for (int i = 0; i < 3; i++) if (Math.Abs(Math.Abs(d[i]) - 1.0) <= ParallelTol) return i;
            throw ExecException.Unsupported(feature, what + " must be parallel to a world axis");
        }

        static PatternStep PlanPattern(FeatureDef feat, Ctx cx)
        {
            CheckOriginals(feat, cx);
            var ax = feat.Axis;
            if (ax == null || !Vec.IsFinite3(ax.Direction) || !Vec.IsFinite3(ax.Origin) || Vec.Len(ax.Direction) < 1e-9)
                throw new ExecException(ErrorCodes.ExecutorFailed, "polar_pattern without a usable axis", feat.Name, "plan");
            if (feat.Occurrences == null || feat.Occurrences < 2)
                throw new ExecException(ErrorCodes.ExecutorFailed, "polar_pattern needs occurrences >= 2", feat.Name, "plan");

            int idx = AxisParallel(ax.Direction, feat.Name, "polar_pattern axis");
            var d = Vec.Unit(ax.Direction);
            // The reference axis is built from two base planes, so it always passes through the world origin.
            double[] o = ax.Origin;
            double along = Vec.Dot(o, d);
            double[] perp = { o[0] - d[0] * along, o[1] - d[1] * along, o[2] - d[2] * along };
            if (Vec.Len(perp) > 1e-6)
                throw ExecException.Unsupported(feat.Name, "polar_pattern axis must pass through the world origin (axis origin is " + Vec.Len(perp) + " mm off)");

            bool full = feat.FullCircle ?? (feat.Angle != null && Math.Abs(feat.Angle.Value - 360.0) < 1e-9);
            double angleDeg = feat.Angle?.Value ?? 360.0;
            var step = new PatternStep
            {
                FeatureName = feat.Name, TypeName = feat.Type, Originals = feat.Originals!.ToList(),
                AxisIndex = idx, FlipDirection = d[idx] < 0, Count = feat.Occurrences.Value,
            };
            if (full) { step.EqualSpacing = true; step.SpacingRad = 2 * Math.PI; }
            else { step.EqualSpacing = false; step.SpacingRad = Units.DegToRad(angleDeg) / (step.Count - 1); }
            return step;
        }

        static LinearPatternStep PlanLinearPattern(FeatureDef feat, Ctx cx)
        {
            CheckOriginals(feat, cx);
            if (feat.Direction == null) throw new ExecException(ErrorCodes.ExecutorFailed, "linear_pattern without direction", feat.Name, "plan");
            if (feat.Occurrences == null || feat.Occurrences < 2)
                throw new ExecException(ErrorCodes.ExecutorFailed, "linear_pattern needs occurrences >= 2", feat.Name, "plan");
            int idx = AxisParallel(feat.Direction, feat.Name, "linear_pattern direction");
            var step = new LinearPatternStep
            {
                FeatureName = feat.Name, TypeName = feat.Type, Originals = feat.Originals!.ToList(),
                AxisIndex = idx, Reverse = Vec.Unit(feat.Direction)[idx] < 0, Count = feat.Occurrences.Value,
            };
            double? spacing = null;
            if (feat.Spacing != null) spacing = cx.Scalar(feat.Spacing, feat.Name, "spacing", step.Bindings, "D1@" + feat.Name);
            if (feat.Length != null)
            {
                double len = cx.Scalar(feat.Length, feat.Name, "length", null, null);
                double derived = len / (step.Count - 1);
                if (spacing != null && Math.Abs(spacing.Value - derived) > 1e-6 * Math.Max(1, derived))
                    throw new ExecException(ErrorCodes.ExecutorFailed, "linear_pattern spacing " + spacing + " does not equal length/(occurrences-1) = " + derived, feat.Name, "plan");
                spacing ??= derived;
            }
            if (spacing == null || !(spacing.Value > 0)) throw new ExecException(ErrorCodes.ExecutorFailed, "linear_pattern needs a positive spacing or length", feat.Name, "plan");
            step.SpacingM = Units.MmToM(spacing.Value);
            return step;
        }

        static MirrorStep PlanMirror(FeatureDef feat, Ctx cx)
        {
            CheckOriginals(feat, cx);
            var pl = feat.Plane;
            if (pl == null || !Vec.IsFinite3(pl.Origin) || !Vec.IsFinite3(pl.Normal))
                throw new ExecException(ErrorCodes.ExecutorFailed, "mirror without a usable plane", feat.Name, "plan");
            int idx = AxisParallel(pl.Normal, feat.Name, "mirror plane normal");
            // base plane whose SW normal is that world axis: Z -> Front, Y -> Top, X -> Right
            var plane = idx == 2 ? SwBasePlane.Front : idx == 1 ? SwBasePlane.Top : SwBasePlane.Right;
            double off = Vec.Dot(pl.Origin, PlaneMap.Normal(plane));
            return new MirrorStep
            {
                FeatureName = feat.Name, TypeName = feat.Type, Originals = feat.Originals!.ToList(),
                Plane = plane, OffsetM = Math.Abs(off) < 1e-9 ? 0.0 : Units.MmToM(off),
            };
        }

        // ------------------------------------------------------------------ fillet / chamfer

        static PlanStep PlanEdgeFeature(FeatureDef feat, Ctx cx)
        {
            if (feat.Edges == null || feat.Edges.Count == 0)
                throw new ExecException(ErrorCodes.ExecutorFailed, feat.Type + " without edges", feat.Name, "plan");
            foreach (var e in feat.Edges)
            {
                if (e.Curve != "line" && e.Curve != "circle" && e.Curve != "arc")
                    throw ExecException.Unsupported(feat.Name, "edge_ref curve '" + e.Curve + "' is not supported");
                if (!Vec.IsFinite3(e.Midpoint) || !(e.Length > 0))
                    throw new ExecException(ErrorCodes.ExecutorFailed, "edge_ref needs midpoint and positive length", feat.Name, "plan");
            }
            if (feat.Type == "fillet")
            {
                var st = new FilletStep { FeatureName = feat.Name, TypeName = "fillet", Edges = feat.Edges };
                if (feat.Radius == null) throw new ExecException(ErrorCodes.ExecutorFailed, "fillet without radius", feat.Name, "plan");
                double r = cx.Scalar(feat.Radius, feat.Name, "radius", st.Bindings, "D1@" + feat.Name);
                if (!(r > 0)) throw ExecException.Unsupported(feat.Name, "fillet radius must be positive");
                st.RadiusM = Units.MmToM(r);
                return st;
            }
            var ch = new ChamferStep { FeatureName = feat.Name, TypeName = "chamfer", Edges = feat.Edges };
            if (feat.Size == null) throw new ExecException(ErrorCodes.ExecutorFailed, "chamfer without size", feat.Name, "plan");
            double s = cx.Scalar(feat.Size, feat.Name, "size", ch.Bindings, "D1@" + feat.Name);
            if (!(s > 0)) throw ExecException.Unsupported(feat.Name, "chamfer size must be positive");
            ch.SizeM = Units.MmToM(s);
            return ch;
        }
    }
}
