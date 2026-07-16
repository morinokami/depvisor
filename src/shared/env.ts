/** Fail-closed required-environment lookup shared by the entrypoints. */
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
