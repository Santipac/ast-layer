import { slugify } from "@acme/utils";
export const Badge = (label: string) => slugify(label);
