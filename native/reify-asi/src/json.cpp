// Minimal JSON writer for the analysis result. Keys follow the contract in
// docs/dfm/contract.md ("reify-asi"). Only checks that ran are present.
#include "reify_asi.hpp"

#include <cmath>
#include <cstdio>
#include <sstream>

std::string jsonNumber(const double v)
{
  if (!std::isfinite(v))
    return "null";
  if (std::fabs(v) < 1.e-12)
    return "0"; // also avoids "-0"
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.12g", v);
  return buf;
}

std::string jsonString(const std::string& s)
{
  std::string out = "\"";
  for (const char c : s)
  {
    switch (c)
    {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (static_cast<unsigned char>(c) < 0x20)
        {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
          out += buf;
        }
        else
          out += c;
    }
  }
  out += '"';
  return out;
}

namespace
{

std::string jsonInts(const std::vector<int>& v)
{
  std::ostringstream os;
  os << '[';
  for (size_t i = 0; i < v.size(); ++i)
    os << (i ? ", " : "") << v[i];
  os << ']';
  return os.str();
}

std::string jsonVec3(const double* v)
{
  return "[" + jsonNumber(v[0]) + ", " + jsonNumber(v[1]) + ", " + jsonNumber(v[2]) + "]";
}

std::string jsonBool(const bool b)
{
  return b ? "true" : "false";
}

std::string jsonArray(const std::vector<std::string>& items)
{
  std::string out = "[";
  for (size_t i = 0; i < items.size(); ++i)
  {
    if (i) out += ",\n  ";
    else   out += "\n  ";
    out += items[i];
  }
  if (!items.empty()) out += "\n";
  out += "]";
  return out;
}

} // namespace

std::string jsonResult(const AnalysisResult& res)
{
  std::ostringstream os;
  os << "{\n";
  os << "  \"version\": 1,\n";
  os << "  \"asi\": " << jsonString(res.asiVersion) << ",\n";
  os << "  \"faces\": " << res.faceCount;

  if (res.hasHoles)
  {
    std::vector<std::string> items;
    for (const Hole& h : res.holes)
    {
      std::ostringstream e;
      e << "{\"faces\": " << jsonInts(h.faces)
        << ", \"diameter\": " << jsonNumber(h.diameter)
        << ", \"depth\": " << jsonNumber(h.depth)
        << ", \"axis\": " << jsonVec3(h.axis)
        << ", \"through\": " << jsonBool(h.through)
        << ", \"bottom\": " << jsonString(h.bottom) << "}";
      items.push_back(e.str());
    }
    os << ",\n  \"holes\": " << jsonArray(items);
  }
  if (res.hasCavities)
  {
    std::vector<std::string> items;
    for (const Cavity& c : res.cavities)
    {
      items.push_back("{\"faces\": " + jsonInts(c.faces) + ", \"base_faces\": " + jsonInts(c.baseFaces) + "}");
    }
    os << ",\n  \"cavities\": " << jsonArray(items);
  }
  if (res.hasBlends)
  {
    std::vector<std::string> items;
    for (const Blend& b : res.blends)
    {
      items.push_back("{\"faces\": " + jsonInts(b.faces) + ", \"radius\": " + jsonNumber(b.radius)
                      + ", \"kind\": " + jsonString(b.kind) + "}");
    }
    os << ",\n  \"blends\": " << jsonArray(items);
  }
  if (res.hasThickness)
  {
    std::vector<std::string> items;
    for (const Thickness& t : res.thickness)
    {
      items.push_back("{\"face\": " + std::to_string(t.face) + ", \"min\": " + jsonNumber(t.min)
                      + ", \"at\": " + jsonVec3(t.at) + "}");
    }
    os << ",\n  \"thickness\": " << jsonArray(items);
  }
  if (res.hasDihedral)
  {
    std::vector<std::string> items;
    for (const Dihedral& d : res.dihedral)
    {
      items.push_back("{\"edge_faces\": " + jsonInts({d.faceA, d.faceB})
                      + ", \"angle_deg\": " + jsonNumber(d.angleDeg)
                      + ", \"convex\": " + jsonBool(d.convex)
                      + ", \"edge_dir\": " + jsonVec3(d.edgeDir) + "}");
    }
    os << ",\n  \"dihedral\": " << jsonArray(items);
  }

  os << ",\n  \"timing_ms\": {";
  for (size_t i = 0; i < res.timing.size(); ++i)
  {
    os << (i ? ", " : "") << jsonString(res.timing[i].first) << ": " << jsonNumber(res.timing[i].second);
  }
  os << "}\n}\n";
  return os.str();
}
