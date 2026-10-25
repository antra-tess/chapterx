import pino from 'pino'
import { AsyncLocalStorage } from 'async_hooks'
import { existsSync, mkdirSync, createWriteStream } from 'fs'
import { join } from 'path'
import { traceLog, getCurrentTrace } from '../trace/collector.js'
import type { LogEntry } from '../trace/types.js'

const isDevelopment = process.env.NODE_ENV !== 'production'
const logDir = process.env.LOG_DIR || './logs/activations'

if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true })
}

const baseLogger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
})

const generalLogPath = join(logDir, 'general.log')
const generalLogStream = createWriteStream(generalLogPath, { flags: 'a' })
const generalFileLogger = pino({
  level: 'debug',
}, generalLogStream)

interface ActivationContext {
  logger: pino.Logger
  id: string
}

const activationContext = new AsyncLocalStorage<ActivationContext>()

const activationLoggers = new Map<string, { logger: pino.Logger, stream: NodeJS.WritableStream }>()

export const logger = new Proxy(baseLogger, {
  get(target, prop: string) {
    if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(prop)) {
      return (...args: any[]) => {
        (target as any)[prop](...args)
        
        const context = activationContext.getStore()
        if (context?.logger) {
          (context.logger as any)[prop](...args)
        } else {
          (generalFileLogger as any)[prop](...args)
        }
        
        const trace = getCurrentTrace()
        if (trace) {
          // pino allows: logger.info(obj, msg) or logger.info(msg)
          let message: string
          let data: Record<string, unknown> | undefined
          
          if (typeof args[0] === 'object' && args[0] !== null) {
            data = args[0] as Record<string, unknown>
            message = args[1] || ''
          } else {
            message = String(args[0] || '')
          }
          
          traceLog(prop as LogEntry['level'], message, data)
        }
      }
    }
    return (target as any)[prop]
  }
})

export async function withActivationLogging<T>(
  channelId: string,
  messageId: string,
  fn: () => Promise<T>
): Promise<T> {
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]
  const filename = `${channelId}-${messageId}-${timestamp}.log`
  const filePath = join(logDir, filename)
  const activationId = `${channelId}:${messageId}`
  
  const stream = createWriteStream(filePath, { flags: 'a' })
  const activationLogger = pino({
    level: 'debug',
  }, stream)
  
  activationLoggers.set(activationId, { logger: activationLogger, stream })
  
  logger.debug({ channelId, messageId, logFile: filename }, 'Started activation logging')
  
  try {
    return await activationContext.run(
      { logger: activationLogger, id: activationId },
      fn
    )
  } finally {
    logger.debug({ activationId }, 'Stopped activation logging')
    
    const entry = activationLoggers.get(activationId)
    if (entry) {
      entry.stream.end()
      activationLoggers.delete(activationId)
    }
  }
}

export function startActivationLogging(_channelId: string, _messageId: string): void {
}

export function stopActivationLogging(): void {
}

export function createLogger(context: Record<string, any>) {
  return logger.child(context)
}

export const log = {
  trace: logger.trace.bind(logger),
  debug: logger.debug.bind(logger),
  info: logger.info.bind(logger),
  warn: logger.warn.bind(logger),
  error: logger.error.bind(logger),
  fatal: logger.fatal.bind(logger),
}

