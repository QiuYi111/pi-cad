using System;

namespace Reify.Export
{
    /// <summary>The SolidWorks API works in SI (meters, radians, m^3) regardless of document units. Reify JSON is mm and degrees.</summary>
    public static class Units
    {
        public static double MmToM(double mm) => mm / 1000.0;
        public static double MToMm(double m) => m * 1000.0;
        public static double DegToRad(double deg) => deg * Math.PI / 180.0;
        public static double M3ToMm3(double m3) => m3 * 1e9;
    }
}
