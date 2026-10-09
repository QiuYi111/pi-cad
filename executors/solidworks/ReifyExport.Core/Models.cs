using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Reify.Export
{
    /// <summary>Scalar dimension: <c>{ "value": 12.5, "expr": "=w/2" }</c>. A bare number is accepted too.</summary>
    [JsonConverter(typeof(DimConverter))]
    public sealed class Dim
    {
        public double Value { get; set; }
        public string? Expr { get; set; }
    }

    public sealed class DimConverter : JsonConverter<Dim>
    {
        public override Dim? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            if (reader.TokenType == JsonTokenType.Null) return null;
            if (reader.TokenType == JsonTokenType.Number) return new Dim { Value = reader.GetDouble() };
            if (reader.TokenType != JsonTokenType.StartObject) throw new JsonException("dimension must be a number or {value, expr}");
            var d = new Dim();
            bool haveValue = false;
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.EndObject) break;
                if (reader.TokenType != JsonTokenType.PropertyName) continue;
                string name = reader.GetString() ?? "";
                reader.Read();
                if (name == "value") { d.Value = reader.GetDouble(); haveValue = true; }
                else if (name == "expr") d.Expr = reader.TokenType == JsonTokenType.Null ? null : reader.GetString();
                else reader.Skip();
            }
            if (!haveValue) throw new JsonException("dimension object without value");
            return d;
        }

        public override void Write(Utf8JsonWriter writer, Dim value, JsonSerializerOptions options)
        {
            writer.WriteStartObject();
            writer.WriteNumber("value", value.Value);
            if (value.Expr != null) writer.WriteString("expr", value.Expr);
            writer.WriteEndObject();
        }
    }

    public sealed class FeatureFile
    {
        [JsonPropertyName("schema")] public string Schema { get; set; } = "";
        [JsonPropertyName("units")] public string Units { get; set; } = "";
        [JsonPropertyName("part")] public string Part { get; set; } = "";
        [JsonPropertyName("bodies")] public List<Body> Bodies { get; set; } = new List<Body>();
        [JsonPropertyName("reference")] public ReferenceInfo? Reference { get; set; }
        [JsonPropertyName("parameters")] public List<ParameterDef> Parameters { get; set; } = new List<ParameterDef>();
        [JsonPropertyName("material")] public MaterialDef? Material { get; set; }
    }

    public sealed class ParameterDef
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("value")] public double Value { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; } = "";
        [JsonPropertyName("expr")] public string? Expr { get; set; }
    }

    public sealed class MaterialDef
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("density_kg_m3")] public double DensityKgM3 { get; set; }
    }

    public sealed class FaceRefDef
    {
        [JsonPropertyName("origin")] public double[] Origin { get; set; } = new double[3];
        [JsonPropertyName("normal")] public double[] Normal { get; set; } = new double[3];
        [JsonPropertyName("area")] public double Area { get; set; }
    }

    public sealed class EdgeRefDef
    {
        [JsonPropertyName("curve")] public string Curve { get; set; } = "";
        [JsonPropertyName("midpoint")] public double[] Midpoint { get; set; } = new double[3];
        [JsonPropertyName("length")] public double Length { get; set; }
        [JsonPropertyName("start")] public double[]? Start { get; set; }
        [JsonPropertyName("end")] public double[]? End { get; set; }
        [JsonPropertyName("centre")] public double[]? Centre { get; set; }
        [JsonPropertyName("radius")] public double? Radius { get; set; }
        [JsonPropertyName("axis")] public double[]? Axis { get; set; }
    }

    public sealed class MirrorPlaneDef
    {
        [JsonPropertyName("origin")] public double[] Origin { get; set; } = new double[3];
        [JsonPropertyName("normal")] public double[] Normal { get; set; } = new double[3];
    }

    public sealed class DimensionDef
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("kind")] public string Kind { get; set; } = "";
        /// <summary>[[geometry id, position], ...]; position 0 whole element, 1 start, 2 end, 3 centre; origin is [-1,1].</summary>
        [JsonPropertyName("refs")] public int[][] Refs { get; set; } = new int[0][];
        [JsonPropertyName("value")] public Dim? Value { get; set; }
    }

    public sealed class DrillPointDef
    {
        [JsonPropertyName("type")] public string Type { get; set; } = "flat";
        [JsonPropertyName("angle_deg")] public double? AngleDeg { get; set; }
    }

    public sealed class CounterboreDef
    {
        [JsonPropertyName("diameter")] public Dim? Diameter { get; set; }
        [JsonPropertyName("depth")] public Dim? Depth { get; set; }
    }

    public sealed class CountersinkDef
    {
        [JsonPropertyName("diameter")] public Dim? Diameter { get; set; }
        [JsonPropertyName("angle_deg")] public double? AngleDeg { get; set; }
    }

    public sealed class ThreadDef
    {
        [JsonPropertyName("standard")] public string? Standard { get; set; }
        [JsonPropertyName("size")] public string? Size { get; set; }
        [JsonPropertyName("pitch_mm")] public double? PitchMm { get; set; }
        [JsonPropertyName("modeled")] public bool Modeled { get; set; }
    }

    public sealed class TransformDef
    {
        [JsonPropertyName("origin")] public double[] Origin { get; set; } = new double[3];
        [JsonPropertyName("rotation")] public double[][] Rotation { get; set; } = new double[0][];
    }

    public sealed class AssemblyPartDef
    {
        [JsonPropertyName("ref")] public string Ref { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("features")] public FeatureFile Features { get; set; } = new FeatureFile();
    }

    public sealed class OccurrenceDef
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("part")] public string Part { get; set; } = "";
        [JsonPropertyName("transform")] public TransformDef Transform { get; set; } = new TransformDef();
    }

    public sealed class AssemblyFile
    {
        [JsonPropertyName("schema")] public string Schema { get; set; } = "";
        [JsonPropertyName("units")] public string Units { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("parts")] public List<AssemblyPartDef> Parts { get; set; } = new List<AssemblyPartDef>();
        [JsonPropertyName("occurrences")] public List<OccurrenceDef> Occurrences { get; set; } = new List<OccurrenceDef>();
    }

    public sealed class ReferenceInfo
    {
        [JsonPropertyName("volume_mm3")] public double? VolumeMm3 { get; set; }
        [JsonPropertyName("feature_volumes")] public List<FeatureVolume> FeatureVolumes { get; set; } = new List<FeatureVolume>();
    }

    public sealed class FeatureVolume
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("volume_mm3")] public double VolumeMm3 { get; set; }
    }

    public sealed class Body
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("sketches")] public List<SketchDef> Sketches { get; set; } = new List<SketchDef>();
        [JsonPropertyName("features")] public List<FeatureDef> Features { get; set; } = new List<FeatureDef>();
    }

    public sealed class FrameDef
    {
        [JsonPropertyName("origin")] public double[] Origin { get; set; } = new double[3];
        [JsonPropertyName("u")] public double[] U { get; set; } = new double[3];
        [JsonPropertyName("v")] public double[] V { get; set; } = new double[3];
        [JsonPropertyName("n")] public double[] N { get; set; } = new double[3];
    }

    public sealed class PlaneDef
    {
        [JsonPropertyName("base")] public string Base { get; set; } = "";
        [JsonPropertyName("offset")] public double Offset { get; set; }
    }

    public sealed class SketchDef
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("frame")] public FrameDef Frame { get; set; } = new FrameDef();
        [JsonPropertyName("plane")] public PlaneDef Plane { get; set; } = new PlaneDef();
        [JsonPropertyName("geometry")] public List<GeometryDef> Geometry { get; set; } = new List<GeometryDef>();
        [JsonPropertyName("loops")] public List<LoopDef> Loops { get; set; } = new List<LoopDef>();
        [JsonPropertyName("dimensions")] public List<DimensionDef> Dimensions { get; set; } = new List<DimensionDef>();
        [JsonPropertyName("face_ref")] public FaceRefDef? FaceRef { get; set; }
    }

    public sealed class GeometryDef
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("type")] public string Type { get; set; } = "";
        [JsonPropertyName("start")] public double[]? Start { get; set; }
        [JsonPropertyName("end")] public double[]? End { get; set; }
        [JsonPropertyName("center")] public double[]? Center { get; set; }
        [JsonPropertyName("radius")] public Dim? Radius { get; set; }
        [JsonPropertyName("start_angle")] public double? StartAngle { get; set; }
        [JsonPropertyName("end_angle")] public double? EndAngle { get; set; }
        /// <summary>For type "polyline": [[u,v],...] (assumed shape; consecutive points joined by lines).</summary>
        [JsonPropertyName("points")] public double[][]? Points { get; set; }
        [JsonPropertyName("closed")] public bool? Closed { get; set; }
    }

    public sealed class LoopDef
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("geometry")] public List<int> Geometry { get; set; } = new List<int>();
        [JsonPropertyName("closed")] public bool Closed { get; set; }
        [JsonPropertyName("depth")] public int Depth { get; set; }
        [JsonPropertyName("area")] public double Area { get; set; }
    }

    public sealed class ExtentDef
    {
        [JsonPropertyName("type")] public string Type { get; set; } = "";
        [JsonPropertyName("length")] public Dim? Length { get; set; }
        [JsonPropertyName("depth")] public Dim? Depth { get; set; }
        [JsonPropertyName("face_ref")] public FaceRefDef? FaceRef { get; set; }
    }

    public sealed class AxisDef
    {
        [JsonPropertyName("origin")] public double[] Origin { get; set; } = new double[3];
        [JsonPropertyName("direction")] public double[] Direction { get; set; } = new double[3];
    }

    public sealed class FeatureDef
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("type")] public string Type { get; set; } = "";
        [JsonPropertyName("sketch")] public string? Sketch { get; set; }
        [JsonPropertyName("direction")] public double[]? Direction { get; set; }
        [JsonPropertyName("extent")] public ExtentDef? Extent { get; set; }
        [JsonPropertyName("midplane")] public bool Midplane { get; set; }
        [JsonPropertyName("reversed")] public bool Reversed { get; set; }
        [JsonPropertyName("diameter")] public Dim? Diameter { get; set; }
        [JsonPropertyName("originals")] public List<string>? Originals { get; set; }
        [JsonPropertyName("axis")] public AxisDef? Axis { get; set; }
        [JsonPropertyName("angle")] public Dim? Angle { get; set; }
        [JsonPropertyName("occurrences")] public int? Occurrences { get; set; }
        [JsonPropertyName("full_circle")] public bool? FullCircle { get; set; }
        // P2 / P3
        [JsonPropertyName("length")] public Dim? Length { get; set; }
        [JsonPropertyName("spacing")] public Dim? Spacing { get; set; }
        [JsonPropertyName("plane")] public MirrorPlaneDef? Plane { get; set; }
        [JsonPropertyName("edges")] public List<EdgeRefDef>? Edges { get; set; }
        [JsonPropertyName("radius")] public Dim? Radius { get; set; }
        [JsonPropertyName("size")] public Dim? Size { get; set; }
        [JsonPropertyName("drill_point")] public DrillPointDef? DrillPoint { get; set; }
        [JsonPropertyName("counterbore")] public CounterboreDef? Counterbore { get; set; }
        [JsonPropertyName("countersink")] public CountersinkDef? Countersink { get; set; }
        [JsonPropertyName("thread")] public ThreadDef? Thread { get; set; }
    }

    public sealed class JobOutput
    {
        [JsonPropertyName("native")] public string Native { get; set; } = "part.SLDPRT";
        [JsonPropertyName("check_step")] public string CheckStep { get; set; } = "check.step";
    }

    public sealed class Job
    {
        [JsonPropertyName("schema")] public string Schema { get; set; } = "";
        [JsonPropertyName("jobId")] public string JobId { get; set; } = "";
        [JsonPropertyName("target")] public string Target { get; set; } = "";
        [JsonPropertyName("kind")] public string? Kind { get; set; }
        [JsonPropertyName("features")] public FeatureFile Features { get; set; } = new FeatureFile();
        [JsonPropertyName("assembly")] public AssemblyFile? Assembly { get; set; }
        [JsonPropertyName("output")] public JobOutput Output { get; set; } = new JobOutput();
        [JsonPropertyName("check")] public bool Check { get; set; } = true;
        [JsonPropertyName("timeoutS")] public int TimeoutS { get; set; } = 300;
    }

    public static class JsonDefaults
    {
        public static readonly JsonSerializerOptions Read = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };

        public static readonly JsonSerializerOptions Write = new JsonSerializerOptions
        {
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };
    }

    public static class JobLoader
    {
        public const string JobSchema = "reify.transfer.job/1";

        public static Job Parse(string json)
        {
            Job? job;
            try { job = JsonSerializer.Deserialize<Job>(json, JsonDefaults.Read); }
            catch (JsonException e) { throw new ExecException(ErrorCodes.ExecutorFailed, "job.json is not valid: " + e.Message, null, "read_job"); }
            if (job == null) throw new ExecException(ErrorCodes.ExecutorFailed, "job.json is empty", null, "read_job");
            if (job.Schema != JobSchema)
                throw new ExecException(ErrorCodes.ExecutorFailed, "unexpected job schema '" + job.Schema + "', expected " + JobSchema, null, "read_job");
            if (job.Target != "solidworks")
                throw new ExecException(ErrorCodes.ExecutorFailed, "job target is '" + job.Target + "', this executor only handles 'solidworks'", null, "read_job");
            return job;
        }

        public static Job Load(string jobDir)
        {
            string path = System.IO.Path.Combine(jobDir, "job.json");
            if (!System.IO.File.Exists(path))
                throw new ExecException(ErrorCodes.ExecutorFailed, "job.json not found in " + jobDir, null, "read_job");
            return Parse(System.IO.File.ReadAllText(path));
        }
    }
}
