using System;
using System.Text.Json.Serialization;

namespace Reify.Export
{
    public static class ErrorCodes
    {
        public const string ExecutorFailed = "EXECUTOR_FAILED";
        public const string UnsupportedOp = "UNSUPPORTED_OP";
        public const string Busy = "BUSY";
    }

    /// <summary>The <c>error</c> object of result.json.</summary>
    public sealed class ErrorInfo
    {
        [JsonPropertyName("code")] public string Code { get; set; } = ErrorCodes.ExecutorFailed;
        [JsonPropertyName("message")] public string Message { get; set; } = "";
        [JsonPropertyName("feature")] public string? Feature { get; set; }
        [JsonPropertyName("step")] public string? Step { get; set; }
    }

    /// <summary>Any failure that must end up as result.json ok:false.</summary>
    public sealed class ExecException : Exception
    {
        public string Code { get; }
        public string? Feature { get; set; }
        public string? Step { get; set; }

        public ExecException(string code, string message, string? feature = null, string? step = null, Exception? inner = null)
            : base(message, inner)
        {
            Code = code;
            Feature = feature;
            Step = step;
        }

        public static ExecException Unsupported(string feature, string reason, string step = "plan") =>
            new ExecException(ErrorCodes.UnsupportedOp, reason, feature, step);

        public ErrorInfo ToInfo() => new ErrorInfo { Code = Code, Message = Message, Feature = Feature, Step = Step };

        /// <summary>Map any exception to an error. COM failures become EXECUTOR_FAILED with the HRESULT in the message.</summary>
        public static ErrorInfo Map(Exception ex, string? feature, string? step)
        {
            if (ex is ExecException ee)
            {
                return new ErrorInfo { Code = ee.Code, Message = ee.Message, Feature = ee.Feature ?? feature, Step = ee.Step ?? step };
            }
            string msg = ex.GetType().Name + ": " + ex.Message;
            if (ex.HResult != 0) msg += string.Format(" (HRESULT 0x{0:X8})", ex.HResult);
            return new ErrorInfo { Code = ErrorCodes.ExecutorFailed, Message = msg, Feature = feature, Step = step };
        }
    }
}
