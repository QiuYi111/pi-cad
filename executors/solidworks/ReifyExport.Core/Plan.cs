using System;
using System.Collections.Generic;
using System.Linq;

namespace Reify.Export
{
    public enum EndCondition { Blind, ThroughAll, MidPlane }
    public enum GeomKind { Line, Arc, Circle }

    /// <summary>One piece of sketch geometry in WORLD coordinates, meters.</summary>
    public sealed class GeomPlan
    {
        public GeomKind Kind { get; set; }
        public double[] Start { get; set; } = new double[3];   // line/arc start
        public double[] End { get; set; } = new double[3];     // line/arc end
        public double[] Center { get; set; } = new double[3];  // arc/circle
        public double RadiusM { get; set; }
    }

    public sealed class SketchPlan
    {
        public string Name { get; set; } = "";
        public SwBasePlane Plane { get; set; }
        /// <summary>Signed distance of the sketch plane from the SW base plane along the SW plane normal, meters. 0 = sketch directly on the base plane.</summary>
        public double OffsetM { get; set; }
        public double[] OriginM { get; set; } = new double[3];
        public double[] UAxisEndM { get; set; } = new double[3];   // world point origin + 1 mm * U (meters)
        public double[] VAxisEndM { get; set; } = new double[3];   // world point origin + 1 mm * V (meters)
        public List<GeomPlan> Geometry { get; set; } = new List<GeomPlan>();
    }

    public abstract class PlanStep
    {
        public string FeatureName { get; set; } = "";
        public string TypeName { get; set; } = "";
    }

    public sealed class ExtrudeStep : PlanStep
    {
        public SketchPlan Sketch { get; set; } = new SketchPlan();
        /// <summary>true when a previous step already created this sketch; the builder re-selects it by name.</summary>
        public bool ReuseSketch { get; set; }
        public bool Cut { get; set; }
        public EndCondition End { get; set; }
        public double DepthM { get; set; }
        /// <summary>Pass as the "Dir" argument (reverse the default direction). See PlanConventions.</summary>
        public bool Reverse { get; set; }
    }

    public sealed class PatternStep : PlanStep
    {
        public List<string> Originals { get; set; } = new List<string>();
        /// <summary>Axis along this world axis (0=X,1=Y,2=Z) through the world origin. Built from the two base planes whose normals are the other two axes.</summary>
        public int AxisIndex { get; set; }
        public bool FlipDirection { get; set; }
        public int Count { get; set; }
        public double SpacingRad { get; set; }
        public bool EqualSpacing { get; set; }
    }

    public sealed class Plan
    {
        public string PartName { get; set; } = "";
        public List<PlanStep> Steps { get; set; } = new List<PlanStep>();
        public List<string> Warnings { get; set; } = new List<string>();
    }

    public static class PlanConventions
    {
        /// <summary>
        /// UNVERIFIED: a SolidWorks Cut-Extrude from a sketch goes, by default, to -normal (into the material),
        /// while a boss goes to +normal. If real SolidWorks disagrees, flip this one constant.
        /// The runner also fails loudly when a cut removes no material.
        /// </summary>
        public const bool CutDefaultsToMinusNormal = true;
    }

    public static class Planner
    {
        public const string SupportedSchema = "reify.features/1";
        const double ParallelTol = 1e-6;

        /// <summary>
        /// Validate the whole file and produce the ordered steps. Nothing touches SolidWorks here, so every
        /// unsupported construct is reported (UNSUPPORTED_OP, naming the feature) before a part is created.
        ///
        /// Profiles / nested contours: every geometry element of a canonical sketch is drawn into ONE
        /// SolidWorks sketch, the sketch feature is pre-selected and FeatureExtrusion3 / FeatureCut4 is called.
        /// SolidWorks then forms the regions itself from the closed contours. For depth 0 loops with depth 1
        /// loops inside (a plate with holes) this equals the even-odd rule of the protocol. Depth >= 2
        /// (island inside a hole) is rejected with UNSUPPORTED_OP because the SW behaviour for it is not
        /// verified (a pocket with an island would cut the island's area too, or fail). The planner never
        /// guesses; it stops.
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
            var plan = new Plan { PartName = string.IsNullOrEmpty(f.Part) ? body.Name : f.Part };
            var sketches = new Dictionary<string, SketchDef>();
            foreach (var s in body.Sketches)
            {
                if (sketches.ContainsKey(s.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "duplicate sketch name " + s.Name, s.Name, "plan");
                sketches[s.Name] = s;
            }

            var seenFeatures = new HashSet<string>();
            var usedSketches = new HashSet<string>();
            foreach (var feat in body.Features)
            {
                if (string.IsNullOrEmpty(feat.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "feature without a name", null, "plan");
                if (!seenFeatures.Add(feat.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "duplicate feature name " + feat.Name, feat.Name, "plan");

                switch (feat.Type)
                {
                    case "pad":
                    case "pocket":
                    case "hole":
                        plan.Steps.Add(PlanExtrude(feat, sketches, usedSketches, plan.Warnings));
                        break;
                    case "polar_pattern":
                        plan.Steps.Add(PlanPattern(feat, seenFeatures));
                        break;
                    default:
                        throw ExecException.Unsupported(feat.Name, "feature type '" + feat.Type + "' is not supported by the SolidWorks executor");
                }
            }
            return plan;
        }

        static ExtrudeStep PlanExtrude(FeatureDef feat, Dictionary<string, SketchDef> sketches, HashSet<string> used, List<string> warnings)
        {
            if (feat.Sketch == null || !sketches.TryGetValue(feat.Sketch, out var sk))
                throw new ExecException(ErrorCodes.ExecutorFailed, "feature references unknown sketch '" + feat.Sketch + "'", feat.Name, "plan");

            var step = new ExtrudeStep { FeatureName = feat.Name, TypeName = feat.Type, Cut = feat.Type != "pad" };

            // extent
            var ext = feat.Extent;
            if (ext == null) throw ExecException.Unsupported(feat.Name, "feature has no extent");
            if (feat.Type == "hole")
            {
                if (ext.Type != "through_all") throw ExecException.Unsupported(feat.Name, "hole supports only extent through_all, got '" + ext.Type + "'");
                if (feat.Midplane) throw ExecException.Unsupported(feat.Name, "midplane is not supported for holes");
                step.End = EndCondition.ThroughAll;
            }
            else if (ext.Type == "length")
            {
                if (ext.Length == null || !(ext.Length.Value > 0)) throw ExecException.Unsupported(feat.Name, "extent length must be positive");
                step.DepthM = Units.MmToM(ext.Length.Value);
                step.End = feat.Midplane ? EndCondition.MidPlane : EndCondition.Blind;
            }
            else if (ext.Type == "through_all" && feat.Type == "pocket")
            {
                if (feat.Midplane) throw ExecException.Unsupported(feat.Name, "midplane together with through_all is not supported");
                step.End = EndCondition.ThroughAll;
            }
            else
            {
                throw ExecException.Unsupported(feat.Name, "extent type '" + ext.Type + "' is not supported for " + feat.Type);
            }

            // sketch plane
            SwBasePlane plane;
            try { plane = PlaneMap.FromCanonical(sk.Plane.Base); }
            catch (ArgumentException e) { throw ExecException.Unsupported(feat.Name, e.Message); }
            var nSw = PlaneMap.Normal(plane);
            var fr = sk.Frame;
            if (!Vec.IsFinite3(fr.Origin) || !Vec.IsFinite3(fr.U) || !Vec.IsFinite3(fr.V) || !Vec.IsFinite3(fr.N))
                throw new ExecException(ErrorCodes.ExecutorFailed, "sketch frame of " + sk.Name + " is incomplete", feat.Name, "plan");
            if (Math.Abs(Math.Abs(Vec.Dot(Vec.Unit(fr.N), nSw)) - 1.0) > ParallelTol)
                throw ExecException.Unsupported(feat.Name, "sketch normal is not parallel to base plane " + sk.Plane.Base);

            double offsetMm = Vec.Dot(fr.Origin, nSw);
            if (Math.Abs(Math.Abs(offsetMm) - Math.Abs(sk.Plane.Offset)) > 1e-6)
                warnings.Add(sk.Name + ": frame origin distance " + offsetMm + " mm differs from plane.offset " + sk.Plane.Offset + " mm; the frame origin wins");

            // loops: nesting depth and closure
            foreach (var l in sk.Loops)
            {
                if (!l.Closed) throw ExecException.Unsupported(feat.Name, "sketch " + sk.Name + " has an open loop");
                if (l.Depth >= 2)
                    throw ExecException.Unsupported(feat.Name, "sketch " + sk.Name + " has a loop nested at depth " + l.Depth +
                        " (island inside a hole); nesting deeper than 1 is not supported by the SolidWorks executor");
            }

            step.Reverse = DecideReverse(step.Cut, step.End, feat.Direction, nSw, feat.Name);

            step.Sketch = BuildSketchPlan(sk, plane, nSw, offsetMm, feat.Name);
            step.ReuseSketch = !used.Add(sk.Name);
            return step;
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

        static SketchPlan BuildSketchPlan(SketchDef sk, SwBasePlane plane, double[] nSw, double offsetMm, string featureName)
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
            };
            foreach (var g in sk.Geometry)
            {
                switch (g.Type)
                {
                    case "line":
                        sp.Geometry.Add(Line(fr, Pt(g.Start, featureName, g), Pt(g.End, featureName, g)));
                        break;
                    case "polyline":
                        {
                            if (g.Points == null || g.Points.Length < 2) throw ExecException.Unsupported(featureName, "polyline " + g.Id + " has fewer than 2 points");
                            for (int i = 0; i + 1 < g.Points.Length; i++) sp.Geometry.Add(Line(fr, g.Points[i], g.Points[i + 1]));
                            if (g.Closed == true) sp.Geometry.Add(Line(fr, g.Points[g.Points.Length - 1], g.Points[0]));
                            break;
                        }
                    case "circle":
                        {
                            var c = Pt(g.Center, featureName, g);
                            if (g.Radius == null || !(g.Radius.Value > 0)) throw ExecException.Unsupported(featureName, "circle " + g.Id + " has no positive radius");
                            sp.Geometry.Add(new GeomPlan { Kind = GeomKind.Circle, Center = SketchMath.ToWorldM(fr, c[0], c[1]), RadiusM = Units.MmToM(g.Radius.Value) });
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
                                Kind = GeomKind.Arc,
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
            return sp;
        }

        static GeomPlan Line(FrameDef fr, double[] a, double[] b) =>
            new GeomPlan { Kind = GeomKind.Line, Start = SketchMath.ToWorldM(fr, a[0], a[1]), End = SketchMath.ToWorldM(fr, b[0], b[1]) };

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

        static PatternStep PlanPattern(FeatureDef feat, HashSet<string> seenFeatures)
        {
            if (feat.Originals == null || feat.Originals.Count == 0)
                throw new ExecException(ErrorCodes.ExecutorFailed, "polar_pattern without originals", feat.Name, "plan");
            foreach (var o in feat.Originals)
                if (o == feat.Name || !seenFeatures.Contains(o))
                    throw new ExecException(ErrorCodes.ExecutorFailed, "polar_pattern original '" + o + "' is not an earlier feature", feat.Name, "plan");
            var ax = feat.Axis;
            if (ax == null || !Vec.IsFinite3(ax.Direction) || !Vec.IsFinite3(ax.Origin) || Vec.Len(ax.Direction) < 1e-9)
                throw new ExecException(ErrorCodes.ExecutorFailed, "polar_pattern without a usable axis", feat.Name, "plan");
            if (feat.Occurrences == null || feat.Occurrences < 2)
                throw new ExecException(ErrorCodes.ExecutorFailed, "polar_pattern needs occurrences >= 2", feat.Name, "plan");

            var d = Vec.Unit(ax.Direction);
            int idx = -1;
            for (int i = 0; i < 3; i++) if (Math.Abs(Math.Abs(d[i]) - 1.0) <= ParallelTol) idx = i;
            if (idx < 0) throw ExecException.Unsupported(feat.Name, "polar_pattern axis must be parallel to a world axis");
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
                FeatureName = feat.Name,
                TypeName = feat.Type,
                Originals = feat.Originals.ToList(),
                AxisIndex = idx,
                FlipDirection = d[idx] < 0,
                Count = feat.Occurrences.Value,
            };
            if (full)
            {
                step.EqualSpacing = true;
                step.SpacingRad = 2 * Math.PI;
            }
            else
            {
                // Assumption (same as FreeCAD): partial angle spans first to last instance.
                step.EqualSpacing = false;
                step.SpacingRad = Units.DegToRad(angleDeg) / (step.Count - 1);
            }
            return step;
        }
    }
}
