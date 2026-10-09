// Per-face wall thickness by inward ray casting (OCCT only).
//
// Analysis Situs' thickness check (asiAlgo_CheckThickness) needs the optional
// Mobius library and works on a faceted field, so it is not used. For every
// face, `samples` points are spread over its UV domain (a grid of about
// sqrt(samples) per direction). From each point a ray is cast along the
// inward normal (into the material). The thickness of the face is the
// smallest distance to another face among all sample points.
#include "reify_asi.hpp"

#include <BRepAdaptor_Surface.hxx>
#include <BRepTopAdaptor_FClass2d.hxx>
#include <gp_Pnt2d.hxx>
#include <TopAbs_State.hxx>
#include <BRepBndLib.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRepTools.hxx>
#include <Bnd_Box.hxx>
#include <IntCurvesFace_ShapeIntersector.hxx>
#include <Precision.hxx>
#include <TopAbs.hxx>
#include <TopoDS.hxx>
#include <gp_Dir.hxx>
#include <gp_Lin.hxx>
#include <gp_Vec.hxx>
#include <gp_Pnt.hxx>

#include <cmath>
#include <limits>

void analyzeThickness(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, int samples, AnalysisResult& res)
{
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  const double diag = std::sqrt(box.SquareExtent());
  if (!(diag > 0.))
    throw std::runtime_error("shape has an empty bounding box");
  const double eps   = 1.e-7 * diag;  // ignore hits at the start point (the own face)
  const double maxRay = 2. * diag;

  IntCurvesFace_ShapeIntersector inter;
  inter.Load(shape, Precision::Confusion());

  const int n = std::max(1, static_cast<int>(std::ceil(std::sqrt(static_cast<double>(samples)))));

  res.hasThickness = true;
  res.thickness.clear();
  for (int fi = 1; fi <= faces.Extent(); ++fi)
  {
    const TopoDS_Face face = TopoDS::Face(faces(fi));
    double umin, umax, vmin, vmax;
    BRepTools::UVBounds(face, umin, umax, vmin, vmax);
    BRepAdaptor_Surface adaptor(face);
    BRepLProp_SLProps props(adaptor, 1, 1.e-9);
    // One classifier per face (built once, reused for every sample).
    const BRepTopAdaptor_FClass2d faceClassifier(face, Precision::PConfusion());

    double best = std::numeric_limits<double>::max();
    double at[3] = {0., 0., 0.};
    bool   found = false;

    for (int a = 0; a < n; ++a)
    {
      for (int b = 0; b < n; ++b)
      {
        const double u = umin + (a + 0.5) / n * (umax - umin);
        const double v = vmin + (b + 0.5) / n * (vmax - vmin);
        // The UV grid covers the untrimmed surface domain: skip points outside the face (holes, pockets).
        const TopAbs_State st = faceClassifier.Perform(gp_Pnt2d(u, v), Standard_False);
        if (st != TopAbs_IN && st != TopAbs_ON)
          continue;
        props.SetParameters(u, v);
        if (!props.IsNormalDefined())
          continue;

        // Normal of the solid boundary: flip the surface normal for reversed faces.
        gp_Dir outward = props.Normal();
        if (face.Orientation() == TopAbs_REVERSED)
          outward.Reverse();
        const gp_Dir inward = outward.Reversed();
        const gp_Pnt p      = props.Value();

        inter.Perform(gp_Lin(p, inward), 0., maxRay);
        for (int k = 1; k <= inter.NbPnt(); ++k)
        {
          const double w = inter.WParameter(k);
          if (w <= eps)
            continue;
          if (inter.Face(k).IsSame(face))
            continue;
          if (w < best)
          {
            best  = w;
            found = true;
            at[0] = p.X();
            at[1] = p.Y();
            at[2] = p.Z();
          }
        }
      }
    }

    if (found)
    {
      Thickness t;
      t.face = fi;
      t.min  = best;
      t.at[0] = at[0];
      t.at[1] = at[1];
      t.at[2] = at[2];
      res.thickness.push_back(t);
    }
  }
}
