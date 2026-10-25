import { logger } from './logger.js'

export interface RetryOptions {
  maxAttempts: number
  initialDelay?: number
  maxDelay?: number
  exponential?: boolean
  onRetry?: (error: Error, attempt: number) => void
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxAttempts,
    initialDelay = 1000,
    maxDelay = 32000,
    exponential = true,
    onRetry,
  } = options

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (attempt === maxAttempts) {
        break
      }

      if (onRetry) {
        onRetry(lastError, attempt)
      }

      let delay = initialDelay
      if (exponential) {
        delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay)
      }

      logger.warn(
        {
          error: lastError.message,
          attempt,
          maxAttempts,
          delayMs: delay,
        },
        'Retrying after error'
      )

      await sleep(delay)
    }
  }

  throw lastError
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function retryLLM<T>(
  fn: () => Promise<T>,
  maxAttempts: number
): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts,
    initialDelay: 1000,
    exponential: false,
  })
}

export async function retryDiscord<T>(
  fn: () => Promise<T>,
  maxBackoffMs: number = 32000
): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts: 10,
    initialDelay: 1000,
    maxDelay: maxBackoffMs,
    exponential: true,
  })
}

