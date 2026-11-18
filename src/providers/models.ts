/** The Gemini subscription connection uses standalone Google Gemini models. */
export function providerAllowsModel(adapter: string, modelId: string): boolean {
  return (
    adapter !== "antigravity-builtin" ||
    /^gemini-\d+(?:\.\d+)*-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(modelId)
  );
}
