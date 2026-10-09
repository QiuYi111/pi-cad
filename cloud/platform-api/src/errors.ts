// Error with an HTTP status and a stable machine code. Rendered as {code, message}.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const invalidCredentials = () => new HttpError(401, 'invalid_credentials', '邮箱或密码错误');
