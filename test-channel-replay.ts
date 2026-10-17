#!/usr/bin/env npx tsx
/**
 * Channel Replay Test
 * 
 * Fetches real conversation history from a Discord channel and replays it
 * through both old middleware and membrane to compare outputs.
 * 
 * Usage:
 *   # Interactive mode (prompts for channel ID)
 *   ANTHROPIC_API_KEY=sk-... DISCORD_TOKEN=... npx tsx test-channel-replay.ts
 * 
 *   # With channel ID
 *   ANTHROPIC_API_KEY=sk-... DISCORD_TOKEN=... npx tsx test-channel-replay.ts --channel=123456789
 * 
 *   # With guild+channel  
 *   ANTHROPIC_API_KEY=sk-... DISCORD_TOKEN=... npx tsx test-channel-replay.ts --guild=111 --channel=222
 * 
 *   # Limit messages
 *   ... --limit=50
 * 
 *   # Save results to file
 *   ... --output=replay-results.json
 */

import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { LLMMiddleware } from './src/llm/middleware.js';
import { AnthropicProvider } from './src/llm/providers/anthropic.js';
import { createMembrane, MembraneProvider } from './src/llm/membrane/index.js';
import type { LLMRequest, ParticipantMessage, ContentBlock } from './src/types.js';
import * as fs from 'fs';
import * as readline from 'readline';

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg?.split('=')[1];
};

const CHANNEL_ID = getArg('channel');
const GUILD_ID = getArg('guild');
const MESSAGE_LIMIT = parseInt(getArg('limit') || '100', 10);
const OUTPUT_FILE = getArg('output');
const VERBOSE = args.includes('--verbose');

const MODEL = 'claude-3-5-haiku-20241022';
const BOT_NAME = process.env.BOT_NAME || 'TestBot';

// ============================================================================
// Discord Message Fetching
// ============================================================================

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface ConversationTurn {
  participant: string;
  content: string;
  timestamp: Date;
  messageId: string;
}

async function fetchChannelHistory(
  client: Client,
  channelId: string,
  limit: number
): Promise<ConversationTurn[]> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !(channel instanceof TextChannel)) {
    throw new Error(`Channel ${channelId} not found or not a text channel`);
  }

  console.log(`[FETCH] Fetching up to ${limit} messages from #${channel.name}...`);
  
  const messages: Message[] = [];
  let lastId: string | undefined;
  
  while (messages.length < limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, limit - messages.length),
      before: lastId,
    });
    
    if (batch.size === 0) break;
    
    messages.push(...batch.values());
    lastId = batch.last()?.id;
  }
  
  // Convert to conversation turns (reverse to chronological order)
  const turns: ConversationTurn[] = messages
    .reverse()
    .filter(m => m.content.trim().length > 0) // Skip empty messages
    .map(m => ({
      participant: m.author.bot ? BOT_NAME : m.author.username,
      content: m.content,
      timestamp: m.createdAt,
      messageId: m.id,
    }));
  
  console.log(`[FETCH] Got ${turns.length} non-empty messages`);
  return turns;
}

// ============================================================================
// Conversation Segmentation
// ============================================================================

interface ConversationSegment {
  messages: ConversationTurn[];
  expectedBotResponse: string;
}

function segmentConversations(
  turns: ConversationTurn[],
  botName: string
): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  let currentSegment: ConversationTurn[] = [];
  
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    
    if (turn.participant === botName && currentSegment.length > 0) {
      // Bot responded - this completes a segment
      segments.push({
        messages: [...currentSegment],
        expectedBotResponse: turn.content,
      });
      currentSegment.push(turn); // Keep context building
    } else {
      currentSegment.push(turn);
    }
    
    // Limit context window (keep last 20 messages)
    if (currentSegment.length > 20) {
      currentSegment = currentSegment.slice(-20);
    }
  }
  
  return segments;
}

// ============================================================================
// Request Building
// ============================================================================

function buildRequest(segment: ConversationSegment, systemPrompt: string): LLMRequest {
  const messages: ParticipantMessage[] = segment.messages.map(turn => ({
    participant: turn.participant,
    content: [{ type: 'text' as const, text: turn.content }],
  }));
  
  // Add empty completion target
  messages.push({
    participant: BOT_NAME,
    content: [{ type: 'text' as const, text: '' }],
  });
  
  return {
    messages,
    system_prompt: systemPrompt,
    config: {
      model: MODEL,
      temperature: 0,
      max_tokens: 500,
      top_p: 1,
      mode: 'prefill',
      botName: BOT_NAME,
      prompt_caching: true,
    },
  };
}

// ============================================================================
// Comparison
// ============================================================================

interface ReplayResult {
  segmentIndex: number;
  contextLength: number;
  expected: string;
  oldResponse: string;
  membraneResponse: string;
  oldTokens: { input: number; output: number; cacheRead: number };
  membraneTokens: { input: number; output: number; cacheRead: number };
  oldDuration: number;
  membraneDuration: number;
  textSimilarity: number; // 0-1, how similar old vs membrane
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('');
}

function calculateSimilarity(a: string, b: string): number {
  const aNorm = a.toLowerCase().trim();
  const bNorm = b.toLowerCase().trim();
  
  if (aNorm === bNorm) return 1;
  if (!aNorm || !bNorm) return 0;
  
  // Simple word overlap similarity
  const aWords = new Set(aNorm.split(/\s+/));
  const bWords = new Set(bNorm.split(/\s+/));
  const intersection = new Set([...aWords].filter(w => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);
  
  return intersection.size / union.size;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         Channel Replay Test                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log();
  
  // Check env vars
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const discordToken = process.env.DISCORD_TOKEN;
  
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable required');
    process.exit(1);
  }
  
  if (!discordToken) {
    console.error('ERROR: DISCORD_TOKEN environment variable required');
    process.exit(1);
  }
  
  // Get channel ID
  let channelId = CHANNEL_ID;
  if (!channelId) {
    channelId = await prompt('Enter Discord channel ID to replay: ');
  }
  
  if (!channelId) {
    console.error('ERROR: Channel ID required');
    process.exit(1);
  }
  
  // Initialize Discord client
  console.log('[SETUP] Connecting to Discord...');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  
  await client.login(discordToken);
  console.log(`[SETUP] Logged in as ${client.user?.tag}`);
  
  // Fetch history
  const turns = await fetchChannelHistory(client, channelId, MESSAGE_LIMIT);
  
  if (turns.length === 0) {
    console.log('No messages found in channel');
    await client.destroy();
    process.exit(0);
  }
  
  // Segment into testable conversations
  const segments = segmentConversations(turns, BOT_NAME);
  console.log(`[SETUP] Found ${segments.length} bot responses to replay\n`);
  
  if (segments.length === 0) {
    console.log('No bot responses found to replay');
    await client.destroy();
    process.exit(0);
  }
  
  // Set up inference
  console.log('[SETUP] Initializing middleware...');
  const middleware = new LLMMiddleware();
  middleware.registerProvider(new AnthropicProvider(apiKey), 'anthropic');
  middleware.setVendorConfigs({
    anthropic: { provides: ['claude-.*'], config: {} },
  });
  
  console.log('[SETUP] Initializing membrane...');
  const membrane = createMembrane({
    anthropicApiKey: apiKey,
    assistantName: BOT_NAME,
  });
  // Cast to any to work around local vs package type mismatch (runtime is correct)
  const membraneProvider = new MembraneProvider(membrane as any, BOT_NAME);
  
  // Default system prompt (you might want to load from config)
  const systemPrompt = process.env.SYSTEM_PROMPT || 
    'You are a helpful assistant in a Discord chat. Be conversational and friendly.';
  
  // Run replay tests
  const results: ReplayResult[] = [];
  const maxTests = Math.min(segments.length, 10); // Limit to 10 replays to save API calls
  
  console.log(`\n[REPLAY] Running ${maxTests} replay tests...\n`);
  
  for (let i = 0; i < maxTests; i++) {
    const segment = segments[i];
    const request = buildRequest(segment, systemPrompt);
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`TEST ${i + 1}/${maxTests}: Context length ${segment.messages.length} messages`);
    
    if (VERBOSE) {
      console.log(`  Last user message: "${segment.messages[segment.messages.length - 1]?.content.slice(0, 60)}..."`);
      console.log(`  Expected response: "${segment.expectedBotResponse.slice(0, 60)}..."`);
    }
    
    try {
      // Old middleware
      const oldStart = Date.now();
      const oldResult = await middleware.complete(request);
      const oldDuration = Date.now() - oldStart;
      const oldText = extractText(oldResult.content);
      
      // Membrane
      const newStart = Date.now();
      const newResult = await membraneProvider.completeFromLLMRequest(request);
      const newDuration = Date.now() - newStart;
      const newText = extractText(newResult.content);
      
      const similarity = calculateSimilarity(oldText, newText);
      
      results.push({
        segmentIndex: i,
        contextLength: segment.messages.length,
        expected: segment.expectedBotResponse,
        oldResponse: oldText,
        membraneResponse: newText,
        oldTokens: {
          input: oldResult.usage?.inputTokens || 0,
          output: oldResult.usage?.outputTokens || 0,
          cacheRead: oldResult.usage?.cacheReadTokens || 0,
        },
        membraneTokens: {
          input: newResult.usage?.inputTokens || 0,
          output: newResult.usage?.outputTokens || 0,
          cacheRead: newResult.usage?.cacheReadTokens || 0,
        },
        oldDuration,
        membraneDuration: newDuration,
        textSimilarity: similarity,
      });
      
      if (similarity > 0.9) {
        console.log(`  ✅ High similarity (${(similarity * 100).toFixed(1)}%)`);
      } else if (similarity > 0.7) {
        console.log(`  ⚠️  Moderate similarity (${(similarity * 100).toFixed(1)}%)`);
      } else {
        console.log(`  ❌ Low similarity (${(similarity * 100).toFixed(1)}%)`);
      }
      
      console.log(`  ⏱️  OLD=${oldDuration}ms, NEW=${newDuration}ms`);
      console.log(`  📊 Cache: OLD=${oldResult.usage?.cacheReadTokens || 0}, NEW=${newResult.usage?.cacheReadTokens || 0}`);
      
    } catch (error) {
      console.log(`  ❌ Error: ${error instanceof Error ? error.message : error}`);
    }
    
    console.log();
  }
  
  // Summary
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('REPLAY SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  
  const avgSimilarity = results.reduce((sum, r) => sum + r.textSimilarity, 0) / results.length;
  const highSim = results.filter(r => r.textSimilarity > 0.9).length;
  const avgOldDuration = results.reduce((sum, r) => sum + r.oldDuration, 0) / results.length;
  const avgNewDuration = results.reduce((sum, r) => sum + r.membraneDuration, 0) / results.length;
  const totalOldCache = results.reduce((sum, r) => sum + r.oldTokens.cacheRead, 0);
  const totalNewCache = results.reduce((sum, r) => sum + r.membraneTokens.cacheRead, 0);
  
  console.log(`\nTests run: ${results.length}`);
  console.log(`High similarity (>90%): ${highSim}/${results.length}`);
  console.log(`Average similarity: ${(avgSimilarity * 100).toFixed(1)}%`);
  console.log(`\nPerformance:`);
  console.log(`  Avg duration: OLD=${avgOldDuration.toFixed(0)}ms, NEW=${avgNewDuration.toFixed(0)}ms`);
  console.log(`  Total cache reads: OLD=${totalOldCache}, NEW=${totalNewCache}`);
  
  // Save results
  if (OUTPUT_FILE) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${OUTPUT_FILE}`);
  }
  
  // Cleanup
  await client.destroy();
  
  // Exit code
  if (avgSimilarity < 0.7) {
    console.log('\n⚠️  Low average similarity - investigate differences');
    process.exit(1);
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

