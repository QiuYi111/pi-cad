using System;
using System.Collections.Generic;
using System.Linq;

namespace Reify.Export
{
    public sealed class AssemblyPartPlan
    {
        public string Ref { get; set; } = "";
        public string Name { get; set; } = "";
        public string FileName { get; set; } = "";     // e.g. "axle.SLDPRT", in the job dir
        public Plan Plan { get; set; } = new Plan();
    }

    public sealed class OccurrencePlan
    {
        public string Name { get; set; } = "";
        public string PartRef { get; set; } = "";
        public double[] TransformArray { get; set; } = new double[16];   // SW MathTransform data, meters
    }

    public sealed class AssemblyPlan
    {
        public string Name { get; set; } = "";
        public List<AssemblyPartPlan> Parts { get; set; } = new List<AssemblyPartPlan>();
        public List<OccurrencePlan> Occurrences { get; set; } = new List<OccurrencePlan>();
    }

    public static class TransformMath
    {
        /// <summary>
        /// SolidWorks MathTransform.ArrayData layout (UNVERIFIED): 9 rotation values, then x, y, z translation
        /// (meters), then scale, then 3 zeros. Rotation is written row by row from the canonical row-major matrix
        /// that maps part coordinates to assembly coordinates (p' = R p + t).
        /// </summary>
        public static double[] ToSwArray(TransformDef t)
        {
            var a = new double[16];
            for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) a[r * 3 + c] = t.Rotation[r][c];
            a[9] = Units.MmToM(t.Origin[0]); a[10] = Units.MmToM(t.Origin[1]); a[11] = Units.MmToM(t.Origin[2]);
            a[12] = 1.0;
            return a;
        }

        public static bool IsRotation(double[][] m, double tol = 1e-6)
        {
            if (m == null || m.Length != 3 || m.Any(r => r == null || r.Length != 3)) return false;
            for (int i = 0; i < 3; i++)
                for (int j = 0; j < 3; j++)
                {
                    double dot = m[i][0] * m[j][0] + m[i][1] * m[j][1] + m[i][2] * m[j][2];
                    if (Math.Abs(dot - (i == j ? 1.0 : 0.0)) > tol) return false;
                }
            double det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                       - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                       + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            return Math.Abs(det - 1.0) <= tol;
        }
    }

    public static class AssemblyPlanner
    {
        public const string SupportedSchema = "reify.assembly/1";

        public static string SafeFileStem(string name)
        {
            var sb = new System.Text.StringBuilder();
            foreach (char c in name) sb.Append(char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_');
            return sb.Length == 0 ? "part" : sb.ToString();
        }

        public static AssemblyPlan Build(AssemblyFile a)
        {
            if (a == null) throw new ExecException(ErrorCodes.ExecutorFailed, "kind is assembly but job has no assembly", null, "plan");
            if (a.Schema != SupportedSchema) throw new ExecException(ErrorCodes.ExecutorFailed, "unsupported assembly schema '" + a.Schema + "'", null, "plan");
            if (a.Units != "mm") throw new ExecException(ErrorCodes.ExecutorFailed, "assembly units must be mm", null, "plan");
            if (a.Parts.Count == 0 || a.Occurrences.Count == 0) throw new ExecException(ErrorCodes.ExecutorFailed, "assembly has no parts or no occurrences", a.Name, "plan");

            var plan = new AssemblyPlan { Name = string.IsNullOrEmpty(a.Name) ? "assembly" : a.Name };
            var stems = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in a.Parts)
            {
                if (plan.Parts.Any(x => x.Ref == p.Ref)) throw new ExecException(ErrorCodes.ExecutorFailed, "duplicate part ref " + p.Ref, p.Name, "plan");
                string stem = SafeFileStem(p.Name);
                string unique = stem; int i = 2;
                while (!stems.Add(unique)) unique = stem + "_" + i++;
                var pp = new AssemblyPartPlan { Ref = p.Ref, Name = p.Name, FileName = unique + ".SLDPRT" };
                try { pp.Plan = Planner.Build(p.Features); }
                catch (ExecException e) { if (e.Step == "plan" && e.Feature == null) e.Feature = p.Name; throw; }
                plan.Parts.Add(pp);
            }
            var seen = new HashSet<string>();
            foreach (var o in a.Occurrences)
            {
                if (!seen.Add(o.Name)) throw new ExecException(ErrorCodes.ExecutorFailed, "duplicate occurrence name " + o.Name, o.Name, "plan");
                if (plan.Parts.All(x => x.Ref != o.Part)) throw new ExecException(ErrorCodes.ExecutorFailed, "occurrence refers to unknown part " + o.Part, o.Name, "plan");
                if (!Vec.IsFinite3(o.Transform.Origin) || !TransformMath.IsRotation(o.Transform.Rotation))
                    throw new ExecException(ErrorCodes.ExecutorFailed, "occurrence transform is not a rigid rotation + origin", o.Name, "plan");
                plan.Occurrences.Add(new OccurrencePlan { Name = o.Name, PartRef = o.Part, TransformArray = TransformMath.ToSwArray(o.Transform) });
            }
            return plan;
        }
    }
}
