using System.Collections.Generic;

namespace Reify.Export
{
    /// <summary>
    /// The only surface that talks to a CAD system. The SolidWorks implementation lives in the ReifyExport
    /// project; tests use a fake. Implementations throw ExecException (or any exception, mapped to
    /// EXECUTOR_FAILED by the runner) on failure.
    /// </summary>
    public interface IPartBuilder
    {
        /// <summary>Warnings the builder wants in result.json (e.g. a hole built as a cut).</summary>
        IList<WarningInfo> Warnings { get; }

        // ---- part session
        /// <summary>Attach to / start SolidWorks, create a new part in mm. Returns the app string, e.g. "SOLIDWORKS 2023 (31.0.0)".</summary>
        string Begin(string partName);
        /// <summary>Create a global variable (SolidWorks: equation "name" = value). False if it could not be created.</summary>
        bool AddParameter(ParameterPlan p);
        /// <summary>Bind a dimension (e.g. "D1@bracket/base") to a SolidWorks expression through an equation. False = could not bind.</summary>
        bool BindDimension(string fullName, string swExpr);

        // ---- sketches and features
        /// <summary>Create the sketch on its plane (or on 'face' when plan.Face is set), draw all geometry, add dimensions, exit, rename to plan.Name.</summary>
        void BuildSketch(SketchPlan sketch, FaceInfo? face);
        void ReuseSketch(string sketchName);
        /// <summary>Boss / cut extrude. 'upTo' is the resolved face for End == UpToFace.</summary>
        void Extrude(ExtrudeStep step, FaceInfo? upTo);
        /// <summary>Hole (Hole Wizard). The builder creates its own placement sketch from step.Sketch / CentersWorldM.</summary>
        void Hole(HoleStep step, FaceInfo? face);
        void Pattern(PatternStep step);
        void LinearPattern(LinearPatternStep step);
        void Mirror(MirrorStep step);
        void Fillet(FilletStep step, IReadOnlyList<EdgeInfo> edges);
        void Chamfer(ChamferStep step, IReadOnlyList<EdgeInfo> edges);

        // ---- queries on the current body
        IReadOnlyList<EdgeInfo> GetEdges();
        IReadOnlyList<FaceInfo> GetFaces();
        double DiagonalMm();
        /// <summary>Volume of the solid in mm^3 right now.</summary>
        double VolumeMm3();

        /// <summary>Set the part density (kg/m^3). False if not possible.</summary>
        bool SetDensity(double kgPerM3);

        // ---- output
        void SaveNative(string path);
        void ExportStep(string path);
        /// <summary>Close the document without prompting. Must not throw if nothing is open.</summary>
        void Close();

        // ---- assemblies
        /// <summary>New assembly from the default assembly template, units mm. Returns the app string.</summary>
        string BeginAssembly(string name);
        /// <summary>Insert the saved part file at the occurrence transform.</summary>
        void AddComponent(string partPath, OccurrencePlan occurrence);
    }
}
