namespace Reify.Export.Tests
{
    internal static class Samples
    {
        // Plate 40x30x5 with a 6 mm through hole, a pocket, and a 4x polar pattern of the hole around Z.
        public const string Features = @"{
  ""schema"": ""reify.features/1"", ""units"": ""mm"", ""part"": ""bracket"",
  ""source"": { ""doc"": ""parts/bracket.FCStd"", ""sha256"": ""00"" },
  ""bodies"": [{
    ""name"": ""bracket"",
    ""sketches"": [
      { ""name"": ""bracket/base_profile"",
        ""frame"": { ""origin"": [0,0,0], ""u"": [1,0,0], ""v"": [0,1,0], ""n"": [0,0,1] },
        ""plane"": { ""base"": ""XY"", ""offset"": 0.0 },
        ""geometry"": [
          { ""id"": 0, ""type"": ""line"", ""start"": [0,0], ""end"": [40,0] },
          { ""id"": 1, ""type"": ""line"", ""start"": [40,0], ""end"": [40,30] },
          { ""id"": 2, ""type"": ""line"", ""start"": [40,30], ""end"": [0,30] },
          { ""id"": 3, ""type"": ""line"", ""start"": [0,30], ""end"": [0,0] },
          { ""id"": 4, ""type"": ""arc"", ""center"": [20,15], ""radius"": { ""value"": 2 }, ""start_angle"": 0, ""end_angle"": 90, ""start"": [22,15], ""end"": [20,17] }
        ],
        ""loops"": [ { ""id"": 0, ""geometry"": [0,1,2,3], ""closed"": true, ""depth"": 0, ""area"": 1200.0 } ] },
      { ""name"": ""bracket/hole_sketch"",
        ""frame"": { ""origin"": [0,0,5], ""u"": [1,0,0], ""v"": [0,1,0], ""n"": [0,0,1] },
        ""plane"": { ""base"": ""XY"", ""offset"": 5.0 },
        ""geometry"": [ { ""id"": 0, ""type"": ""circle"", ""center"": [10,10], ""radius"": { ""value"": 3 } } ],
        ""loops"": [ { ""id"": 0, ""geometry"": [0], ""closed"": true, ""depth"": 0, ""area"": 28.27 } ] }
    ],
    ""features"": [
      { ""name"": ""bracket/base"", ""type"": ""pad"", ""sketch"": ""bracket/base_profile"", ""direction"": [0,0,1],
        ""extent"": { ""type"": ""length"", ""length"": { ""value"": 5, ""expr"": ""=thickness"" } }, ""midplane"": false, ""reversed"": false },
      { ""name"": ""bracket/holes"", ""type"": ""hole"", ""sketch"": ""bracket/hole_sketch"", ""direction"": [0,0,-1],
        ""extent"": { ""type"": ""through_all"" }, ""diameter"": { ""value"": 6 } },
      { ""name"": ""bracket/ring"", ""type"": ""polar_pattern"", ""originals"": [""bracket/holes""],
        ""axis"": { ""origin"": [0,0,0], ""direction"": [0,0,1] },
        ""angle"": { ""value"": 360 }, ""occurrences"": 4, ""full_circle"": true }
    ]
  }],
  ""reference"": { ""volume_mm3"": 5200.0, ""feature_volumes"": [ { ""name"": ""bracket/base"", ""volume_mm3"": 6000.0 } ] }
}";

        public static string Job(string features, string extra = "") =>
            @"{ ""schema"": ""reify.transfer.job/1"", ""jobId"": ""20261007-abc123"", ""target"": ""solidworks"", ""features"": " + features +
            @", ""output"": { ""native"": ""part.SLDPRT"", ""check_step"": ""check.step"" }, ""check"": true, ""timeoutS"": 300" + extra + " }";
    }
}
