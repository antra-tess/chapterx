/** What a tool that returned nothing shows: an empty text block is dropped or refused downstream. */
export const NO_TOOL_OUTPUT = '(no output)'

export function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return NO_TOOL_OUTPUT
  try {
    return JSON.stringify(output) ?? String(output)
  } catch {
    return String(output)
  }
}
