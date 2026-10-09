// Blend (fillet) chain recognition (Analysis Situs asiAlgo_RecognizeBlends).
#include "reify_asi.hpp"

#include <asiAlgo_AAG.h>
#include <asiAlgo_RecognizeBlends.h>
#include <asiAlgo_AttrBlendCandidate.h>
#include <asiAlgo_BlendVexity.h>

#include <TColStd_MapIteratorOfPackedMapOfInteger.hxx>

#include <algorithm>

void analyzeBlends(const TopoDS_Shape& shape, const TopTools_IndexedMapOfShape& faces, AnalysisResult& res)
{
  asiAlgo_RecognizeBlends rb(shape);
  if (!rb.Perform())
    throw std::runtime_error("blend recognition did not complete");

  const Handle(asiAlgo_AAG)& aag = rb.GetAAG();
  if (aag.IsNull())
    throw std::runtime_error("blend recognition produced no AAG");

  std::vector<asiAlgo_BlendChain> chains;
  rb.GetChains(chains);

  res.hasBlends = true;
  res.blends.clear();
  for (const asiAlgo_BlendChain& chain : chains)
  {
    Blend b;
    for (TColStd_MapIteratorOfPackedMapOfInteger it(chain.first); it.More(); it.Next())
      b.faces.push_back(faces.FindIndex(aag->GetFace(it.Key())));
    std::sort(b.faces.begin(), b.faces.end());
    b.radius = chain.second.Radius;

    // Vexity is recorded per candidate face by the recognizer. Majority vote over the chain.
    int convex = 0, concave = 0;
    for (TColStd_MapIteratorOfPackedMapOfInteger it(chain.first); it.More(); it.Next())
    {
      const Handle(asiAlgo_AttrBlendCandidate) attr =
        aag->FindNodeAttribute<asiAlgo_AttrBlendCandidate>(it.Key());
      if (attr.IsNull())
        continue;
      for (const asiAlgo_BlendVexity vx : attr->Vexities)
      {
        if (vx == BlendVexity_Convex)  ++convex;
        if (vx == BlendVexity_Concave) ++concave;
      }
    }
    if (convex > concave)      b.kind = "convex";
    else if (concave > convex) b.kind = "concave";
    else                       b.kind = "unknown";

    res.blends.push_back(b);
  }
}
