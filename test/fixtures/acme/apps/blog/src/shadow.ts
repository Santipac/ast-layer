import { slugify } from "@acme/utils";

function local() {
  const slugify = (x: string) => x;
  return slugify("not the import");
}

export const real = slugify("the import");
export const other = local();
