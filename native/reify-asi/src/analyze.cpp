// Command line handling and the analyze pipeline.
#include "reify_asi.hpp"

#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Shape.hxx>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>

namespace
{

const char* const kAllChecks[] = {"holes", "cavities", "blends", "thickness", "dihedral"};

void printUsage(FILE* f)
{
  std::fprintf(f,
    "usage: reify-asi analyze --in part.brep --out result.json\n"
    "                         [--checks holes,cavities,blends,thickness,dihedral]\n"
    "                         [--thickness-samples N]\n"
    "       reify-asi analyze --in part.brep --dump-faces\n"
    "       reify-asi --version\n");
}

std::vector<std::string> splitComma(const std::string& s)
{
  std::vector<std::string> out;
  std::string cur;
  std::istringstream is(s);
  while (std::getline(is, cur, ','))
  {
    if (!cur.empty()) out.push_back(cur);
  }
  return out;
}

Options parseArgs(int argc, char** argv)
{
  if (argc < 2)
    throw CliError(EXIT_USAGE, "missing command (expected 'analyze'); try --help");

  const std::string cmd = argv[1];
  if (cmd == "--version" || cmd == "version")
  {
    std::printf("reify-asi %s (Analysis Situs 2024.2, OCCT 7.6)\n", REIFY_ASI_VERSION);
    std::exit(EXIT_OK);
  }
  if (cmd == "--help" || cmd == "-h" || cmd == "help")
  {
    printUsage(stdout);
    std::exit(EXIT_OK);
  }
  if (cmd != "analyze")
    throw CliError(EXIT_USAGE, "unknown command '" + cmd + "' (expected 'analyze')");

  Options opt;
  bool checksGiven = false;
  for (int i = 2; i < argc; ++i)
  {
    const std::string a = argv[i];
    auto value = [&](const char* name) -> std::string
    {
      if (i + 1 >= argc)
        throw CliError(EXIT_USAGE, std::string("missing value for ") + name);
      return argv[++i];
    };
    if (a == "--in")
      opt.in = value("--in");
    else if (a == "--out")
      opt.out = value("--out");
    else if (a == "--checks")
    {
      checksGiven = true;
      for (const std::string& c : splitComma(value("--checks")))
      {
        bool known = false;
        for (const char* k : kAllChecks) known = known || (c == k);
        if (!known)
          throw CliError(EXIT_USAGE, "unknown check '" + c + "'");
        opt.checks.insert(c);
      }
    }
    else if (a == "--thickness-samples")
    {
      const std::string v = value("--thickness-samples");
      char* end = nullptr;
      const long n = std::strtol(v.c_str(), &end, 10);
      if (!end || *end != '\0' || n < 1 || n > 100000)
        throw CliError(EXIT_USAGE, "--thickness-samples must be an integer in 1..100000");
      opt.thicknessSamples = static_cast<int>(n);
    }
    else if (a == "--dump-faces")
      opt.dumpFaces = true;
    else if (a == "--help" || a == "-h")
    {
      printUsage(stdout);
      std::exit(EXIT_OK);
    }
    else
      throw CliError(EXIT_USAGE, "unknown argument '" + a + "'");
  }

  if (opt.in.empty())
    throw CliError(EXIT_USAGE, "--in is required");
  if (!opt.dumpFaces && opt.out.empty())
    throw CliError(EXIT_USAGE, "--out is required (or use --dump-faces)");
  if (!checksGiven)
    for (const char* k : kAllChecks) opt.checks.insert(k);
  return opt;
}

double elapsedMs(const std::chrono::steady_clock::time_point& t0)
{
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

} // namespace

int runCli(int argc, char** argv)
{
  const Options opt = parseArgs(argc, argv);

  // ---- load ----
  const auto t0 = std::chrono::steady_clock::now();
  {
    // OCCT's text BRep format starts with a "DBRep_DrawableShape" line and then
    // "CASCADE Topology V<n>". Check that before reading, so that OCCT does not
    // print its own message on stderr for other files.
    std::ifstream probe(opt.in, std::ios::binary);
    if (!probe)
      throw CliError(EXIT_INPUT, "cannot open input '" + opt.in + "'");
    std::string head(256, '\0');
    probe.read(&head[0], static_cast<std::streamsize>(head.size()));
    head.resize(static_cast<size_t>(probe.gcount()));
    if (head.find("CASCADE Topology") == std::string::npos)
      throw CliError(EXIT_INPUT, "'" + opt.in + "' is not an OCCT BRep file");
  }
  TopoDS_Shape shape;
  BRep_Builder builder;
  try
  {
    BRepTools::Read(shape, opt.in.c_str(), builder);
  }
  catch (const std::exception& e)
  {
    throw CliError(EXIT_INPUT, std::string("cannot read BRep '") + opt.in + "': " + e.what());
  }
  if (shape.IsNull())
    throw CliError(EXIT_INPUT, "BRep '" + opt.in + "' contains no shape");

  const TopTools_IndexedMapOfShape faces = buildFaceMap(shape);
  if (faces.Extent() == 0)
    throw CliError(EXIT_INPUT, "BRep '" + opt.in + "' contains no faces");
  const double loadMs = elapsedMs(t0);

  if (opt.dumpFaces)
  {
    const std::string table = dumpFacesJson(shape, faces);
    std::fwrite(table.data(), 1, table.size(), stdout);
    std::fputc('\n', stdout);
    return EXIT_OK;
  }

  AnalysisResult res;
  res.faceCount = faces.Extent();
  res.timing.push_back({"load", loadMs});

  // ---- checks ----
  // Run in a fixed order so that timings are comparable between runs.
  for (const char* name : kAllChecks)
  {
    if (!opt.checks.count(name)) continue;
    const auto tc = std::chrono::steady_clock::now();
    try
    {
      const std::string n = name;
      if (n == "holes")         analyzeHoles(shape, faces, res);
      else if (n == "cavities") analyzeCavities(shape, faces, res);
      else if (n == "blends")   analyzeBlends(shape, faces, res);
      else if (n == "thickness") analyzeThickness(shape, faces, opt.thicknessSamples, res);
      else if (n == "dihedral") analyzeDihedral(shape, faces, res);
    }
    catch (const std::exception& e)
    {
      throw CliError(EXIT_ANALYSIS, std::string(name) + " failed: " + e.what());
    }
    res.timing.push_back({name, elapsedMs(tc)});
  }

  // ---- output ----
  const std::string json = jsonResult(res);
  std::FILE* f = std::fopen(opt.out.c_str(), "wb");
  if (!f)
    throw CliError(EXIT_OUTPUT, "cannot write '" + opt.out + "'");
  const size_t written = std::fwrite(json.data(), 1, json.size(), f);
  const bool closed = std::fclose(f) == 0;
  if (written != json.size() || !closed)
    throw CliError(EXIT_OUTPUT, "short write to '" + opt.out + "'");
  return EXIT_OK;
}
