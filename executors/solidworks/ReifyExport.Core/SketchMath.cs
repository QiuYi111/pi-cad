using System;

namespace Reify.Export
{
    /// <summary>The three SolidWorks default planes.</summary>
    public enum SwBasePlane { Front = 0, Top = 1, Right = 2 }

    /// <summary>
    /// Plane mapping (UNVERIFIED against a real SolidWorks):
    /// Reify keeps Z up and SolidWorks is Y up, but we do NOT rotate. World coordinates of the
    /// canonical JSON are used as SolidWorks model coordinates (x,y,z) unchanged. Then
    ///   canonical XY -> SW "Front" plane (SW model XY, normal +Z)
    ///   canonical XZ -> SW "Top"   plane (SW model XZ, normal +Y)
    ///   canonical YZ -> SW "Right" plane (SW model YZ, normal +X)
    /// The shape is identical; only the SolidWorks view orientation labels differ.
    /// The base planes are found by type order: the first three RefPlane features of the new part
    /// are Front, Top, Right in the default SolidWorks template (index = (int)SwBasePlane).
    /// </summary>
    public static class PlaneMap
    {
        public static SwBasePlane FromCanonical(string baseName)
        {
            switch (baseName)
            {
                case "XY": return SwBasePlane.Front;
                case "XZ": return SwBasePlane.Top;
                case "YZ": return SwBasePlane.Right;
                default: throw new ArgumentException("plane.base must be XY, XZ or YZ, got '" + baseName + "'");
            }
        }

        public static int TypeOrderIndex(SwBasePlane p) => (int)p;

        /// <summary>Normal of the SW plane in model coordinates (the default boss-extrude direction).</summary>
        public static double[] Normal(SwBasePlane p)
        {
            switch (p)
            {
                case SwBasePlane.Front: return new double[] { 0, 0, 1 };
                case SwBasePlane.Top: return new double[] { 0, 1, 0 };
                default: return new double[] { 1, 0, 0 };
            }
        }
    }

    public static class Vec
    {
        public static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        public static double Len(double[] a) => Math.Sqrt(Dot(a, a));
        public static double[] Add(double[] a, double[] b) => new[] { a[0] + b[0], a[1] + b[1], a[2] + b[2] };
        public static double[] Scale(double[] a, double s) => new[] { a[0] * s, a[1] * s, a[2] * s };
        public static double[] Unit(double[] a)
        {
            double l = Len(a);
            if (l < 1e-12) throw new ArgumentException("zero-length vector");
            return Scale(a, 1.0 / l);
        }
        public static bool IsFinite3(double[]? a) =>
            a != null && a.Length == 3 && !double.IsNaN(a[0] + a[1] + a[2]) && !double.IsInfinity(a[0] + a[1] + a[2]);
    }

    public static class SketchMath
    {
        /// <summary>World point (mm) of a canonical sketch point [u,v]: origin + u*U + v*V.</summary>
        public static double[] ToWorldMm(FrameDef f, double u, double v) =>
            Vec.Add(f.Origin, Vec.Add(Vec.Scale(f.U, u), Vec.Scale(f.V, v)));

        public static double[] ToWorldM(FrameDef f, double u, double v)
        {
            var w = ToWorldMm(f, u, v);
            return new[] { Units.MmToM(w[0]), Units.MmToM(w[1]), Units.MmToM(w[2]) };
        }

        /// <summary>
        /// Our own prediction of the sketch coordinates SolidWorks gives a model point (meters) for a
        /// sketch on a default plane (UNVERIFIED). Used only to cross-check ModelToSketchTransform, which
        /// stays authoritative.
        ///   Front: (x, y)   Top: (x, -z)   Right: (-z, y)
        /// Returns {sx, sy, w}, w being the distance from the plane along the plane normal.
        /// </summary>
        public static double[] ExpectedSketchCoords(SwBasePlane p, double[] modelM)
        {
            switch (p)
            {
                case SwBasePlane.Front: return new[] { modelM[0], modelM[1], modelM[2] };
                case SwBasePlane.Top: return new[] { modelM[0], -modelM[2], modelM[1] };
                default: return new[] { -modelM[2], modelM[1], modelM[0] };
            }
        }

        /// <summary>The transformed point must lie in the sketch plane: |w| below tolerance (meters).</summary>
        public static bool IsOnSketchPlane(double[] sketchXyz, double tolM = 1e-7) => Math.Abs(sketchXyz[2]) <= tolM;

        public static bool Near(double[] a, double[] b, double tolM = 1e-7) =>
            Math.Abs(a[0] - b[0]) <= tolM && Math.Abs(a[1] - b[1]) <= tolM;

        /// <summary>
        /// Arc direction for CreateArc (1 = counter-clockwise, -1 = clockwise in sketch space).
        /// Canonical arcs are counter-clockwise in (u,v). If the SW sketch frame is mirrored relative to
        /// the canonical one (cross(u',v') &lt; 0), the same arc is clockwise in SW sketch space.
        /// u', v' are the sketch-space images of the canonical U and V axes.
        /// </summary>
        public static short ArcDirection(double ux, double uy, double vx, double vy) =>
            (ux * vy - uy * vx) >= 0 ? (short)1 : (short)-1;
    }
}
