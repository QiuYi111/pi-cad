using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Reify.Export
{
    public sealed class ExecutorInfo
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "ReifyExport";
        [JsonPropertyName("version")] public string Version { get; set; } = AppInfo.Version;
        [JsonPropertyName("app")] public string? App { get; set; }
    }

    public sealed class ResultFiles
    {
        [JsonPropertyName("native")] public string? Native { get; set; }
        [JsonPropertyName("check_step")] public string? CheckStep { get; set; }
        [JsonPropertyName("log")] public string Log { get; set; } = "log.txt";
    }

    public sealed class JobResult
    {
        [JsonPropertyName("schema")] public string Schema { get; set; } = ResultWriter.Schema;
        [JsonPropertyName("jobId")] public string JobId { get; set; } = "";
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("target")] public string Target { get; set; } = "solidworks";
        [JsonPropertyName("executor")] public ExecutorInfo Executor { get; set; } = new ExecutorInfo();
        [JsonPropertyName("files")] public ResultFiles Files { get; set; } = new ResultFiles();
        [JsonPropertyName("features_built")] public int FeaturesBuilt { get; set; }
        [JsonPropertyName("feature_volumes")] public List<FeatureVolume> FeatureVolumes { get; set; } = new List<FeatureVolume>();
        [JsonPropertyName("error")] public ErrorInfo? Error { get; set; }
    }

    public static class AppInfo
    {
        public const string Version = "0.1.0";
        public static string VersionLine => "ReifyExport " + Version;
    }

    public static class ResultWriter
    {
        public const string Schema = "reify.transfer.result/1";

        public static string ToJson(JobResult r) => JsonSerializer.Serialize(r, JsonDefaults.Write);

        /// <summary>Write result.json atomically (tmp + rename) so the dispatcher never reads a half file.</summary>
        public static void Write(string jobDir, JobResult r)
        {
            Directory.CreateDirectory(jobDir);
            string final = Path.Combine(jobDir, "result.json");
            string tmp = final + ".tmp";
            File.WriteAllText(tmp, ToJson(r), new System.Text.UTF8Encoding(false));
            if (File.Exists(final)) File.Delete(final);
            File.Move(tmp, final);
        }
    }
}
