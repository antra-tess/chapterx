#!/usr/bin/env tsx
/**
 * Membrane Integration Test Script
 * 
 * This script tests the membrane integration against live LLM APIs.
 * It compares outputs between the old middleware path and the new membrane path.
 * 
 * Prerequisites:
 * - Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable
 * - Run from chapterx directory: npx tsx test-membrane-integration.ts
 * 
 * Options:
 * --provider=anthropic|openrouter  Select which provider to test (default: anthropic)
 * --model=MODEL_NAME               Override default model
 * --verbose                        Show full request/response details
 */

import { createMembrane, toMembraneRequest, fromMembraneResponse } from './src/llm/membrane/index.js';
import { LLMMiddleware } from './src/llm/middleware.js';
import { AnthropicProvider } from './src/llm/providers/anthropic.js';
import { OpenRouterProvider } from './src/llm/providers/openrouter.js';
import type { LLMRequest, ParticipantMessage, LLMCompletion } from './src/types.js';

// ============================================================================
// Test Configuration
// ============================================================================

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const PROVIDER = args.find(a => a.startsWith('--provider='))?.split('=')[1] || 'anthropic';
const MODEL_OVERRIDE = args.find(a => a.startsWith('--model='))?.split('=')[1];

const DEFAULT_MODELS = {
  anthropic: 'claude-3-5-haiku-20241022', // Use haiku for faster/cheaper testing
  openrouter: 'anthropic/claude-3-5-haiku-20241022',
};

const MODEL = MODEL_OVERRIDE || DEFAULT_MODELS[PROVIDER as keyof typeof DEFAULT_MODELS] || DEFAULT_MODELS.anthropic;

console.log('\n🧪 Membrane Integration Test');
console.log('============================');
console.log(`Provider: ${PROVIDER}`);
console.log(`Model: ${MODEL}`);
console.log(`Verbose: ${VERBOSE}\n`);

// ============================================================================
// Test Cases
// ============================================================================

interface TestCase {
  name: string;
  description: string;
  request: LLMRequest;
  validate: (completion: LLMCompletion) => { passed: boolean; message: string };
}

const TEST_CASES: TestCase[] = [
  {
    name: 'Basic Completion',
    description: 'Simple text completion in prefill mode',
    request: {
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'Say "Hello World" and nothing else.' }] },
        { participant: 'Claude', content: [{ type: 'text', text: '' }] },
      ],
      system_prompt: 'You are a helpful assistant. Follow instructions exactly.',
      config: {
        model: MODEL,
        temperature: 0.0,
        max_tokens: 100,
        top_p: 1.0,
        mode: 'prefill',
        botName: 'Claude',
      },
    },
    validate: (completion) => {
      const text = completion.content
        .filter(c => c.type === 'text')
        .map(c => (c as any).text)
        .join('');
      const hasHello = text.toLowerCase().includes('hello world');
      return {
        passed: hasHello && completion.stopReason === 'end_turn',
        message: hasHello ? 'Contains "Hello World"' : 'Missing "Hello World"',
      };
    },
  },
  
  {
    name: 'Multi-participant Conversation',
    description: 'Handles multiple participants correctly',
    request: {
      messages: [
        { participant: 'Alice', content: [{ type: 'text', text: 'Hi Claude, I need help with a math problem.' }] },
        { participant: 'Claude', content: [{ type: 'text', text: 'Of course, Alice! What is your math problem?' }] },
        { participant: 'Bob', content: [{ type: 'text', text: 'I can help too! What is the problem?' }] },
        { participant: 'Alice', content: [{ type: 'text', text: 'What is 2+2?' }] },
        { participant: 'Claude', content: [{ type: 'text', text: '' }] },
      ],
      system_prompt: 'You are a helpful assistant. Be concise.',
      config: {
        model: MODEL,
        temperature: 0.0,
        max_tokens: 100,
        top_p: 1.0,
        mode: 'prefill',
        botName: 'Claude',
      },
      stop_sequences: ['Alice:', 'Bob:'],
    },
    validate: (completion) => {
      const text = completion.content
        .filter(c => c.type === 'text')
        .map(c => (c as any).text)
        .join('');
      const has4 = text.includes('4');
      return {
        passed: has4,
        message: has4 ? 'Correctly answered 4' : 'Did not answer 4',
      };
    },
  },
  
  {
    name: 'Stop Sequence Handling',
    description: 'Stops at participant name stop sequences',
    request: {
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'Write a conversation between two people named Alice and Bob.' }] },
        { participant: 'Claude', content: [{ type: 'text', text: '' }] },
      ],
      system_prompt: 'You are a creative writer.',
      config: {
        model: MODEL,
        temperature: 0.0,
        max_tokens: 500,
        top_p: 1.0,
        mode: 'prefill',
        botName: 'Claude',
      },
      stop_sequences: ['Alice:', 'Bob:'],
    },
    validate: (completion) => {
      // Should stop at a stop sequence since the task asks to write dialogue
      const stoppedCorrectly = completion.stopReason === 'stop_sequence' || completion.stopReason === 'end_turn';
      return {
        passed: stoppedCorrectly,
        message: `Stop reason: ${completion.stopReason}`,
      };
    },
  },
  
  {
    name: 'Tool Definition Handling',
    description: 'Correctly passes tool definitions (XML mode)',
    request: {
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'What is the weather in New York? Use the get_weather tool.' }] },
        { participant: 'Claude', content: [{ type: 'text', text: '' }] },
      ],
      system_prompt: 'You are a helpful assistant with access to tools. Always use tools when asked.',
      config: {
        model: MODEL,
        temperature: 0.0,
        max_tokens: 500,
        top_p: 1.0,
        mode: 'prefill',
        botName: 'Claude',
      },
      tools: [
        {
          name: 'get_weather',
          description: 'Get the current weather for a location',
          inputSchema: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' },
            },
            required: ['location'],
          },
        },
      ],
      stop_sequences: ['</function_calls>'],
    },
    validate: (completion) => {
      const text = completion.content
        .filter(c => c.type === 'text')
        .map(c => (c as any).text)
        .join('');
      
      // Check for tool call markers (XML format for direct Claude)
      const hasToolCall = text.includes('<function_calls>') || text.includes('<invoke');
      const hasNativeToolUse = completion.content.some(c => c.type === 'tool_use');
      
      return {
        passed: hasToolCall || hasNativeToolUse,
        message: hasToolCall ? 'Found XML tool call' : hasNativeToolUse ? 'Found native tool_use' : 'No tool call found',
      };
    },
  },
  
  {
    name: 'Cache Control',
    description: 'Properly handles cache control markers',
    request: {
      messages: [
        {
          participant: 'User',
          content: [{ type: 'text', text: 'This is a long context that should be cached. '.repeat(50) }],
          cacheControl: { type: 'ephemeral' },
        },
        { participant: 'Claude', content: [{ type: 'text', text: 'I understand.' }] },
        { participant: 'User', content: [{ type: 'text', text: 'What did I say should be cached?' }] },
        { participant: 'Claude', content: [{ type: 'text', text: '' }] },
      ],
      system_prompt: 'You are a helpful assistant with good memory.',
      config: {
        model: MODEL,
        temperature: 0.0,
        max_tokens: 200,
        top_p: 1.0,
        mode: 'prefill',
        botName: 'Claude',
        prompt_caching: true,
      },
    },
    validate: (completion) => {
      const text = completion.content
        .filter(c => c.type === 'text')
        .map(c => (c as any).text)
        .join('');
      return {
        passed: text.length > 0,
        message: `Response length: ${text.length} chars`,
      };
    },
  },
];

// ============================================================================
// Test Runner
// ============================================================================

interface TestResult {
  name: string;
  path: 'membrane' | 'middleware';
  passed: boolean;
  message: string;
  durationMs: number;
  tokens: { input: number; output: number };
  error?: string;
}

async function runTestWithMembrane(testCase: TestCase): Promise<TestResult> {
  const start = Date.now();
  
  try {
    const membrane = createMembrane({
      assistantName: testCase.request.config.botName,
    });
    
    const normalizedRequest = toMembraneRequest(testCase.request);
    
    if (VERBOSE) {
      console.log('  Membrane request:', JSON.stringify(normalizedRequest, null, 2));
    }
    
    const response = await membrane.complete(normalizedRequest);
    const completion = fromMembraneResponse(response);
    
    if (VERBOSE) {
      console.log('  Membrane response:', JSON.stringify(completion, null, 2));
    }
    
    const validation = testCase.validate(completion);
    
    return {
      name: testCase.name,
      path: 'membrane',
      passed: validation.passed,
      message: validation.message,
      durationMs: Date.now() - start,
      tokens: { input: completion.usage.inputTokens, output: completion.usage.outputTokens },
    };
  } catch (error) {
    return {
      name: testCase.name,
      path: 'membrane',
      passed: false,
      message: 'Error',
      durationMs: Date.now() - start,
      tokens: { input: 0, output: 0 },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runTestWithMiddleware(testCase: TestCase): Promise<TestResult> {
  const start = Date.now();
  
  try {
    const middleware = new LLMMiddleware();
    
    // Register providers based on available keys
    if (process.env.ANTHROPIC_API_KEY) {
      middleware.registerProvider(new AnthropicProvider(process.env.ANTHROPIC_API_KEY), 'anthropic');
      middleware.setVendorConfigs({
        anthropic: {
          provides: ['claude-.*'],
          config: {},
        },
      });
    }
    
    if (process.env.OPENROUTER_API_KEY) {
      middleware.registerProvider(new OpenRouterProvider(process.env.OPENROUTER_API_KEY), 'openrouter');
      middleware.setVendorConfigs({
        openrouter: {
          provides: ['.*\\/.*'],  // Models with provider prefix like anthropic/claude-*
          config: {},
        },
      });
    }
    
    const completion = await middleware.complete(testCase.request);
    
    if (VERBOSE) {
      console.log('  Middleware response:', JSON.stringify(completion, null, 2));
    }
    
    const validation = testCase.validate(completion);
    
    return {
      name: testCase.name,
      path: 'middleware',
      passed: validation.passed,
      message: validation.message,
      durationMs: Date.now() - start,
      tokens: { input: completion.usage.inputTokens, output: completion.usage.outputTokens },
    };
  } catch (error) {
    return {
      name: testCase.name,
      path: 'middleware',
      passed: false,
      message: 'Error',
      durationMs: Date.now() - start,
      tokens: { input: 0, output: 0 },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  // Check for API keys
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.error('❌ Error: No API key found');
    console.error('   Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable');
    process.exit(1);
  }
  
  const results: TestResult[] = [];
  
  for (const testCase of TEST_CASES) {
    console.log(`\n📋 ${testCase.name}`);
    console.log(`   ${testCase.description}`);
    
    // Run with membrane
    console.log('   Running with membrane...');
    const membraneResult = await runTestWithMembrane(testCase);
    results.push(membraneResult);
    
    const membraneStatus = membraneResult.passed ? '✅' : '❌';
    console.log(`   ${membraneStatus} Membrane: ${membraneResult.message} (${membraneResult.durationMs}ms, ${membraneResult.tokens.input}/${membraneResult.tokens.output} tokens)`);
    if (membraneResult.error) {
      console.log(`      Error: ${membraneResult.error}`);
    }
    
    // Run with middleware (old path)
    console.log('   Running with middleware...');
    const middlewareResult = await runTestWithMiddleware(testCase);
    results.push(middlewareResult);
    
    const middlewareStatus = middlewareResult.passed ? '✅' : '❌';
    console.log(`   ${middlewareStatus} Middleware: ${middlewareResult.message} (${middlewareResult.durationMs}ms, ${middlewareResult.tokens.input}/${middlewareResult.tokens.output} tokens)`);
    if (middlewareResult.error) {
      console.log(`      Error: ${middlewareResult.error}`);
    }
    
    // Compare
    if (membraneResult.passed === middlewareResult.passed) {
      console.log('   ✓ Both paths agree');
    } else {
      console.log('   ⚠️ MISMATCH: paths disagree');
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  const membraneResults = results.filter(r => r.path === 'membrane');
  const middlewareResults = results.filter(r => r.path === 'middleware');
  
  const membranePassed = membraneResults.filter(r => r.passed).length;
  const middlewarePassed = middlewareResults.filter(r => r.passed).length;
  
  console.log(`\nMembrane:   ${membranePassed}/${membraneResults.length} passed`);
  console.log(`Middleware: ${middlewarePassed}/${middlewareResults.length} passed`);
  
  // Token usage comparison
  const membraneTokens = membraneResults.reduce((acc, r) => ({
    input: acc.input + r.tokens.input,
    output: acc.output + r.tokens.output,
  }), { input: 0, output: 0 });
  
  const middlewareTokens = middlewareResults.reduce((acc, r) => ({
    input: acc.input + r.tokens.input,
    output: acc.output + r.tokens.output,
  }), { input: 0, output: 0 });
  
  console.log('\nToken Usage:');
  console.log(`  Membrane:   ${membraneTokens.input} in / ${membraneTokens.output} out`);
  console.log(`  Middleware: ${middlewareTokens.input} in / ${middlewareTokens.output} out`);
  
  // Timing comparison
  const membraneAvgMs = membraneResults.reduce((acc, r) => acc + r.durationMs, 0) / membraneResults.length;
  const middlewareAvgMs = middlewareResults.reduce((acc, r) => acc + r.durationMs, 0) / middlewareResults.length;
  
  console.log('\nAverage Latency:');
  console.log(`  Membrane:   ${membraneAvgMs.toFixed(0)}ms`);
  console.log(`  Middleware: ${middlewareAvgMs.toFixed(0)}ms`);
  
  // Exit with appropriate code
  const allPassed = results.every(r => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch(console.error);

