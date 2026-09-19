export async function adaptRequest(distro, line, convert) {
  let request;
  try {
    request = JSON.parse(line);
  } catch { return line; }
  const cwd = request?.params?.arguments?.cwd;
  if (typeof cwd === "string" && (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\"))) {
    try {
      request.params.arguments.cwd = await convert(distro, cwd);
    } catch {
      const error = new Error(`Cannot convert Windows cwd to WSL: ${cwd}. Use a WSL absolute path or \\\\wsl.localhost\\${distro}\\... instead of a mapped drive.`);
      error.requestId = request.id;
      throw error;
    }
  }
  return JSON.stringify(request);
}

export function conversionErrorResponse(error) {
  if (error.requestId === undefined) return null;
  return { jsonrpc: "2.0", id: error.requestId, error: { code: -32602, message: error.message } };
}
