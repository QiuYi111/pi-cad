using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace Reify.Export.Tests
{
    // Shared golden edge-match fixtures (executors/fixtures/golden/edge_match.json). The same file drives
    // tests/fusion_addin/test_golden_edge_match.py. expect.solidworks is this matcher's verdict per case.
    public class GoldenEdgeMatchTests
    {
        static JsonDocument Load()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                var path = Path.Combine(dir.FullName, "executors", "fixtures", "golden", "edge_match.json");
                if (File.Exists(path)) return JsonDocument.Parse(File.ReadAllText(path));
                dir = dir.Parent;
            }
            throw new FileNotFoundException("executors/fixtures/golden/edge_match.json not found above " + AppContext.BaseDirectory);
        }

        static double[]? Arr(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) ? v.EnumerateArray().Select(x => x.GetDouble()).ToArray() : null;

        static double? Num(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) ? v.GetDouble() : (double?)null;

        static EdgeRefDef ToRef(JsonElement e) => new EdgeRefDef
        {
            Curve = e.GetProperty("curve").GetString()!,
            Midpoint = Arr(e, "midpoint") ?? new double[3],
            Length = e.GetProperty("length").GetDouble(),
            Centre = Arr(e, "centre"),
            Radius = Num(e, "radius"),
        };

        // start, end and axis are not part of EdgeInfo, so the SolidWorks matcher never sees them.
        static EdgeInfo ToEdge(JsonElement e, int index) => new EdgeInfo
        {
            Index = index,
            Curve = e.GetProperty("curve").GetString()!,
            Midpoint = Arr(e, "midpoint") ?? new double[3],
            Length = e.GetProperty("length").GetDouble(),
            Centre = Arr(e, "centre"),
            Radius = Num(e, "radius"),
        };

        static int[] Indices(JsonElement expect, string executor) =>
            expect.GetProperty(executor).EnumerateArray().Select(x => x.GetInt32()).ToArray();

        [Fact]
        public void SolidWorksMatcherGivesExpectedVerdicts()
        {
            using var doc = Load();
            foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
            {
                string name = c.GetProperty("name").GetString()!;
                double diag = c.GetProperty("diagonal_mm").GetDouble();
                var r = ToRef(c.GetProperty("ref"));
                var edges = c.GetProperty("candidates").EnumerateArray().Select((e, i) => ToEdge(e, i)).ToList();
                var got = edges.Where(e => EdgeMatch.Matches(e, r, diag)).Select(e => e.Index).ToArray();
                var want = Indices(c.GetProperty("expect"), "solidworks");
                Assert.True(want.SequenceEqual(got), name + ": expected [" + string.Join(",", want) + "] got [" + string.Join(",", got) + "]");
            }
        }

        [Fact]
        public void DivergenceFlagsMatchTheTwoExpectations()
        {
            using var doc = Load();
            foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
            {
                string name = c.GetProperty("name").GetString()!;
                var expect = c.GetProperty("expect");
                bool differ = !Indices(expect, "fusion").SequenceEqual(Indices(expect, "solidworks"));
                Assert.True(c.GetProperty("divergent").GetBoolean() == differ, name + ": divergent flag does not match expect");
            }
        }
    }
}
