export function parseSourceUrlOption(args: string[]): string | undefined {
  const sourceUrlIdx = args.indexOf("--source-url");
  if (sourceUrlIdx === -1) return undefined;
  const value = args[sourceUrlIdx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--source-url requires an absolute HTTP(S) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--source-url requires an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("--source-url requires an absolute HTTP(S) URL");
  }
  return parsed.toString();
}
