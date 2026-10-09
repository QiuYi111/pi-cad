using System;
using System.Collections.Generic;
using System.Linq;

namespace Reify.Export
{
    public enum EndCondition { Blind, ThroughAll, MidPlane, UpToFace }
    public enum GeomKind { Line, Arc, Circle }

    /// <summary>One piece of sketch geometry in WORLD coordinates, meters.</summary>
    public sealed class GeomPlan
    {
        public GeomKind Kind { get; set; }
        public double[] Start { get; set; } = new double[3];   // line/arc start
        public double[] End { get; set; } = new double[3];     // line/arc end
        public double[] Center { get; set; } = new double[3];  // arc/circle
        public double RadiusM { get; set; }
        /// <summary>Id of the canonical geometry element this piece comes from (dimensions refer to it).</summary>
        public int SourceId { get; set; }
        public string SourceType { get; set; } = "";
    }

    /// <summary>Expression bound to a dimension through an equation: "FullName" = SwExpr.</summary>
    public sealed class Binding
    {
        public string Field { get; set; } = "";
        public string FullName { get; set; } = "";     // e.g. D1@bracket/base
        public string SwExpr { get; set; } = "";
        public double Value { get; set; }
    }

    public sealed class DimRef { public int GeomId { get; set; } public int Pos { get; set; } }

    public sealed class SketchDimPlan
    {
        public string Name { get; set; } = "";
        public string Kind { get; set; } = "";
        public List<DimRef> Refs { get; set; } = new List<DimRef>();
        /// <summary>SI value: meters, or radians for angle.</summary>
        public double ValueSi { get; set; }
        public Binding? Binding { get; set; }
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
        public List<SketchDimPlan> Dimensions { get; set; } = new List<SketchDimPlan>();
        /// <summary>Set for sketches on a tilted face: the face to sketch on (Plane/OffsetM are then not used).</summary>
        public FaceRefDef? Face { get; set; }
    }

    public abstract class PlanStep
    {
        public string FeatureName { get; set; } = "";
        public string TypeName { get; set; } = "";
        public List<Binding> Bindings { get; set; } = new List<Binding>();
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
        /// <summary>For End == UpToFace: the face to resolve in the body state before the pad.</summary>
        public FaceRefDef? UpToFace { get; set; }
    }

    public sealed class HoleStep : PlanStep
    {
        public SketchPlan Sketch { get; set; } = new SketchPlan();
        public List<double[]> CentersWorldM { get; set; } = new List<double[]>();
        public double DiameterM { get; set; }
        public bool Through { get; set; }
        public double DepthM { get; set; }
        public bool Reverse { get; set; }
        /// <summary>0 = flat bottom, otherwise included angle of the drill point in degrees (blind holes only).</summary>
        public double DrillPointAngleDeg { get; set; }
        public double CounterboreDiameterM { get; set; }
        public double CounterboreDepthM { get; set; }
        public double CountersinkDiameterM { get; set; }
        public double CountersinkAngleDeg { get; set; }
        public bool CosmeticThread { get; set; }
        public string? ThreadStandard { get; set; }
        public string? ThreadSize { get; set; }
        public bool IsPlain => CounterboreDiameterM == 0 && CountersinkDiameterM == 0 && !CosmeticThread && DrillPointAngleDeg == 0;
    }

    public sealed class LinearPatternStep : PlanStep
    {
        public List<string> Originals { get; set; } = new List<string>();
        public int AxisIndex { get; set; }
        public bool Reverse { get; set; }
        public int Count { get; set; }
        public double SpacingM { get; set; }
    }

    public sealed class MirrorStep : PlanStep
    {
        public List<string> Originals { get; set; } = new List<string>();
        public SwBasePlane Plane { get; set; }
        /// <summary>0 = the base plane itself, otherwise a distance reference plane this far from it along the SW plane normal (meters).</summary>
        public double OffsetM { get; set; }
    }

    public sealed class FilletStep : PlanStep
    {
        public List<EdgeRefDef> Edges { get; set; } = new List<EdgeRefDef>();
        public double RadiusM { get; set; }
    }

    public sealed class ChamferStep : PlanStep
    {
        public List<EdgeRefDef> Edges { get; set; } = new List<EdgeRefDef>();
        public double SizeM { get; set; }
    }

    public sealed class ParameterPlan
    {
        public string Name { get; set; } = "";
        public double Value { get; set; }
        public string Unit { get; set; } = "";
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
        public List<WarningInfo> Warnings { get; set; } = new List<WarningInfo>();
        public List<ParameterPlan> Parameters { get; set; } = new List<ParameterPlan>();
        public double? DensityKgM3 { get; set; }
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

}
