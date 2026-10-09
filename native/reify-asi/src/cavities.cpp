// Cavity recognition (Analysis Situs asiAlgo_RecognizeCavities).
#include "reify_asi.hpp"

#include <asiAlgo_AAG.h>
#include <asiAlgo_RecognizeCavities.h>

#include <TColStd_MapIteratorOfPackedMapOfInteger.hxx>
#include <TColStd_PackedMapOfInteger.hxx>

#include <algorithm>

namespace
{

std::vector<int> toFaceIds(const Handle(asiAlgo_AAG)&    aag,
                           const TopTools_IndexedMapOfShape& faces,
                           const asiAlgo_Feature&        ids)
{
  std::vector<int> out;
  for (TColStd_MapIteratorOfPackedMapOfInteger it(ids); it.More(); it.Next())
    out.push_back(faces.FindIndex(aag->GetFace(it.Key())));
  std::sort(out.begin(), out.end());
  return out;
}

} // namespace

void analyzeCavities(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res)
{
  asiAlgo_RecognizeCavities rc(shape);
  if (!rc.Perform())
    throw std::runtime_error("cavity recognition did not complete");

  const Handle(asiAlgo_AAG)& aag = rc.GetAAG();
  res.hasCavities = true;
  res.cavities.clear();
  for (const auto& cav : rc.GetCavities())
  {
    Cavity c;
    c.faces     = toFaceIds(aag, faces, cav.first);
    c.baseFaces = toFaceIds(aag, faces, cav.second);
    res.cavities.push_back(c);
  }
}
