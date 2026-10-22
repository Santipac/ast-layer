export const RELATION_BY_TYPE: Record<string, string> = { friend: "FRIEND", colleague: "COLLEAGUE", other: "OTHER" };

export function toRelation(type: string): string {
  return RELATION_BY_TYPE[type] ?? "OTHER";
}

export function toFollowed(id: string) {
  return { id, followed: true };
}

export function toStatusByKey(items: { id: string; status: string }[]) {
  const out: Record<string, string> = {};
  for (const item of items) {
    out[item.id] = item.status;
  }
  return out;
}
