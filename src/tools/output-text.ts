/** What a tool that returned nothing shows: an empty text block is dropped or refused downstream. */
export const NO_TOOL_OUTPUT = '(no output)'

/**
 * A tool's output as the text the model and Discord see: a string as it is,
 * no output at all (undefined) as NO_TOOL_OUTPUT, and anything else as JSON,
 * or as String() gives it when JSON can't hold it (a function, a symbol, a
 * BigInt, a cycle).
 */
export function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return NO_TOOL_OUTPUT
  try {
    return JSON.stringify(output) ?? String(output)
  } catch {
    return String(output)
  }
}
