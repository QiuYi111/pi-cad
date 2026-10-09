// Dihedral angle and convexity of every edge shared by two faces, read from the
// Analysis Situs attributed adjacency graph (AAG). The AAG computes the angle
// for each arc (pair of adjacent faces) with asiAlgo_CheckDihedralAngle.
#include "reify_asi.hpp"

#include <asiAlgo_AAG.h>
#include <asiAlgo_FeatureAttrAdjacency.h>
#include <asiAlgo_FeatureAttrAngle.h>
#include <asiAlgo_FeatureAngleType.h>

#include <BRepAdaptor_Curve.hxx>
#include <TColStd_MapIteratorOfPackedMapOfInteger.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <cmath>

void analyzeDihedral(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res)
{
  const Handle(asiAlgo_AAG) aag = new asiAlgo_AAG(shape, false);
  const TopTools_IndexedMapOfShape& edges = aag->RequestMapOfEdges();

  res.hasDihedral = true;
  res.dihedral.clear();

  for (asiAlgo_AAG::t_arc_attributes::Iterator it(aag->GetArcAttributes()); it.More(); it.Next())
  {
    const asiAlgo_AAG::t_arc& arc = it.Key();
    const Handle(asiAlgo_FeatureAttrAngle) ang =
      Handle(asiAlgo_FeatureAttrAngle)::DownCast(aag->GetArcAttribute(arc));
    if (ang.IsNull())
      continue;

    const asiAlgo_FeatureAngleType type = ang->GetAngleType();
    if (type == FeatureAngleType_Undefined || type == FeatureAngleType_NonManifold)
      continue;

    Dihedral d;
    d.faceA    = faces.FindIndex(aag->GetFace(arc.F1));
    d.faceB    = faces.FindIndex(aag->GetFace(arc.F2));
    // Analysis Situs returns a signed angle; the convexity is taken from the arc type.
    d.angleDeg = std::fabs(ang->GetAngleRad()) * 180. / M_PI;
    d.convex   = (type == FeatureAngleType_Convex || type == FeatureAngleType_SmoothConvex);
    d.edgeDir[0] = d.edgeDir[1] = d.edgeDir[2] = 0.;

    // Direction of the shared edge: unit tangent at its middle.
    const asiAlgo_Feature& eids = ang->GetEdgeIndices();
    if (!eids.IsEmpty())
    {
      const TopoDS_Edge edge = TopoDS::Edge(edges.FindKey(eids.GetMinimalMapped()));
      BRepAdaptor_Curve curve(edge);
      const double mid = 0.5 * (curve.FirstParameter() + curve.LastParameter());
      gp_Pnt p;
      gp_Vec tangent;
      curve.D1(mid, p, tangent);
      const double len = tangent.Magnitude();
      if (len > 0.)
      {
        d.edgeDir[0] = tangent.X() / len;
        d.edgeDir[1] = tangent.Y() / len;
        d.edgeDir[2] = tangent.Z() / len;
      }
    }

    res.dihedral.push_back(d);
  }
}
