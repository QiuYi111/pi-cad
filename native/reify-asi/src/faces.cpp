// Face numbering and the --dump-faces table.
#include "reify_asi.hpp"

#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <gp_Pnt.hxx>
#include <TopExp.hxx>
#include <TopAbs.hxx>
#include <TopoDS.hxx>

#include <cstdio>

TopTools_IndexedMapOfShape buildFaceMap(const TopoDS_Shape& shape)
{
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  return faces;
}

std::string dumpFacesJson(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces)
{
  (void)shape;
  std::string out = "{\"faces\": [";
  char buf[256];
  for (int i = 1; i <= faces.Extent(); ++i)
  {
    const TopoDS_Face& face = TopoDS::Face(faces(i));
    GProp_GProps props;
    BRepGProp::SurfaceProperties(face, props, false, false);
    const gp_Pnt c = props.CentreOfMass();
    std::snprintf(buf, sizeof(buf),
                  "%s{\"id\": %d, \"centroid\": [%.12g, %.12g, %.12g], \"area\": %.12g}",
                  i == 1 ? "" : ", ", i, c.X(), c.Y(), c.Z(), props.Mass());
    out += buf;
  }
  out += "]}";
  return out;
}
