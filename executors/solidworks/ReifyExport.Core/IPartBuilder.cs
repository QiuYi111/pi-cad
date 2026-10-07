namespace Reify.Export
{
    /// <summary>
    /// The only surface that talks to a CAD system. The SolidWorks implementation lives in the ReifyExport
    /// project; tests use a fake. Implementations throw ExecException (or any exception, mapped to
    /// EXECUTOR_FAILED by the runner) on failure.
    /// </summary>
    public interface IPartBuilder
    {
        /// <summary>Attach to / start SolidWorks, create a new part in mm. Returns the app string, e.g. "SOLIDWORKS 2023 (31.0.0)".</summary>
        string Begin(string partName);
        /// <summary>Create the sketch on its plane, draw all geometry, exit, rename the sketch feature to plan.Name.</summary>
        void BuildSketch(SketchPlan sketch);
        void ReuseSketch(string sketchName);
        /// <summary>Boss / cut extrude. Must rename the resulting feature to step.FeatureName and remember it.</summary>
        void Extrude(ExtrudeStep step);
        void Pattern(PatternStep step);
        /// <summary>Volume of the solid in mm^3 right now.</summary>
        double VolumeMm3();
        void SaveNative(string path);
        void ExportStep(string path);
        /// <summary>Close the document without prompting. Must not throw if nothing is open.</summary>
        void Close();
    }
}
