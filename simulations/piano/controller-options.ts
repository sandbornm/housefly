export function pianoControllerOptions(search: string) {
  const query = new URLSearchParams(search);
  return {
    version: query.get("encoder") === "v1" ? "v1" as const : "v2" as const,
    cold: query.get("weights") === "cold",
    calibrating: false,
  };
}
