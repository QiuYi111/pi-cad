// reify-asi: DFM feature analysis CLI (Analysis Situs asiAlgo + OCCT 7.6).
// Shared declarations. Face IDs everywhere are 1-based indices in the order
// produced by TopExp::MapShapes(shape, TopAbs_FACE), the same order as
// FreeCAD's Shape.Faces (Faces[n-1] is face n).
#pragma once

#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>

// Exit codes (also documented in README.md and scripts/bootstrap-asi.sh).
enum ExitCode
{
  EXIT_OK        = 0,
  EXIT_USAGE     = 2, // bad command line
  EXIT_INPUT     = 3, // missing or unreadable .brep / empty shape
  EXIT_ANALYSIS  = 4, // an analyzer raised or failed
  EXIT_OUTPUT    = 5, // could not write the result
};

struct CliError : public std::runtime_error
{
  int code;
  CliError(const int c, const std::string& msg) : std::runtime_error(msg), code(c) {}
};

struct Options
{
  std::string          in;
  std::string          out;
  std::set<std::string> checks;     // subset of holes, cavities, blends, thickness, dihedral
  int                  thicknessSamples = 400;
  bool                 dumpFaces        = false;
};

struct Hole
{
  std::vector<int> faces;     // wall faces + bottom face (blind) in the hole group
  double           diameter;  // 2 * cylinder radius
  double           depth;     // length of the cylindrical wall along the axis
  double           axis[3];   // unit; from the opening into the material (blind),
                              // native cylinder direction (through)
  bool             through;
  std::string      bottom;    // flat | cone | sphere | unknown | none (through)
};

struct Cavity
{
  std::vector<int> faces;      // cavity faces
  std::vector<int> baseFaces;  // faces the cavity opens into / is based on
};

struct Blend
{
  std::vector<int> faces;
  double           radius;
  std::string      kind;      // concave | convex
};

struct Thickness
{
  int    face;
  double min;
  double at[3];
};

struct Dihedral
{
  int    faceA, faceB;
  double angleDeg;   // as reported by Analysis Situs (angle between face normals)
  bool   convex;
  double edgeDir[3];
};

// Everything the analysis produced. A check that was not requested stays
// absent from the JSON (the caller knows it did not run).
struct AnalysisResult
{
  int                                  faceCount = 0;
  std::vector<Hole>                    holes;
  bool                                 hasHoles = false;
  bool                                 hasCavities = false;
  std::vector<Cavity>                  cavities;
  bool                                 hasBlends = false;
  std::vector<Blend>                   blends;
  bool                                 hasThickness = false;
  std::vector<Thickness>               thickness;
  bool                                 hasDihedral = false;
  std::vector<Dihedral>                dihedral;
  std::vector<std::pair<std::string, double>> timing;  // ms, in run order
  std::string                          asiVersion = "2024.2";
};

// faces.cpp
TopTools_IndexedMapOfShape buildFaceMap(const TopoDS_Shape& shape);
std::string               dumpFacesJson(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces);

// Per-check analyzers. Each throws std::runtime_error on failure.
void analyzeHoles(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res);
void analyzeCavities(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res);
void analyzeBlends(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res);
void analyzeThickness(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, int samples, AnalysisResult& res);
void analyzeDihedral(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res);

// json.cpp
std::string jsonNumber(double v);
std::string jsonString(const std::string& s);
std::string jsonResult(const AnalysisResult& res);

// analyze.cpp
int runCli(int argc, char** argv);
