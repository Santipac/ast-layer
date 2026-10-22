export function isTokenErrorLike(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const message = String((error as { message?: unknown }).message ?? "");
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "TOKEN_EXPIRED" || /token/i.test(message);
}
