// Drill hole recognition: Analysis Situs asiAlgo_RecognizeDrillHoles finds the
// hole faces; this file groups them into holes and derives the geometry
// (diameter, depth, axis, through/blind, bottom type) from OCCT.
#include "reify_asi.hpp"

#include <asiAlgo_AAG.h>
#include <asiAlgo_RecognizeDrillHoles.h>

#include <Bnd_Box.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRep_Tool.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Precision.hxx>
#include <TColStd_MapIteratorOfPackedMapOfInteger.hxx>
#include <TColStd_PackedMapOfInteger.hxx>
#include <TopAbs_State.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace
{

// Connected components of the recognized AAG face ids (adjacency from the AAG).
std::vector<std::vector<int>> groupByAdjacency(const Handle(asiAlgo_AAG)& aag,
                                               const asiAlgo_Feature&     ids)
{
  std::vector<std::vector<int>> comps;
  asiAlgo_Feature remaining = ids;
  while (!remaining.IsEmpty())
  {
    const int seed = remaining.GetMinimalMapped();
    remaining.Remove(seed);
    std::vector<int> comp{seed};
    std::vector<int> stack{seed};
    while (!stack.empty())
    {
      const int f = stack.back();
      stack.pop_back();
      const asiAlgo_Feature& nb = aag->GetNeighbors(f);
      for (TColStd_MapIteratorOfPackedMapOfInteger it(nb); it.More(); it.Next())
      {
        const int n = it.Key();
        if (remaining.Contains(n))
        {
          remaining.Remove(n);
          comp.push_back(n);
          stack.push_back(n);
        }
      }
    }
    comps.push_back(comp);
  }
  return comps;
}

// Signed coordinate of a point along the hole axis, relative to the cylinder origin.
double axialCoord(const gp_Pnt& p, const gp_Pnt& origin, const gp_Dir& axis)
{
  return gp_Vec(origin, p).Dot(gp_Vec(axis));
}

const char* bottomTypeName(const TopoDS_Face& face)
{
  BRepAdaptor_Surface s(face);
  switch (s.GetType())
  {
    case GeomAbs_Plane:  return "flat";
    case GeomAbs_Cone:   return "cone";
    case GeomAbs_Sphere: return "sphere";
    default:             return "unknown";
  }
}

} // namespace

void analyzeHoles(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res)
{
  asiAlgo_RecognizeDrillHoles rec(shape, false);
  if (!rec.Perform())
    throw std::runtime_error("drill hole recognition did not complete");

  const Handle(asiAlgo_AAG)& aag = rec.GetAAG();
  const asiAlgo_Feature&     ids = rec.GetResultIndices();

  TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);

  BRepClass3d_SolidClassifier classifier(shape);
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  const double diag  = std::sqrt(box.SquareExtent());
  const double delta = std::max(1.e-4, 1.e-3 * diag); // probe distance past the hole ends

  res.hasHoles = true;
  res.holes.clear();

  for (const std::vector<int>& comp : groupByAdjacency(aag, ids))
  {
    std::vector<TopoDS_Face> cylFaces;
    for (const int aagId : comp)
    {
      const TopoDS_Face& f = aag->GetFace(aagId);
      if (BRepAdaptor_Surface(f).GetType() == GeomAbs_Cylinder)
        cylFaces.push_back(f);
    }
    if (cylFaces.empty())
      continue; // recognized faces without a wall (not a hole)

    const gp_Cylinder cyl = BRepAdaptor_Surface(cylFaces.front()).Cylinder();
    const gp_Pnt      origin = cyl.Location();
    const gp_Dir      zdir   = cyl.Axis().Direction();

    double vlo = std::numeric_limits<double>::max();
    double vhi = -std::numeric_limits<double>::max();
    for (const TopoDS_Face& f : cylFaces)
    {
      BRepAdaptor_Surface s(f);
      vlo = std::min(vlo, s.FirstVParameter());
      vhi = std::max(vhi, s.LastVParameter());
    }
    const double depth = vhi - vlo;

    // A probe just past each end lies inside the material for a blind end
    // and in air for an open end.
    auto insideAt = [&](double v) {
      const gp_Pnt p = origin.Translated(gp_Vec(zdir) * v);
      classifier.Perform(p, Precision::Confusion());
      return classifier.State() == TopAbs_IN;
    };
    const bool inHi = insideAt(vhi + delta);
    const bool inLo = insideAt(vlo - delta);
    const bool through = !inHi && !inLo;

    // Blind: the axis runs from the open end into the material, i.e. toward the bottom.
    double bottomV = vhi;
    double sign    = 1.;
    if (!through && inLo && !inHi)
    {
      bottomV = vlo;
      sign    = -1.;
    }

    // Bottom face: the face across the circular edge at the bottom end.
    TopoDS_Face bottomFace;
    if (!through)
    {
      const double tol = std::max(1.e-6, 1.e-4 * std::max(1., depth));
      for (const TopoDS_Face& cf : cylFaces)
      {
        for (TopExp_Explorer ex(cf, TopAbs_EDGE); ex.More() && bottomFace.IsNull(); ex.Next())
        {
          const TopoDS_Edge e = TopoDS::Edge(ex.Current());
          if (BRep_Tool::Degenerated(e))
            continue;
          BRepAdaptor_Curve c(e);
          if (c.GetType() != GeomAbs_Circle)
            continue;
          const double v = axialCoord(c.Circle().Location(), origin, zdir);
          if (std::fabs(v - bottomV) > tol)
            continue;
          if (!edgeFaces.Contains(e))
            continue;
          for (TopTools_ListIteratorOfListOfShape it(edgeFaces.FindFromKey(e)); it.More(); it.Next())
          {
            const TopoDS_Face other = TopoDS::Face(it.Value());
            if (!other.IsSame(cf))
            {
              bottomFace = other;
              break;
            }
          }
        }
      }
    }

    Hole h;
    for (const TopoDS_Face& f : cylFaces)
      h.faces.push_back(faces.FindIndex(f));
    if (!bottomFace.IsNull())
      h.faces.push_back(faces.FindIndex(bottomFace));
    std::sort(h.faces.begin(), h.faces.end());
    h.faces.erase(std::unique(h.faces.begin(), h.faces.end()), h.faces.end());

    h.diameter = 2. * cyl.Radius();
    h.depth    = depth;
    h.through  = through;
    h.axis[0]  = sign * zdir.X();
    h.axis[1]  = sign * zdir.Y();
    h.axis[2]  = sign * zdir.Z();
    if (through)
      h.bottom = "none";
    else if (bottomFace.IsNull())
      h.bottom = "unknown";
    else
      h.bottom = bottomTypeName(bottomFace);

    res.holes.push_back(h);
  }
}
