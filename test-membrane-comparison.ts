#!/usr/bin/env npx tsx
/**
 * Membrane A/B Comparison Test
 * 
 * Runs the same prompts through both old middleware and membrane,
 * comparing results to verify parity.
 * 
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx test-membrane-comparison.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx test-membrane-comparison.ts --verbose
 *   ANTHROPIC_API_KEY=sk-... npx tsx test-membrane-comparison.ts --test=basic
 */

import { LLMMiddleware } from './src/llm/middleware.js';
import { AnthropicProvider } from './src/llm/providers/anthropic.js';
import { OpenRouterProvider } from './src/llm/providers/openrouter.js';
import { createMembrane, MembraneProvider } from './src/llm/membrane/index.js';
import type { LLMRequest, ParticipantMessage, ContentBlock } from './src/types.js';

// ============================================================================
// Configuration
// ============================================================================

const VERBOSE = process.argv.includes('--verbose');
const TEST_FILTER = process.argv.find(a => a.startsWith('--test='))?.split('=')[1];

const MODEL = 'claude-3-5-haiku-20241022';  // Fast, cheap for testing
const BOT_NAME = 'TestBot';

// ============================================================================
// Test Cases
// ============================================================================

interface TestCase {
  name: string;
  description: string;
  request: LLMRequest;
  validate?: (oldResult: any, newResult: any) => ValidationResult;
}

interface ValidationResult {
  passed: boolean;
  differences: string[];
}

const TEST_CASES: TestCase[] = [
  {
    name: 'basic',
    description: 'Basic single-turn completion',
    request: {
      messages: [
        msg('User', 'Say hello in exactly 5 words.'),
        msg(BOT_NAME, ''),  // Completion target
      ],
      system_prompt: 'You are a helpful assistant.',
      config: {
        model: MODEL,
        temperature: 0,  // Deterministic
        max_tokens: 100,
        top_p: 1,
        mode: 'prefill',
        botName: BOT_NAME,
      },
    },
  },
  {
    name: 'multi-turn',
    description: 'Multi-turn conversation with context',
    request: {
      messages: [
        msg('Alice', 'Hi Claude, I have a question.'),
        msg(BOT_NAME, 'Hello Alice! I\'d be happy to help. What\'s your question?'),
        msg('Alice', 'What is 2+2?'),
        msg(BOT_NAME, ''),
      ],
      system_prompt: 'You are a helpful math tutor.',
      config: {
        model: MODEL,
        temperature: 0,
        max_tokens: 100,
        top_p: 1,
        mode: 'prefill',
        botName: BOT_NAME,
      },
    },
  },
  {
    name: 'multi-participant',
    description: 'Multiple participants in conversation',
    request: {
      messages: [
        msg('Alice', 'Hey everyone!'),
        msg('Bob', 'Hi Alice!'),
        msg(BOT_NAME, 'Hello Alice and Bob!'),
        msg('Alice', 'Claude, who said hi to me?'),
        msg(BOT_NAME, ''),
      ],
      system_prompt: 'You are in a group chat.',
      config: {
        model: MODEL,
        temperature: 0,
        max_tokens: 100,
        top_p: 1,
        mode: 'prefill',
        botName: BOT_NAME,
      },
    },
  },
  {
    name: 'stop-sequence',
    description: 'Should stop at participant name',
    request: {
      messages: [
        msg('User', 'Write a short dialogue between Alice and Bob.'),
        msg(BOT_NAME, ''),
      ],
      system_prompt: 'You are a creative writer.',
      config: {
        model: MODEL,
        temperature: 0,
        max_tokens: 500,
        top_p: 1,
        mode: 'prefill',
        botName: BOT_NAME,
      },
      stop_sequences: ['\nAlice:', '\nBob:', '\nUser:'],
    },
  },
  {
    name: 'with-tools',
    description: 'Request with tool definitions',
    request: {
      messages: [
        msg('User', 'What time is it?'),
        msg(BOT_NAME, ''),
      ],
      system_prompt: 'You have access to tools. Use them when needed.',
      config: {
        model: MODEL,
        temperature: 0,
        max_tokens: 200,
        top_p: 1,
        mode: 'prefill',
        botName: BOT_NAME,
      },
      tools: [
        {
          name: 'get_time',
          description: 'Get the current time',
          inputSchema: {
            type: 'object',
            properties: {
              timezone: {
                type: 'string',
                description: 'Timezone (e.g., "America/New_York")',
              },
            },
            required: [],
          },
        },
      ],
    },
  },
  {
    name: 'cache-control',
    description: 'Message with cache control marker',
    request: {
      messages: [
        msg('User', 'First message'),
        msgWithCache('User', 'Second message (cache marker)'),
        msg('User', 'Third message'),
        msg(BOT_NAME, ''),
      ],
      system_prompt: 'You are helpful.',
      config: {
        model: MODEL,
        temperature: 0,
        max_tokens: 100,
        top_p: 1,
        mode: 'prefill',
        botName: BOT_NAME,
        prompt_caching: true,
      },
    },
  },
  {
    name: 'long-context',
    description: 'Longer context to test prefill formatting',
    request: {
      messages: [
        msg('User', 'Let me tell you a story...'),
        msg(BOT_NAME, 'I\'d love to hear it!'),
        msg('User', 'Once upon a time, there was a programmer named Alice.'),
        msg(BOT_NAME, 'Interesting! Tell me more about Alice.'),
        msg('User', 'Alice loved writing TypeScript code.'),
        msg(BOT_NAME, 'TypeScript is great! What did Alice build?'),
        msg('User', 'She built a Discord bot framework called ChapterX.'),
        msg(BOT_NAME, 'That sounds like an impressive project!'),
        msg('User', 'It was! Now summarize the story in one sentence.'),
        msg(BOT_NAME, ''),
      ],
      system_prompt: 'You are a storytelling companion.',
      config: {
        model: MODEL,
        temperature: 0,
        max_tokens: 150,
        top_p: 1,
        mode: 'prefill',
        botName: BOT_NAME,
      },
    },
  },
];

// ============================================================================
// Helpers
// ============================================================================

function msg(participant: string, text: string): ParticipantMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
  };
}

function msgWithCache(participant: string, text: string): ParticipantMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
    cacheControl: { type: 'ephemeral' },
  };
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('');
}

// ============================================================================
// Comparison Logic
// ============================================================================

interface ComparisonResult {
  testName: string;
  passed: boolean;
  oldResult: {
    text: string;
    stopReason: string;
    tokens: { input: number; output: number };
    duration: number;
  };
  newResult: {
    text: string;
    stopReason: string;
    tokens: { input: number; output: number };
    duration: number;
  };
  differences: string[];
}

function compareResults(
  testName: string,
  oldResult: any,
  newResult: any,
  oldDuration: number,
  newDuration: number
): ComparisonResult {
  const differences: string[] = [];
  
  const oldText = extractText(oldResult.content);
  const newText = extractText(newResult.content);
  
  // Compare text (allow minor whitespace differences)
  const oldNorm = oldText.trim().replace(/\s+/g, ' ');
  const newNorm = newText.trim().replace(/\s+/g, ' ');
  if (oldNorm !== newNorm) {
    differences.push(`Text mismatch:\n  OLD: "${oldNorm.slice(0, 100)}..."\n  NEW: "${newNorm.slice(0, 100)}..."`);
  }
  
  // Compare stop reason
  if (oldResult.stopReason !== newResult.stopReason) {
    differences.push(`Stop reason: OLD=${oldResult.stopReason}, NEW=${newResult.stopReason}`);
  }
  
  // Compare token counts (allow 5% variance)
  const oldTokens = (oldResult.usage?.inputTokens || 0) + (oldResult.usage?.outputTokens || 0);
  const newTokens = (newResult.usage?.inputTokens || 0) + (newResult.usage?.outputTokens || 0);
  const tokenDiff = Math.abs(oldTokens - newTokens);
  const tokenVariance = tokenDiff / Math.max(oldTokens, 1);
  if (tokenVariance > 0.05) {
    differences.push(`Token count variance ${(tokenVariance * 100).toFixed(1)}%: OLD=${oldTokens}, NEW=${newTokens}`);
  }
  
  return {
    testName,
    passed: differences.length === 0,
    oldResult: {
      text: oldText,
      stopReason: oldResult.stopReason,
      tokens: {
        input: oldResult.usage?.inputTokens || 0,
        output: oldResult.usage?.outputTokens || 0,
      },
      duration: oldDuration,
    },
    newResult: {
      text: newText,
      stopReason: newResult.stopReason,
      tokens: {
        input: newResult.usage?.inputTokens || 0,
        output: newResult.usage?.outputTokens || 0,
      },
      duration: newDuration,
    },
    differences,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         Membrane A/B Comparison Test                           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log();
  
  // Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable required');
    process.exit(1);
  }
  
  // Set up old middleware
  console.log('[SETUP] Initializing old middleware...');
  const middleware = new LLMMiddleware();
  middleware.registerProvider(new AnthropicProvider(apiKey), 'anthropic');
  middleware.setVendorConfigs({
    anthropic: { patterns: ['claude-*'], config: {} },
  });
  
  // Set up membrane
  console.log('[SETUP] Initializing membrane...');
  const membrane = createMembrane({
    anthropicApiKey: apiKey,
    assistantName: BOT_NAME,
  });
  const membraneProvider = new MembraneProvider(membrane, BOT_NAME);
  
  console.log('[SETUP] Ready!\n');
  
  // Filter tests if specified
  const testsToRun = TEST_FILTER 
    ? TEST_CASES.filter(t => t.name === TEST_FILTER)
    : TEST_CASES;
  
  if (testsToRun.length === 0) {
    console.error(`No test found matching: ${TEST_FILTER}`);
    console.log('Available tests:', TEST_CASES.map(t => t.name).join(', '));
    process.exit(1);
  }
  
  // Run tests
  const results: ComparisonResult[] = [];
  
  for (const testCase of testsToRun) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`TEST: ${testCase.name}`);
    console.log(`DESC: ${testCase.description}`);
    console.log();
    
    try {
      // Run old middleware
      console.log('  [OLD] Running with built-in middleware...');
      const oldStart = Date.now();
      const oldResult = await middleware.complete(testCase.request);
      const oldDuration = Date.now() - oldStart;
      
      if (VERBOSE) {
        console.log(`  [OLD] Response: "${extractText(oldResult.content).slice(0, 80)}..."`);
        console.log(`  [OLD] Stop: ${oldResult.stopReason}, Tokens: ${oldResult.usage?.inputTokens}/${oldResult.usage?.outputTokens}`);
      }
      
      // Run membrane
      console.log('  [NEW] Running with membrane...');
      const newStart = Date.now();
      const newResult = await membraneProvider.completeFromLLMRequest(testCase.request);
      const newDuration = Date.now() - newStart;
      
      if (VERBOSE) {
        console.log(`  [NEW] Response: "${extractText(newResult.content).slice(0, 80)}..."`);
        console.log(`  [NEW] Stop: ${newResult.stopReason}, Tokens: ${newResult.usage?.inputTokens}/${newResult.usage?.outputTokens}`);
      }
      
      // Compare
      const comparison = compareResults(testCase.name, oldResult, newResult, oldDuration, newDuration);
      results.push(comparison);
      
      if (comparison.passed) {
        console.log(`  ✅ PASSED`);
      } else {
        console.log(`  ❌ FAILED`);
        for (const diff of comparison.differences) {
          console.log(`     - ${diff}`);
        }
      }
      
      console.log(`  ⏱️  Duration: OLD=${oldDuration}ms, NEW=${newDuration}ms (diff=${newDuration - oldDuration}ms)`);
      
    } catch (error) {
      console.log(`  ❌ ERROR: ${error instanceof Error ? error.message : error}`);
      results.push({
        testName: testCase.name,
        passed: false,
        oldResult: { text: '', stopReason: 'error', tokens: { input: 0, output: 0 }, duration: 0 },
        newResult: { text: '', stopReason: 'error', tokens: { input: 0, output: 0 }, duration: 0 },
        differences: [`Error: ${error instanceof Error ? error.message : error}`],
      });
    }
    
    console.log();
  }
  
  // Summary
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log();
  
  if (failed > 0) {
    console.log('Failed tests:');
    for (const result of results.filter(r => !r.passed)) {
      console.log(`  - ${result.testName}`);
      for (const diff of result.differences) {
        console.log(`      ${diff.split('\n')[0]}`);
      }
    }
  }
  
  // Token usage summary
  const totalOldTokens = results.reduce((sum, r) => sum + r.oldResult.tokens.input + r.oldResult.tokens.output, 0);
  const totalNewTokens = results.reduce((sum, r) => sum + r.newResult.tokens.input + r.newResult.tokens.output, 0);
  console.log();
  console.log(`Total tokens: OLD=${totalOldTokens}, NEW=${totalNewTokens} (diff=${totalNewTokens - totalOldTokens})`);
  
  // Duration summary
  const totalOldDuration = results.reduce((sum, r) => sum + r.oldResult.duration, 0);
  const totalNewDuration = results.reduce((sum, r) => sum + r.newResult.duration, 0);
  console.log(`Total duration: OLD=${totalOldDuration}ms, NEW=${totalNewDuration}ms (diff=${totalNewDuration - totalOldDuration}ms)`);
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);

