import { createHash } from "node:crypto";
export { isTokenErrorLike } from "./errors";
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
