import {
  Membrane,
  AnthropicAdapter,
  OpenRouterAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  OpenAICompletionsAdapter,
  BedrockAdapter,
  GeminiAdapter,
  OpenAIResponsesAdapter,
  AnthropicXmlFormatter,
  NativeFormatter,
  CompletionsFormatter,
} from '@animalabs/membrane';
import type { ProviderAdapter, MembraneConfig, PrefillFormatter } from '@animalabs/membrane';
import { logger } from '../../utils/logger.js';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  name?: string;
  provides?: string[];
}

export interface OpenAICompletionsConfig {
  apiKey: string;
  baseUrl: string;
  name?: string;
  provides?: string[];
  defaultStopSequences?: string[];
  warnOnImageStrip?: boolean;
  eotToken?: string | null;
}

export interface BedrockConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  sessionToken?: string;
  provides?: string[];
}

export interface AnthropicProviderConfig {
  apiKey: string;
  name: string;
  provides?: string[];
}

export interface OpenAIProviderConfig {
  apiKey: string;
  name: string;
  baseUrl?: string;
  provides?: string[];
}

export interface GeminiConfig {
  apiKey?: string;
  provides?: string[];
}

export interface OpenAIResponsesConfig {
  apiKey: string;
  name: string;
  baseUrl?: string;
  provides?: string[];
  allowImageEditing?: boolean;
}

export type FormatterType = 'anthropic-xml' | 'native' | 'completions';

export interface MembraneFactoryConfig {
  anthropicApiKey?: string;

  anthropicProviders?: AnthropicProviderConfig[];

  openrouterApiKey?: string;

  openaiApiKey?: string;

  openaiBaseUrl?: string;

  openaiProviders?: OpenAIProviderConfig[];

  openaiCompatible?: OpenAICompatibleConfig;

  openaiCompatibleProviders?: OpenAICompatibleConfig[];

  openaiCompletionsProviders?: OpenAICompletionsConfig[];

  bedrock?: BedrockConfig;

  bedrockProviders?: BedrockConfig[];

  gemini?: GeminiConfig;

  openaiResponsesProviders?: OpenAIResponsesConfig[];

  assistantName: string;

  maxParticipantsForStop?: number;

  formatter?: FormatterType;

  completionsConfig?: {
    eotToken?: string;
    nameFormat?: string;
    messageSeparator?: string;
    caseInsensitiveStops?: boolean;
  };

  retries?: number;

  debug?: boolean;
}

function matchesPattern(modelName: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(modelName);
}

interface AdapterRouting {
  adapterKey: string;
  patterns: string[];
}

let patternRoutes: AdapterRouting[] = [];

interface FormatterRouting {
  patterns: string[];
  formatter: FormatterType;
}

let formatterRoutes: FormatterRouting[] = [];

export function getFormatterForModel(modelName: string): FormatterType | undefined {
  for (const route of formatterRoutes) {
    for (const pattern of route.patterns) {
      if (matchesPattern(modelName, pattern)) {
        logger.debug({ modelName, formatter: route.formatter }, 'Found formatter for model');
        return route.formatter;
      }
    }
  }
  return undefined;
}

function getAdapterForModel(
  modelName: string,
  adapters: Map<string, ProviderAdapter>
): ProviderAdapter | undefined {
  for (const route of patternRoutes) {
    for (const pattern of route.patterns) {
      if (matchesPattern(modelName, pattern)) {
        const adapter = adapters.get(route.adapterKey);
        if (adapter) {
          logger.debug({ modelName, adapterKey: route.adapterKey }, 'Routed model via pattern match');
          return adapter;
        }
      }
    }
  }

  // OpenRouter models have a provider prefix (e.g., "anthropic/claude-3-opus", "openai/o3")
  if (modelName.includes('/')) {
    const openrouterAdapter = adapters.get('openrouter');
    if (openrouterAdapter) {
      logger.debug({ modelName, adapterKey: 'openrouter' }, 'Routed model to OpenRouter (provider/model format)');
      return openrouterAdapter;
    }
  }

  // Bedrock models (anthropic.* prefix, cross-region prefixes, or bedrock:* prefix)
  if (modelName.startsWith('anthropic.') || modelName.startsWith('bedrock:') ||
      modelName.startsWith('us.anthropic.') || modelName.startsWith('eu.anthropic.') ||
      modelName.startsWith('apac.anthropic.')) {
    for (const [key, adapter] of adapters) {
      if (key.startsWith('bedrock')) {
        logger.debug({ modelName, adapterKey: key }, 'Routed model to Bedrock (anthropic/cross-region pattern)');
        return adapter;
      }
    }
  }

  if (modelName.startsWith('gemini-') || modelName.startsWith('gemini_')) {
    const geminiAdapter = adapters.get('gemini');
    if (geminiAdapter) {
      logger.debug({ modelName, adapterKey: 'gemini' }, 'Routed model to Gemini (gemini-* pattern)');
      return geminiAdapter;
    }
  }

  if (modelName.startsWith('claude-')) {
    const anthropicAdapter = adapters.get('anthropic');
    if (anthropicAdapter) {
      logger.debug({ modelName, adapterKey: 'anthropic' }, 'Routed model to Anthropic (claude-* pattern)');
      return anthropicAdapter;
    }
  }

  if (modelName.startsWith('gpt-') || 
      modelName.startsWith('o1') ||
      modelName.startsWith('o3') ||
      modelName.startsWith('o4') ||
      modelName.startsWith('gpt5') ||
      modelName.startsWith('chatgpt-')) {
    const openaiAdapter = adapters.get('openai');
    if (openaiAdapter) {
      logger.debug({ modelName, adapterKey: 'openai' }, 'Routed model to OpenAI (gpt/o1/o3/o4 pattern)');
      return openaiAdapter;
    }
  }

  if (modelName.startsWith('local:') || modelName.startsWith('openai-compatible:')) {
    for (const [key, adapter] of adapters) {
      if (key.startsWith('openai-compatible-') || key === 'openai-compatible') {
        logger.debug({ modelName, adapterKey: key }, 'Routed local model to OpenAI-compatible adapter');
        return adapter;
      }
    }
  }

  for (const [key, adapter] of adapters) {
    if (adapter.supportsModel(modelName)) {
      logger.debug({ modelName, adapterKey: key }, 'Routed model via adapter.supportsModel()');
      return adapter;
    }
  }

  return undefined;
}

class RoutingAdapter implements ProviderAdapter {
  readonly name = 'routing';
  private adapters: Map<string, ProviderAdapter>;

  constructor(adapters: Map<string, ProviderAdapter>) {
    this.adapters = adapters;
    if (adapters.size === 0) {
      throw new Error('No adapters available for RoutingAdapter');
    }
  }

  supportsModel(modelId: string): boolean {
    for (const adapter of this.adapters.values()) {
      if (adapter.supportsModel(modelId)) {
        return true;
      }
    }
    return false;
  }

  async complete(request: any, options?: any): Promise<any> {
    const adapter = this.selectAdapter(request);
    return adapter.complete(request, options);
  }

  async stream(request: any, callbacks: any, options?: any): Promise<any> {
    const adapter = this.selectAdapter(request);
    return adapter.stream(request, callbacks, options);
  }

  private selectAdapter(request: any): ProviderAdapter {
    const modelName = request.config?.model ?? request.model;

    const selected = getAdapterForModel(modelName, this.adapters);
    if (!selected) {
      throw new Error(
        `No adapter found for model "${modelName}". ` +
        `Check vendor config patterns and ensure the model is registered.`
      );
    }
    return selected;
  }

  getAdapterForModel(modelName: string): ProviderAdapter | undefined {
    return getAdapterForModel(modelName, this.adapters);
  }

  getAvailableAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }
}

export function createMembrane(config: MembraneFactoryConfig): Membrane {
  const adapters = new Map<string, ProviderAdapter>();

  patternRoutes = [];
  
  if (config.anthropicProviders && config.anthropicProviders.length > 0) {
    let defaultSet = false;
    for (const providerConfig of config.anthropicProviders) {
      const isDefault = providerConfig.name === 'anthropic' || !defaultSet;
      const adapterKey = isDefault ? 'anthropic' : `anthropic-${providerConfig.name}`;
      if (isDefault) defaultSet = true;

      try {
        const anthropicAdapter = new AnthropicAdapter({
          apiKey: providerConfig.apiKey,
        });
        adapters.set(adapterKey, anthropicAdapter);

        if (providerConfig.provides && providerConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: providerConfig.provides,
          });
        }

        logger.info({
          name: providerConfig.name,
          adapterKey,
          isDefault,
          patterns: providerConfig.provides ?? [],
        }, 'Membrane: Anthropic adapter initialized');
      } catch (error) {
        logger.error({ error, name: providerConfig.name }, 'Failed to create Anthropic adapter');
      }
    }
  } else {
    const anthropicKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      try {
        const anthropicAdapter = new AnthropicAdapter({
          apiKey: anthropicKey,
        });
        adapters.set('anthropic', anthropicAdapter);
        logger.info('Membrane: Anthropic adapter initialized');
      } catch (error) {
        logger.error({ error }, 'Failed to create Anthropic adapter');
      }
    } else {
      logger.debug('Membrane: No Anthropic API key provided, adapter not created');
    }
  }
  
  const openrouterKey = config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    try {
      const openrouterAdapter = new OpenRouterAdapter({
        apiKey: openrouterKey,
        httpReferer: 'https://chapterx.local',
        xTitle: 'ChapterX',
      });
      adapters.set('openrouter', openrouterAdapter);
      logger.info('Membrane: OpenRouter adapter initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to create OpenRouter adapter');
    }
  } else {
    logger.debug('Membrane: No OpenRouter API key provided, adapter not created');
  }
  
  if (config.openaiProviders && config.openaiProviders.length > 0) {
    let defaultSet = false;
    for (const providerConfig of config.openaiProviders) {
      const isDefault = providerConfig.name === 'openai' || !defaultSet;
      const adapterKey = isDefault ? 'openai' : `openai-${providerConfig.name}`;
      if (isDefault) defaultSet = true;

      try {
        const openaiAdapter = new OpenAIAdapter({
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseUrl,
        });
        adapters.set(adapterKey, openaiAdapter);

        if (providerConfig.provides && providerConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: providerConfig.provides,
          });
        }

        logger.info({
          name: providerConfig.name,
          adapterKey,
          isDefault,
          patterns: providerConfig.provides ?? [],
        }, 'Membrane: OpenAI adapter initialized');
      } catch (error) {
        logger.error({ error, name: providerConfig.name }, 'Failed to create OpenAI adapter');
      }
    }
  } else {
    const openaiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const openaiAdapter = new OpenAIAdapter({
          apiKey: openaiKey,
          baseURL: config.openaiBaseUrl,
        });
        adapters.set('openai', openaiAdapter);
        logger.info('Membrane: OpenAI adapter initialized');
      } catch (error) {
        logger.error({ error }, 'Failed to create OpenAI adapter');
      }
    } else {
      logger.debug('Membrane: No OpenAI API key provided, adapter not created');
    }
  }

  const allBedrockConfigs = config.bedrockProviders ?? (config.bedrock ? [config.bedrock] : []);
  for (let i = 0; i < allBedrockConfigs.length; i++) {
    const bc = allBedrockConfigs[i]!;
    const accessKey = bc.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    const secretKey = bc.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
    const hasValidCreds = accessKey && secretKey &&
      !accessKey.includes('YOUR_') && !secretKey.includes('YOUR_');

    if (hasValidCreds) {
      try {
        const adapterKey = i === 0 ? 'bedrock' : `bedrock-${i}`;
        const bedrockAdapter = new BedrockAdapter({
          accessKeyId: accessKey,
          secretAccessKey: secretKey,
          region: bc.region,
          sessionToken: bc.sessionToken,
        });
        adapters.set(adapterKey, bedrockAdapter);

        if (bc.provides && bc.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: bc.provides,
          });
        }

        logger.info({
          adapterKey,
          region: bc.region ?? process.env.AWS_REGION ?? 'us-west-2',
          patterns: bc.provides ?? [],
        }, 'Membrane: Bedrock adapter initialized');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage, region: bc.region }, 'Failed to create Bedrock adapter');
      }
    } else {
      logger.debug({ index: i }, 'Membrane: No valid Bedrock credentials for provider, adapter not created');
    }
  }

  const geminiKey = config.gemini?.apiKey ?? process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const geminiAdapter = new GeminiAdapter({
        apiKey: geminiKey,
      });
      adapters.set('gemini', geminiAdapter);

      if (config.gemini?.provides && config.gemini.provides.length > 0) {
        patternRoutes.push({
          adapterKey: 'gemini',
          patterns: config.gemini.provides,
        });
      }

      logger.info({
        patterns: config.gemini?.provides ?? [],
      }, 'Membrane: Gemini adapter initialized');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to create Gemini adapter');
    }
  } else {
    logger.debug('Membrane: No Google API key provided, Gemini adapter not created');
  }

  if (config.openaiResponsesProviders && config.openaiResponsesProviders.length > 0) {
    for (const providerConfig of config.openaiResponsesProviders) {
      const adapterKey = `openai-responses-${providerConfig.name}`;

      try {
        const responsesAdapter = new OpenAIResponsesAdapter({
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseUrl,
          allowImageEditing: providerConfig.allowImageEditing,
        });
        adapters.set(adapterKey, responsesAdapter);

        if (providerConfig.provides && providerConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: providerConfig.provides,
          });
        }

        logger.info({
          name: providerConfig.name,
          adapterKey,
          patterns: providerConfig.provides ?? [],
        }, 'Membrane: OpenAI Responses adapter initialized');
      } catch (error) {
        logger.error({ error, name: providerConfig.name }, 'Failed to create OpenAI Responses adapter');
      }
    }
  }

  const compatibleConfigs: OpenAICompatibleConfig[] = [];
  
  if (config.openaiCompatible) {
    compatibleConfigs.push(config.openaiCompatible);
  }
  
  if (config.openaiCompatibleProviders) {
    compatibleConfigs.push(...config.openaiCompatibleProviders);
  }
  
  let compatIndex = 0;
  for (const compatConfig of compatibleConfigs) {
    const adapterName = compatConfig.name ?? `openai-compatible-${compatIndex}`;
    const adapterKey = compatIndex === 0 && !config.openaiCompatibleProviders 
      ? 'openai-compatible' 
      : `openai-compatible-${adapterName}`;
    
    try {
      const compatibleAdapter = new OpenAICompatibleAdapter({
        apiKey: compatConfig.apiKey,
        baseURL: compatConfig.baseUrl,
        providerName: adapterName,
      });
      adapters.set(adapterKey, compatibleAdapter);
      
      if (compatConfig.provides && compatConfig.provides.length > 0) {
        patternRoutes.push({
          adapterKey,
          patterns: compatConfig.provides,
        });
      }
      
      logger.info({ 
        name: adapterName,
        adapterKey,
        baseUrl: compatConfig.baseUrl,
        patterns: compatConfig.provides ?? [],
      }, 'Membrane: OpenAI-compatible adapter initialized');
    } catch (error) {
      logger.error({ error, name: adapterName }, 'Failed to create OpenAI-compatible adapter');
    }
    compatIndex++;
  }

  if (config.openaiCompletionsProviders) {
    let completionsIndex = 0;
    for (const completionsConfig of config.openaiCompletionsProviders) {
      const adapterName = completionsConfig.name ?? `openai-completions-${completionsIndex}`;
      const adapterKey = `openai-completions-${adapterName}`;

      try {
        const completionsAdapter = new OpenAICompletionsAdapter({
          apiKey: completionsConfig.apiKey,
          baseURL: completionsConfig.baseUrl,
          assistantName: config.assistantName,
          extraStopSequences: completionsConfig.defaultStopSequences,
          warnOnImageStrip: completionsConfig.warnOnImageStrip,
          eotToken: completionsConfig.eotToken,
        });
        adapters.set(adapterKey, completionsAdapter);

        if (completionsConfig.provides && completionsConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: completionsConfig.provides,
          });
        }

        logger.info({
          name: adapterName,
          adapterKey,
          baseUrl: completionsConfig.baseUrl,
          patterns: completionsConfig.provides ?? [],
        }, 'Membrane: OpenAI Completions adapter initialized (base model mode)');
      } catch (error) {
        logger.error({ error, name: adapterName }, 'Failed to create OpenAI Completions adapter');
      }
      completionsIndex++;
    }
  }

  if (adapters.size === 0) {
    throw new Error(
      'Membrane: No provider adapters could be created. ' +
      'Please provide at least one of: anthropicApiKey, openrouterApiKey, openaiApiKey, bedrock, openaiCompatible, openaiCompatibleProviders, openaiCompletionsProviders, openaiResponsesProviders'
    );
  }
  
  const routingAdapter = new RoutingAdapter(adapters);
  
  const formatter = createFormatter(config);

  const membraneConfig: MembraneConfig = {
    assistantParticipant: config.assistantName,
    maxParticipantsForStop: config.maxParticipantsForStop,
    formatter,
    debug: config.debug,
    retry: config.retries != null ? { maxRetries: config.retries } : undefined,
  };

  const membrane = new Membrane(routingAdapter, membraneConfig);

  logger.info({
    adapters: routingAdapter.getAvailableAdapters(),
    assistantName: config.assistantName,
    formatter: formatter.name,
    patternRoutes: patternRoutes.map(r => ({ key: r.adapterKey, patterns: r.patterns })),
  }, 'Membrane instance created');

  return membrane;
}

function createFormatter(config: MembraneFactoryConfig): PrefillFormatter {
  const formatterType = config.formatter ?? 'anthropic-xml';

  switch (formatterType) {
    case 'native':
      return new NativeFormatter();

    case 'completions':
      return new CompletionsFormatter({
        eotToken: config.completionsConfig?.eotToken,
        nameFormat: config.completionsConfig?.nameFormat,
        messageSeparator: config.completionsConfig?.messageSeparator,
        caseInsensitiveStops: config.completionsConfig?.caseInsensitiveStops,
        maxParticipantsForStop: config.maxParticipantsForStop,
      });

    case 'anthropic-xml':
    default:
      return new AnthropicXmlFormatter({
        maxParticipantsForStop: config.maxParticipantsForStop,
      });
  }
}

export { RoutingAdapter };

/**
 * A vendor's adapter is chosen by how its name starts, checked in this order:
 * - 'anthropic' → Anthropic
 * - 'bedrock' → Bedrock
 * - 'gemini' → Gemini
 * - 'openrouter' → OpenRouter
 * - 'openairesponses' → OpenAI Responses
 * - 'openaicompletion' → OpenAI Completions (base models)
 * - 'openai' → OpenAI, or OpenAI Compatible when it sets a base URL that
 *   doesn't contain api.openai.com
 * A vendor with any other name is OpenAI Compatible if it sets
 * openai_compatible_base_url, and is skipped otherwise.
 */
export interface VendorConfigInput {
  config: Record<string, string>;
  provides?: string[];
  formatter?: FormatterType;
  completions_config?: {
    eot_token?: string;
    name_format?: string;
    message_separator?: string;
    case_insensitive_stops?: boolean;
  };
}

export function createMembraneFromVendorConfigs(
  vendorConfigs: Record<string, VendorConfigInput>,
  assistantName: string,
  options?: {
    formatter?: FormatterType;
    completionsConfig?: MembraneFactoryConfig['completionsConfig'];
    maxParticipantsForStop?: number;
    retries?: number;
  }
): Membrane {
  formatterRoutes = [];

  const anthropicProviders: AnthropicProviderConfig[] = [];
  const openaiProviders: OpenAIProviderConfig[] = [];
  let openrouterApiKey: string | undefined;
  const bedrockProviders: BedrockConfig[] = [];
  let geminiConfig: GeminiConfig | undefined;
  const openaiCompatibleProviders: OpenAICompatibleConfig[] = [];
  const openaiCompletionsProviders: OpenAICompletionsConfig[] = [];
  const openaiResponsesProviders: OpenAIResponsesConfig[] = [];

  let detectedFormatter: FormatterType | undefined;
  let detectedCompletionsConfig: MembraneFactoryConfig['completionsConfig'] | undefined;

  for (const [vendorName, vendorConfig] of Object.entries(vendorConfigs)) {
    const config = vendorConfig.config;
    const apiKey = config?.openai_api_key ?? config?.open_api_key ?? config?.api_key ?? 'not-needed';
    const baseUrl = config?.api_base ?? config?.openai_compatible_base_url ?? config?.openai_completions_base_url;

    if (!detectedFormatter && vendorConfig.formatter) {
      detectedFormatter = vendorConfig.formatter;
      logger.debug({ vendorName, formatter: detectedFormatter }, 'Using formatter from vendor config as default');
    }

    if (vendorConfig.formatter && vendorConfig.provides && vendorConfig.provides.length > 0) {
      formatterRoutes.push({
        patterns: vendorConfig.provides,
        formatter: vendorConfig.formatter,
      });
      logger.debug({ vendorName, formatter: vendorConfig.formatter, patterns: vendorConfig.provides }, 'Registered formatter routes for vendor');
    }

    if (!detectedCompletionsConfig && vendorConfig.completions_config) {
      detectedCompletionsConfig = {
        eotToken: vendorConfig.completions_config.eot_token,
        nameFormat: vendorConfig.completions_config.name_format,
        messageSeparator: vendorConfig.completions_config.message_separator,
        caseInsensitiveStops: vendorConfig.completions_config.case_insensitive_stops,
      };
      logger.debug({ vendorName, completionsConfig: detectedCompletionsConfig }, 'Using completions config from vendor');
    }

    if (vendorName.startsWith('anthropic')) {
      if (config?.anthropic_api_key) {
        anthropicProviders.push({
          apiKey: config.anthropic_api_key,
          name: vendorName,
          provides: vendorConfig.provides,
        });
      }

      if (!detectedFormatter) {
        detectedFormatter = 'anthropic-xml';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found Anthropic vendor (uses native API)');

    } else if (vendorName.startsWith('bedrock')) {
      bedrockProviders.push({
        accessKeyId: config?.aws_access_key_id ?? config?.aws_access_key,
        secretAccessKey: config?.aws_secret_access_key ?? config?.aws_secret_key,
        region: config?.aws_region ?? config?.region,
        sessionToken: config?.aws_session_token ?? config?.session_token,
        provides: vendorConfig.provides,
      });

      if (!detectedFormatter) {
        detectedFormatter = 'anthropic-xml';
      }

      logger.debug({ vendorName, region: config?.aws_region ?? config?.region, provides: vendorConfig.provides }, 'Found Bedrock vendor (uses AWS API)');

    } else if (vendorName.startsWith('gemini')) {
      if (!geminiConfig) {
        const googleKey = config?.google_api_key ?? config?.api_key;
        if (googleKey) {
          geminiConfig = {
            apiKey: googleKey,
            provides: vendorConfig.provides,
          };
        }
      }

      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found Gemini vendor (uses Google AI API)');

    } else if (vendorName.startsWith('openrouter')) {
      if (config?.openrouter_api_key && !openrouterApiKey) {
        openrouterApiKey = config.openrouter_api_key;
      }

      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found OpenRouter vendor (uses native API)');

    } else if (vendorName.startsWith('openairesponses')) {
      const openaiKey = config?.openai_api_key ?? config?.api_key;
      if (openaiKey) {
        const allowEditing = config?.allow_image_editing !== 'false';
        openaiResponsesProviders.push({
          apiKey: openaiKey,
          name: vendorName,
          baseUrl: baseUrl,
          provides: vendorConfig.provides,
          allowImageEditing: allowEditing,
        });
      }

      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found OpenAI Images vendor (/v1/images API)');

    } else if (vendorName.startsWith('openaicompletion')) {
      if (baseUrl) {
        const eotToken = config.eot_token !== undefined ? config.eot_token : vendorConfig.completions_config?.eot_token;
        openaiCompletionsProviders.push({
          apiKey,
          baseUrl,
          name: vendorName,
          provides: vendorConfig.provides,
          eotToken,
        });

        if (!detectedFormatter) {
          detectedFormatter = 'completions';
        }

        logger.debug({ vendorName, baseUrl, eotToken, provides: vendorConfig.provides }, 'Found OpenAI Completions vendor (base model)');
      }

    } else if (vendorName.startsWith('openai')) {
      const isOfficialOpenAI = !baseUrl || baseUrl.includes('api.openai.com');

      if (isOfficialOpenAI) {
        const openaiKey = config?.openai_api_key ?? config?.api_key;
        if (openaiKey) {
          openaiProviders.push({
            apiKey: openaiKey,
            name: vendorName,
            baseUrl: baseUrl,
            provides: vendorConfig.provides,
          });
        }
        logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found OpenAI vendor (official API)');
      } else {
        openaiCompatibleProviders.push({
          apiKey,
          baseUrl,
          name: vendorName,
          provides: vendorConfig.provides,
        });
        logger.debug({ vendorName, baseUrl, provides: vendorConfig.provides }, 'Found OpenAI Compatible vendor');
      }

      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

    } else if (config?.openai_compatible_base_url) {
      openaiCompatibleProviders.push({
        apiKey: config.openai_compatible_api_key ?? apiKey,
        baseUrl: config.openai_compatible_base_url,
        name: vendorName,
        provides: vendorConfig.provides,
      });

      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, baseUrl: config.openai_compatible_base_url, provides: vendorConfig.provides }, 'Found OpenAI Compatible vendor (non-standard prefix)');

    } else {
      logger.warn({ vendorName }, 'Unknown vendor prefix and no openai_compatible_base_url, skipping');
    }
  }

  const finalFormatter = options?.formatter ?? detectedFormatter;
  const finalCompletionsConfig = options?.completionsConfig ?? detectedCompletionsConfig;

  return createMembrane({
    anthropicApiKey: anthropicProviders.length === 1 ? anthropicProviders[0]!.apiKey : undefined,
    anthropicProviders: anthropicProviders.length > 1 ? anthropicProviders : undefined,
    openrouterApiKey,
    openaiApiKey: openaiProviders.length === 1 ? openaiProviders[0]!.apiKey : undefined,
    openaiBaseUrl: openaiProviders.length === 1 ? openaiProviders[0]!.baseUrl : undefined,
    openaiProviders: openaiProviders.length > 1 ? openaiProviders : undefined,
    bedrock: bedrockProviders.length === 1 ? bedrockProviders[0] : undefined,
    bedrockProviders: bedrockProviders.length > 1 ? bedrockProviders : undefined,
    gemini: geminiConfig,
    openaiCompatibleProviders: openaiCompatibleProviders.length > 0 ? openaiCompatibleProviders : undefined,
    openaiCompletionsProviders: openaiCompletionsProviders.length > 0 ? openaiCompletionsProviders : undefined,
    openaiResponsesProviders: openaiResponsesProviders.length > 0 ? openaiResponsesProviders : undefined,
    assistantName,
    formatter: finalFormatter,
    completionsConfig: finalCompletionsConfig,
    maxParticipantsForStop: options?.maxParticipantsForStop,
    retries: options?.retries,
  });
}

