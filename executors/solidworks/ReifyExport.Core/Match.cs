using System;
using System.Collections.Generic;
using System.Linq;

namespace Reify.Export
{
    /// <summary>Edge of the current body as reported by the CAD builder. Index is the builder's own handle. World coordinates, mm.</summary>
    public sealed class EdgeInfo
    {
        public int Index { get; set; }
        public string Curve { get; set; } = "";          // line | circle | arc | other
        public double[] Midpoint { get; set; } = new double[3];
        public double Length { get; set; }
        public double[]? Centre { get; set; }
        public double? Radius { get; set; }
    }

    public sealed class FaceInfo
    {
        public int Index { get; set; }
        public bool Planar { get; set; }
        public double[] Origin { get; set; } = new double[3];   // a point on the plane
        public double[] Normal { get; set; } = new double[3];   // outward
        public double Area { get; set; }
    }

    public static class EdgeMatch
    {
        public const double RelTol = 1e-4;

        /// <summary>Distance tolerance in mm: 1e-4 x part diagonal (protocol section 7).</summary>
        public static double Tol(double diagonalMm) => RelTol * Math.Max(diagonalMm, 1e-6);

        static double Dist(double[] a, double[] b)
        {
            double dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        public static bool Matches(EdgeInfo e, EdgeRefDef r, double diagonalMm)
        {
            if (e.Curve != r.Curve) return false;
            double tol = Tol(diagonalMm);
            if (Math.Abs(e.Length - r.Length) > Math.Max(tol, RelTol * r.Length)) return false;
            // A full circle has no canonical midpoint (the seam differs between kernels): use centre + radius.
            if (r.Curve == "circle" && r.Centre != null && e.Centre != null)
            {
                if (Dist(e.Centre, r.Centre) > tol) return false;
                if (r.Radius != null && e.Radius != null && Math.Abs(e.Radius.Value - r.Radius.Value) > tol) return false;
                return true;
            }
            if (Dist(e.Midpoint, r.Midpoint) > tol) return false;
            if (r.Radius != null && e.Radius != null && Math.Abs(e.Radius.Value - r.Radius.Value) > tol) return false;
            return true;
        }

        /// <summary>Exactly one edge or an EXECUTOR_FAILED error naming the feature.</summary>
        public static EdgeInfo Resolve(IReadOnlyList<EdgeInfo> edges, EdgeRefDef r, double diagonalMm, string feature)
        {
            var hits = edges.Where(e => Matches(e, r, diagonalMm)).ToList();
            if (hits.Count == 1) return hits[0];
            string what = "edge_ref (" + r.Curve + ", midpoint " + string.Join(",", r.Midpoint) + ", length " + r.Length + ")";
            throw new ExecException(ErrorCodes.ExecutorFailed,
                hits.Count == 0 ? what + " matches no edge of the current body" : what + " matches " + hits.Count + " edges, not unique",
                feature, "edge_match");
        }

        public static List<EdgeInfo> ResolveAll(IReadOnlyList<EdgeInfo> edges, IEnumerable<EdgeRefDef> refs, double diagonalMm, string feature)
        {
            var res = new List<EdgeInfo>();
            foreach (var r in refs)
            {
                var e = Resolve(edges, r, diagonalMm, feature);
                if (res.All(x => x.Index != e.Index)) res.Add(e);
            }
            return res;
        }
    }

    public static class FaceMatch
    {
        public static bool Matches(FaceInfo f, FaceRefDef r, double diagonalMm)
        {
            if (!f.Planar) return false;
            double tol = EdgeMatch.Tol(diagonalMm);
            var fn = Vec.Unit(f.Normal); var rn = Vec.Unit(r.Normal);
            if (Math.Abs(Math.Abs(Vec.Dot(fn, rn)) - 1.0) > 1e-6) return false;
            var d = new[] { r.Origin[0] - f.Origin[0], r.Origin[1] - f.Origin[1], r.Origin[2] - f.Origin[2] };
            if (Math.Abs(Vec.Dot(fn, d)) > tol) return false;
            return Math.Abs(f.Area - r.Area) <= 1e-4 * Math.Max(r.Area, 1e-12);
        }

        public static FaceInfo Resolve(IReadOnlyList<FaceInfo> faces, FaceRefDef r, double diagonalMm, string feature)
        {
            var hits = faces.Where(f => Matches(f, r, diagonalMm)).ToList();
            if (hits.Count == 1) return hits[0];
            string what = "face_ref (origin " + string.Join(",", r.Origin) + ", area " + r.Area + ")";
            throw new ExecException(ErrorCodes.ExecutorFailed,
                hits.Count == 0 ? what + " matches no planar face of the current body" : what + " matches " + hits.Count + " faces, not unique",
                feature, "face_match");
        }
    }
}
