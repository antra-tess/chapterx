import { ConfigError } from '../types.js'

export function assertDefined<T>(
  value: T | null | undefined,
  message: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new ConfigError(message)
  }
}

export function validateEnv(vars: string[]): void {
  const missing = vars.filter((v) => !process.env[v])
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(', ')}`
    )
  }
}

export function validateBotConfig(config: any): void {
  const required = ['name', 'continuation_model']
  const missing = required.filter((field) => !config[field])
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required bot config fields: ${missing.join(', ')}`
    )
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function matchesAny(str: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(str))
}

