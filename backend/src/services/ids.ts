let nextId = 1;

export function createId(prefix: string): string {
  const value = String(nextId).padStart(3, "0");
  nextId += 1;
  return `${prefix}-${value}`;
}
