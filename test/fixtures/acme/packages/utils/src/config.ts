import { AdminConfig } from "admin";

export const defaultLocale = (c?: AdminConfig) => (c ? c.locale : "en-US");
