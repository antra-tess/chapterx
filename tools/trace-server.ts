#!/usr/bin/env npx tsx
/**
 * Trace Viewer Web Server
 * 
 * A web UI for debugging activation traces across multiple bots.
 * Supports authentication, multi-bot views, and channel name resolution.
 * 
 * Environment variables:
 *   PORT          - Server port (default: 3847)
 *   AUTH_TOKEN    - Bearer token for authentication (optional, no auth if not set)
 *   LOGS_DIR      - Base logs directory (default: ./logs)
 *   BOTS_CONFIG   - Path to bots config directory for channel name lookup
 * 
 * Usage:
 *   ./tools/trace-server.ts
 *   AUTH_TOKEN=secret PORT=3847 ./tools/trace-server.ts
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { ActivationTrace, TraceIndex } from '../src/trace/types.js'

const PORT = parseInt(process.env.PORT || '3847', 10)
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const LOGS_DIR = process.env.LOGS_DIR || './logs'
const TRACE_DIR = join(LOGS_DIR, 'traces')

// Channel name cache (loaded from traces)
const channelNameCache = new Map<string, string>()

// ============================================================================
// Data Loading
// ============================================================================

function discoverBots(): string[] {
  if (!existsSync(TRACE_DIR)) return []
  
  return readdirSync(TRACE_DIR)
    .filter(name => {
      const path = join(TRACE_DIR, name)
      return statSync(path).isDirectory() && name !== 'index.jsonl'
    })
}

function loadIndex(botName?: string): (TraceIndex & { filename: string, botName?: string })[] {
  const indexFile = join(TRACE_DIR, 'index.jsonl')
  if (!existsSync(indexFile)) return []
  
  const entries = readFileSync(indexFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) } 
      catch { return null }
    })
    .filter(Boolean) as (TraceIndex & { filename: string, botName?: string })[]
  
  // Cache channel names from entries
  for (const entry of entries) {
    if (entry.channelName && entry.channelId) {
      channelNameCache.set(entry.channelId, entry.channelName)
    }
  }
  
  // Filter by bot if specified
  if (botName) {
    return entries.filter(e => e.botName === botName)
  }
  
  return entries
}

function loadTrace(traceId: string): ActivationTrace | null {
  // Search in all bot directories
  const bots = discoverBots()
  
  for (const bot of bots) {
    const botDir = join(TRACE_DIR, bot)
    const files = readdirSync(botDir).filter(f => 
      f.includes(traceId) && f.endsWith('.json')
    )
    if (files.length > 0) {
      const content = readFileSync(join(botDir, files[0]!), 'utf-8')
      return JSON.parse(content)
    }
  }
  
  // Also check root trace dir for legacy format
  const rootFiles = readdirSync(TRACE_DIR).filter(f => 
    f.includes(traceId) && f.endsWith('.json') && !f.includes('index')
  )
  if (rootFiles.length > 0) {
    const content = readFileSync(join(TRACE_DIR, rootFiles[0]!), 'utf-8')
    return JSON.parse(content)
  }
  
  return null
}

function loadRequestBody(ref: string): any {
  const path = join(LOGS_DIR, 'llm-requests', ref)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function loadResponseBody(ref: string): any {
  const path = join(LOGS_DIR, 'llm-responses', ref)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function getChannelName(channelId: string): string {
  return channelNameCache.get(channelId) || channelId
}

// ============================================================================
// Authentication
// ============================================================================

function checkAuth(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true // No auth required if no token set
  
  const authHeader = req.headers.authorization
  if (!authHeader) return false
  
  // Support both "Bearer <token>" and just "<token>"
  const token = authHeader.startsWith('Bearer ') 
    ? authHeader.slice(7) 
    : authHeader
  
  return token === AUTH_TOKEN
}

// ============================================================================
// API Handlers
// ============================================================================

function handleApi(req: IncomingMessage, res: ServerResponse, path: string): void {
  res.setHeader('Content-Type', 'application/json')
  
  // Check authentication for all API endpoints
  if (!checkAuth(req)) {
    res.statusCode = 401
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }
  
  try {
    // GET /api/bots - List available bots
    if (path === '/api/bots') {
      const bots = discoverBots()
      res.end(JSON.stringify({ bots }))
      return
    }
    
    // GET /api/search?q=<messageId or URL>&bot=<botName>
    if (path.startsWith('/api/search')) {
      const url = new URL(req.url!, `http://localhost:${PORT}`)
      const query = url.searchParams.get('q') || ''
      const botFilter = url.searchParams.get('bot') || undefined
      
      // Extract message ID from Discord URL or use directly
      let messageId = query
      const urlMatch = query.match(/\/channels\/\d+\/\d+\/(\d+)/)
      if (urlMatch) {
        messageId = urlMatch[1]!
      }
      
      const index = loadIndex(botFilter)
      const results: Array<{
        traceId: string
        timestamp: string
        role: 'trigger' | 'context' | 'sent'
        position?: number
        success: boolean
        responsePreview?: string
        botName?: string
        channelName?: string
      }> = []
      
      for (const entry of index) {
        if (entry.triggeringMessageId === messageId) {
          const trace = loadTrace(entry.traceId)
          results.push({
            traceId: entry.traceId,
            timestamp: String(entry.timestamp),
            role: 'trigger',
            success: entry.success,
            responsePreview: trace?.outcome?.responseText?.slice(0, 100),
            botName: entry.botName,
            channelName: getChannelName(entry.channelId),
          })
        } else if (entry.contextMessageIds?.includes(messageId)) {
          const trace = loadTrace(entry.traceId)
          const msg = trace?.contextBuild?.messages.find(m => m.discordMessageId === messageId)
          results.push({
            traceId: entry.traceId,
            timestamp: String(entry.timestamp),
            role: 'context',
            position: msg?.position,
            success: entry.success,
            botName: entry.botName,
            channelName: getChannelName(entry.channelId),
          })
        } else if (entry.sentMessageIds?.includes(messageId)) {
          results.push({
            traceId: entry.traceId,
            timestamp: String(entry.timestamp),
            role: 'sent',
            success: entry.success,
            botName: entry.botName,
            channelName: getChannelName(entry.channelId),
          })
        }
      }
      
      res.end(JSON.stringify({ messageId, results }))
      return
    }
    
    // GET /api/traces - List recent traces
    if (path === '/api/traces') {
      const url = new URL(req.url!, `http://localhost:${PORT}`)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const channel = url.searchParams.get('channel')
      const failed = url.searchParams.get('failed') === 'true'
      const botFilter = url.searchParams.get('bot') || undefined
      
      let entries = loadIndex(botFilter).reverse()
      if (channel) entries = entries.filter(e => e.channelId === channel)
      if (failed) entries = entries.filter(e => !e.success)
      
      // Add channel names to entries
      const enrichedEntries = entries.slice(0, limit).map(e => ({
        ...e,
        channelName: getChannelName(e.channelId),
      }))
      
      res.end(JSON.stringify(enrichedEntries))
      return
    }
    
    // GET /api/trace/<id>
    if (path.startsWith('/api/trace/')) {
      const traceId = path.split('/')[3]
      const trace = loadTrace(traceId!)
      if (!trace) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'Trace not found' }))
        return
      }
      res.end(JSON.stringify(trace))
      return
    }
    
    // GET /api/request/<ref>
    if (path.startsWith('/api/request/')) {
      const ref = path.split('/')[3]
      const body = loadRequestBody(ref!)
      if (!body) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'Request body not found' }))
        return
      }
      res.end(JSON.stringify(body))
      return
    }
    
    // GET /api/response/<ref>
    if (path.startsWith('/api/response/')) {
      const ref = path.split('/')[3]
      const body = loadResponseBody(ref!)
      if (!body) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'Response body not found' }))
        return
      }
      res.end(JSON.stringify(body))
      return
    }
    
    // GET /api/channels - List known channels
    if (path === '/api/channels') {
      const channels = Array.from(channelNameCache.entries()).map(([id, name]) => ({
        id,
        name,
      }))
      res.end(JSON.stringify({ channels }))
      return
    }
    
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'Not found' }))
  } catch (error) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(error) }))
  }
}

// ============================================================================
// HTML UI
// ============================================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trace Viewer</title>
  <style>
    :root {
      --bg: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --success: #3fb950;
      --error: #f85149;
      --warning: #d29922;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    
    h1 {
      font-size: 1.5rem;
      color: var(--text);
    }
    
    .bot-selector {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .bot-selector label {
      color: var(--text-muted);
      font-size: 0.9rem;
    }
    
    .bot-selector select {
      padding: 8px 12px;
      font-size: 0.9rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      outline: none;
      cursor: pointer;
      min-width: 150px;
    }
    
    .bot-selector select:focus {
      border-color: var(--accent);
    }
    
    .auth-form {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--bg);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    
    .auth-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 32px;
      width: 400px;
      text-align: center;
    }
    
    .auth-box h2 {
      margin-bottom: 20px;
      color: var(--text);
    }
    
    .auth-box input {
      width: 100%;
      padding: 12px 16px;
      font-size: 1rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      outline: none;
      margin-bottom: 16px;
    }
    
    .auth-box input:focus {
      border-color: var(--accent);
    }
    
    .auth-box button {
      width: 100%;
      padding: 12px 24px;
      font-size: 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }
    
    .auth-error {
      color: var(--error);
      margin-top: 12px;
      display: none;
    }
    
    .search-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }
    
    .search-box label {
      display: block;
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    
    .search-input-row {
      display: flex;
      gap: 12px;
    }
    
    .search-input-row input {
      flex: 1;
      padding: 12px 16px;
      font-size: 1rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      outline: none;
    }
    
    .search-input-row input:focus {
      border-color: var(--accent);
    }
    
    .search-input-row button {
      padding: 12px 24px;
      font-size: 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }
    
    .search-input-row button:hover {
      opacity: 0.9;
    }
    
    .results {
      margin-top: 20px;
    }
    
    .result-card {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    
    .result-card:hover {
      border-color: var(--accent);
    }
    
    .result-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    
    .result-role {
      font-size: 0.75rem;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
    }
    
    .result-role.trigger { background: var(--accent); color: white; }
    .result-role.context { background: var(--bg); color: var(--text-muted); }
    .result-role.sent { background: var(--success); color: white; }
    
    .result-trace-id {
      font-family: monospace;
      color: var(--accent);
    }
    
    .result-time {
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    
    .result-preview {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-top: 8px;
    }
    
    .status-icon {
      margin-left: 8px;
    }
    
    .status-icon.success { color: var(--success); }
    .status-icon.error { color: var(--error); }
    
    .bot-badge {
      font-size: 0.7rem;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--bg);
      color: var(--accent);
      margin-left: 8px;
      font-weight: 500;
    }
    
    .channel-name {
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    
    /* Trace Detail View */
    .trace-view {
      display: none;
    }
    
    .trace-view.active {
      display: block;
    }
    
    .back-button {
      background: none;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 20px;
    }
    
    .back-button:hover {
      background: var(--bg-secondary);
    }
    
    .section {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    
    .section-header {
      padding: 12px 16px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
    }
    
    .section-header:hover {
      background: var(--border);
    }
    
    .section-header h3 {
      font-size: 0.9rem;
      font-weight: 600;
    }
    
    .section-content {
      padding: 16px;
      display: none;
    }
    
    .section.open .section-content {
      display: block;
    }
    
    .section-toggle {
      color: var(--text-muted);
    }
    
    .message-list {
      max-height: 400px;
      overflow-y: auto;
    }
    
    .message-item {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    
    .message-item:hover {
      background: var(--bg-tertiary);
    }
    
    .message-item:last-child {
      border-bottom: none;
    }
    
    .message-author {
      font-weight: 600;
      color: var(--accent);
      margin-right: 8px;
    }
    
    .message-content {
      color: var(--text);
    }
    
    .message-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 4px;
    }
    
    .message-expanded {
      background: var(--bg);
      padding: 12px;
      margin-top: 8px;
      border-radius: 4px;
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 0.85rem;
      display: none;
    }
    
    .message-item.expanded .message-expanded {
      display: block;
    }
    
    .trigger-badge {
      background: var(--warning);
      color: black;
      font-size: 0.7rem;
      padding: 2px 6px;
      border-radius: 3px;
      margin-left: 8px;
      font-weight: 600;
    }
    
    .cache-badge {
      background: #10b981;
      color: white;
      font-size: 0.7rem;
      padding: 2px 6px;
      border-radius: 3px;
      margin-left: 8px;
      font-weight: 600;
    }
    
    .cache-marker-msg {
      border-left: 3px solid #10b981 !important;
      background: rgba(16, 185, 129, 0.1) !important;
    }
    
    .log-entry {
      font-family: monospace;
      font-size: 0.8rem;
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
    }
    
    .log-entry.error { color: var(--error); }
    .log-entry.warn { color: var(--warning); }
    .log-entry.info { color: var(--text); }
    .log-entry.debug { color: var(--text-muted); }
    
    .log-time {
      color: var(--text-muted);
      margin-right: 8px;
    }
    
    .log-level {
      font-weight: 600;
      margin-right: 8px;
      min-width: 50px;
      display: inline-block;
    }
    
    .json-view {
      background: var(--bg);
      padding: 16px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: monospace;
      font-size: 0.85rem;
      white-space: pre-wrap;
      max-height: 500px;
      overflow-y: auto;
    }
    
    .token-bar {
      display: flex;
      height: 24px;
      border-radius: 4px;
      overflow: hidden;
      margin: 12px 0;
    }
    
    .token-segment {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      font-weight: 600;
      color: white;
    }
    
    .token-segment.system { background: #6366f1; }
    .token-segment.messages { background: #22c55e; }
    .token-segment.images { background: #f59e0b; }
    .token-segment.tools { background: #ef4444; }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }
    
    .stat-box {
      background: var(--bg);
      padding: 12px;
      border-radius: 4px;
      text-align: center;
    }
    
    .stat-value {
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--accent);
    }
    
    .stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
    }
    
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--text-muted);
    }
    
    .search-hint {
      margin-top: 12px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    
    .llm-call {
      background: var(--bg);
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    
    .llm-call-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    
    .llm-call-stats {
      display: flex;
      gap: 16px;
      font-size: 0.85rem;
      color: var(--text-muted);
      flex-wrap: wrap;
    }
    
    .view-json-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    
    .view-json-btn:hover {
      background: var(--border);
    }
    
    .filters {
      display: flex;
      gap: 12px;
      margin-top: 12px;
    }
    
    .filter-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    
    .filter-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    
    .outcome-success {
      color: var(--success);
      font-weight: 600;
    }
    
    .outcome-error {
      color: var(--error);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <!-- Auth Form (shown if auth required) -->
  <div id="authForm" class="auth-form" style="display: none;">
    <div class="auth-box">
      <h2>🔐 Authentication Required</h2>
      <input type="password" id="authToken" placeholder="Enter access token">
      <button onclick="authenticate()">Sign In</button>
      <div id="authError" class="auth-error">Invalid token</div>
    </div>
  </div>
  
  <div id="mainContent" class="container">
    <div class="header">
      <h1>🔍 Trace Viewer</h1>
      <div class="bot-selector">
        <label>Bot:</label>
        <select id="botSelect" onchange="onBotChange()">
          <option value="">All Bots</option>
        </select>
      </div>
    </div>
    
    <!-- Search View -->
    <div id="searchView">
      <div class="search-box">
        <label>Paste Discord message link or ID</label>
        <div class="search-input-row">
          <input type="text" id="searchInput" placeholder="https://discord.com/channels/123/456/789... or just 789...">
          <button onclick="search()">Find Traces</button>
        </div>
        <div class="search-hint">
          Tip: Right-click any Discord message → Copy Message Link
        </div>
      </div>
      
      <div id="searchResults"></div>
      
      <div id="recentTraces">
        <h2 style="font-size: 1rem; margin-bottom: 12px; color: var(--text-muted);">Recent Traces</h2>
        <div id="recentList"></div>
      </div>
    </div>
    
    <!-- Trace Detail View -->
    <div id="traceView" class="trace-view">
      <button class="back-button" onclick="showSearch()">← Back to Search</button>
      <div id="traceContent"></div>
    </div>
  </div>
  
  <script>
    // State
    let currentTrace = null;
    let authToken = localStorage.getItem('trace_viewer_token') || '';
    let currentBot = '';
    
    // Check if auth is required
    async function checkAuth() {
      try {
        const res = await fetch('/api/bots', {
          headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {}
        });
        if (res.status === 401) {
          document.getElementById('authForm').style.display = 'flex';
          document.getElementById('mainContent').style.display = 'none';
          return false;
        }
        return true;
      } catch (e) {
        return false;
      }
    }
    
    async function authenticate() {
      const token = document.getElementById('authToken').value;
      try {
        const res = await fetch('/api/bots', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (res.ok) {
          authToken = token;
          localStorage.setItem('trace_viewer_token', token);
          document.getElementById('authForm').style.display = 'none';
          document.getElementById('mainContent').style.display = 'block';
          init();
        } else {
          document.getElementById('authError').style.display = 'block';
        }
      } catch (e) {
        document.getElementById('authError').style.display = 'block';
      }
    }
    
    // Initialize
    document.addEventListener('DOMContentLoaded', async () => {
      const authed = await checkAuth();
      if (authed) {
        document.getElementById('authForm').style.display = 'none';
        init();
      }
      
      // Enter key to auth
      document.getElementById('authToken').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') authenticate();
      });
    });
    
    async function init() {
      await loadBots();
      loadRecentTraces();
      
      // Check URL for initial trace view or search
      const path = window.location.pathname;
      const traceMatch = path.match(/^\\/trace\\/([a-zA-Z0-9-]+)/);
      if (traceMatch) {
        // Direct link to trace
        loadTrace(traceMatch[1]);
      } else {
        // Check for search query
        const params = new URLSearchParams(window.location.search);
        const q = params.get('q');
        if (q) {
          document.getElementById('searchInput').value = q;
          search();
        }
      }
      
      // Enter key to search
      document.getElementById('searchInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') search();
      });
    }
    
    async function loadBots() {
      const res = await apiFetch('/api/bots');
      const data = await res.json();
      const select = document.getElementById('botSelect');
      
      for (const bot of data.bots) {
        const option = document.createElement('option');
        option.value = bot;
        option.textContent = bot;
        select.appendChild(option);
      }
    }
    
    function onBotChange() {
      currentBot = document.getElementById('botSelect').value;
      loadRecentTraces();
    }
    
    function apiFetch(url, options = {}) {
      return fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          ...(authToken ? { 'Authorization': 'Bearer ' + authToken } : {})
        }
      });
    }
    
    async function loadRecentTraces() {
      let url = '/api/traces?limit=10';
      if (currentBot) url += '&bot=' + encodeURIComponent(currentBot);
      
      const res = await apiFetch(url);
      const traces = await res.json();
      
      const html = traces.map(t => \`
        <div class="result-card" onclick="loadTrace('\${t.traceId}')">
          <div class="result-header">
            <span class="result-trace-id">\${t.traceId}</span>
            <span class="result-time">\${new Date(t.timestamp).toLocaleString()}</span>
          </div>
          <div>
            <span class="channel-name">\${t.channelName || t.channelId.slice(-8)}</span>
            \${t.botName ? \`<span class="bot-badge">\${t.botName}</span>\` : ''}
            <span class="status-icon \${t.success ? 'success' : 'error'}">\${t.success ? '✓' : '✗'}</span>
            <span style="color: var(--text-muted); margin-left: 12px;">
              \${t.llmCallCount} LLM calls, \${formatTokens(t.totalTokens)} tokens
            </span>
          </div>
        </div>
      \`).join('');
      
      document.getElementById('recentList').innerHTML = html || '<div class="empty-state">No traces yet</div>';
    }
    
    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;
      
      let url = '/api/search?q=' + encodeURIComponent(query);
      if (currentBot) url += '&bot=' + encodeURIComponent(currentBot);
      
      const res = await apiFetch(url);
      const data = await res.json();
      
      if (data.results.length === 0) {
        document.getElementById('searchResults').innerHTML = \`
          <div class="empty-state">
            <p>No traces found containing message <code>\${data.messageId}</code></p>
            <p style="margin-top: 8px;">This message may not have been processed by the bot, or traces may have been cleaned up.</p>
          </div>
        \`;
        return;
      }
      
      const html = data.results.map(r => \`
        <div class="result-card" onclick="loadTrace('\${r.traceId}')">
          <div class="result-header">
            <div>
              <span class="result-role \${r.role}">\${r.role}</span>
              <span class="result-trace-id" style="margin-left: 12px;">\${r.traceId}</span>
              \${r.botName ? \`<span class="bot-badge">\${r.botName}</span>\` : ''}
              <span class="status-icon \${r.success ? 'success' : 'error'}">\${r.success ? '✓' : '✗'}</span>
            </div>
            <span class="result-time">\${new Date(r.timestamp).toLocaleString()}</span>
          </div>
          <div class="channel-name">\${r.channelName || 'Unknown channel'}</div>
          \${r.role === 'trigger' ? \`<div class="result-preview">Response: "\${r.responsePreview || '(no response)'}..."</div>\` : ''}
          \${r.role === 'context' && r.position !== undefined ? \`<div class="result-preview">Position in context: #\${r.position}</div>\` : ''}
        </div>
      \`).join('');
      
      document.getElementById('searchResults').innerHTML = \`
        <h2 style="font-size: 1rem; margin-bottom: 12px;">Found in \${data.results.length} trace(s)</h2>
        \${html}
      \`;
    }
    
    async function loadTrace(traceId) {
      const res = await apiFetch('/api/trace/' + traceId);
      if (!res.ok) {
        alert('Failed to load trace');
        return;
      }
      
      currentTrace = await res.json();
      renderTrace();
      showTrace();
      
      // Update URL for sharing
      history.pushState({ traceId }, '', '/trace/' + traceId);
    }
    
    function showSearch() {
      document.getElementById('searchView').style.display = 'block';
      document.getElementById('traceView').classList.remove('active');
      
      // Update URL back to root
      history.pushState({}, '', '/');
    }
    
    function showTrace() {
      document.getElementById('searchView').style.display = 'none';
      document.getElementById('traceView').classList.add('active');
    }
    
    // Handle browser back/forward
    window.addEventListener('popstate', async (e) => {
      if (e.state?.traceId) {
        const res = await apiFetch('/api/trace/' + e.state.traceId);
        if (res.ok) {
          currentTrace = await res.json();
          renderTrace();
          showTrace();
        }
      } else {
        showSearch();
      }
    });
    
    function renderTrace() {
      const t = currentTrace;
      const cb = t.contextBuild;
      
      const html = \`
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h2>Trace: \${t.traceId}</h2>
          <div style="display: flex; gap: 8px;">
            \${t.llmCalls?.length > 0 ? \`<button onclick="viewRequest('\${t.llmCalls[0].requestBodyRef}')" class="view-json-btn" title="View first LLM request">📤 View Request</button>\` : ''}
            <button onclick="copyTraceLink()" class="view-json-btn" title="Copy shareable link">📋 Copy Link</button>
          </div>
        </div>
        
        <div class="stats-grid" style="margin-bottom: 20px;">
          <div class="stat-box">
            <div class="stat-value">\${t.activation?.reason || '?'}</div>
            <div class="stat-label">Trigger</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">\${cb?.messagesIncluded || 0}</div>
            <div class="stat-label">Messages</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">\${formatTokens(cb?.tokenEstimates?.total || 0)}</div>
            <div class="stat-label">Tokens</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">\${t.llmCalls?.length || 0}</div>
            <div class="stat-label">LLM Calls</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">\${formatDuration(t.durationMs || 0)}</div>
            <div class="stat-label">Duration</div>
          </div>
          <div class="stat-box">
            <div class="stat-value \${t.outcome?.success ? 'outcome-success' : 'outcome-error'}">\${t.outcome?.success ? '✓' : '✗'}</div>
            <div class="stat-label">Outcome</div>
          </div>
        </div>
        
        \${cb ? \`
        <div class="section open">
          <div class="section-header" onclick="toggleSection(this)">
            <h3>Token Breakdown</h3>
            <span class="section-toggle">▼</span>
          </div>
          <div class="section-content">
            <div class="token-bar">
              <div class="token-segment system" style="width: \${(cb.tokenEstimates.system / cb.tokenEstimates.total * 100)}%">System</div>
              <div class="token-segment messages" style="width: \${(cb.tokenEstimates.messages / cb.tokenEstimates.total * 100)}%">Messages</div>
              <div class="token-segment images" style="width: \${(cb.tokenEstimates.images / cb.tokenEstimates.total * 100)}%">Images</div>
              <div class="token-segment tools" style="width: \${(cb.tokenEstimates.tools / cb.tokenEstimates.total * 100)}%">Tools</div>
            </div>
            <div style="display: flex; gap: 24px; font-size: 0.85rem;">
              <span><span style="color: #6366f1;">●</span> System: \${formatTokens(cb.tokenEstimates.system)}</span>
              <span><span style="color: #22c55e;">●</span> Messages: \${formatTokens(cb.tokenEstimates.messages)}</span>
              <span><span style="color: #f59e0b;">●</span> Images: \${formatTokens(cb.tokenEstimates.images)}</span>
              <span><span style="color: #ef4444;">●</span> Tools: \${formatTokens(cb.tokenEstimates.tools)}</span>
            </div>
            \${cb.didTruncate ? \`<div style="margin-top: 12px; color: var(--warning);">⚠️ Context was truncated: \${cb.messagesRolledOff} messages rolled off (\${cb.truncateReason})</div>\` : ''}
            \${(() => {
              const totalCacheRead = (t.llmCalls || []).reduce((sum, c) => sum + (c.tokenUsage.cacheReadTokens || 0), 0);
              const totalCacheCreated = (t.llmCalls || []).reduce((sum, c) => sum + (c.tokenUsage.cacheCreationTokens || 0), 0);
              const cacheMarkerMsg = cb.messages?.find(m => m.hasCacheControl);
              return \`
                <div style="margin-top: 12px; padding: 12px; background: var(--bg); border-radius: 4px;">
                  <strong style="color: var(--accent);">🗄️ Cache Info</strong>
                  <div style="margin-top: 8px; display: flex; gap: 24px; flex-wrap: wrap;">
                    <span>Marker: \${cb.cacheMarker ? \`<code>\${cb.cacheMarker.slice(-8)}</code>\` : 'None'}</span>
                    \${cacheMarkerMsg ? \`<span>Position: #\${cacheMarkerMsg.position} (\${cacheMarkerMsg.participant})</span>\` : ''}
                    \${totalCacheCreated ? \`<span style="color: #f59e0b;">Created: \${formatTokens(totalCacheCreated)}</span>\` : ''}
                    \${totalCacheRead ? \`<span style="color: #10b981;">Read: \${formatTokens(totalCacheRead)}</span>\` : ''}
                    \${!totalCacheCreated && !totalCacheRead ? '<span style="color: var(--text-muted);">No caching</span>' : ''}
                  </div>
                </div>
              \`;
            })()}
          </div>
        </div>
        \` : ''}
        
        <div class="section">
          <div class="section-header" onclick="toggleSection(this)">
            <h3>Raw Discord Messages (\${t.rawDiscordMessages?.length || 0})</h3>
            <span class="section-toggle">▶</span>
          </div>
          <div class="section-content">
            <div class="message-list">
              \${(t.rawDiscordMessages || []).map((m, i) => \`
                <div class="message-item" onclick="toggleMessage(this)">
                  <span class="message-author">\${m.author.displayName}</span>
                  <span class="message-content">\${truncate(m.content, 80)}</span>
                  \${m.id === t.triggeringMessageId ? '<span class="trigger-badge">TRIGGER</span>' : ''}
                  <div class="message-meta">ID: \${m.id} | \${new Date(m.timestamp).toLocaleTimeString()}\${m.attachments?.length ? ' | ' + m.attachments.length + ' attachment(s)' : ''}</div>
                  <div class="message-expanded">\${escapeHtml(m.content)}</div>
                </div>
              \`).join('')}
            </div>
          </div>
        </div>
        
        <div class="section">
          <div class="section-header" onclick="toggleSection(this)">
            <h3>Context Messages (\${cb?.messages?.length || 0})</h3>
            <span class="section-toggle">▶</span>
          </div>
          <div class="section-content">
            <div class="message-list">
              \${(cb?.messages || []).map((m, i) => \`
                <div class="message-item \${m.hasCacheControl ? 'cache-marker-msg' : ''}" onclick="toggleMessage(this)">
                  <span style="color: var(--text-muted); margin-right: 8px;">#\${m.position}</span>
                  <span class="message-author">\${m.participant}</span>
                  <span class="message-content">\${truncate(m.contentPreview, 60)}</span>
                  \${m.isTrigger ? '<span class="trigger-badge">TRIGGER</span>' : ''}
                  \${m.hasCacheControl ? '<span class="cache-badge">📍 CACHE</span>' : ''}
                  <span style="color: var(--text-muted); margin-left: 8px;">~\${formatTokens(m.tokenEstimate)} tk</span>
                  <div class="message-meta">
                    Discord ID: \${m.discordMessageId || 'N/A'}
                    \${m.hasImages ? ' | ' + m.imageCount + ' image(s)' : ''}
                    \${m.transformations?.length ? ' | ' + m.transformations.join(', ') : ''}
                  </div>
                  <div class="message-expanded">\${escapeHtml(m.contentPreview)}</div>
                </div>
              \`).join('')}
            </div>
          </div>
        </div>
        
        <div class="section">
          <div class="section-header" onclick="toggleSection(this)">
            <h3>LLM Calls (\${t.llmCalls?.length || 0})</h3>
            <span class="section-toggle">▶</span>
          </div>
          <div class="section-content">
            \${(t.llmCalls || []).map((call, i) => \`
              <div class="llm-call">
                <div class="llm-call-header">
                  <strong>Call #\${call.depth}</strong>
                  <div>
                    <button class="view-json-btn" onclick="viewRequest('\${call.requestBodyRef}')">View Request</button>
                    <button class="view-json-btn" onclick="viewResponse('\${call.responseBodyRef}')">View Response</button>
                  </div>
                </div>
                <div class="llm-call-stats">
                  <span>Model: \${call.model}</span>
                  <span>Duration: \${formatDuration(call.durationMs)}</span>
                  <span>Input: \${formatTokens(call.tokenUsage.inputTokens)}</span>
                  <span>Output: \${formatTokens(call.tokenUsage.outputTokens)}</span>
                  \${call.tokenUsage.cacheReadTokens ? \`<span style="color: #10b981;">Cache read: \${formatTokens(call.tokenUsage.cacheReadTokens)}</span>\` : ''}
                  \${call.tokenUsage.cacheCreationTokens ? \`<span style="color: #f59e0b;">Cache created: \${formatTokens(call.tokenUsage.cacheCreationTokens)}</span>\` : ''}
                  <span>Stop: \${call.response.stopReason}</span>
                  \${call.response.toolUseCount > 0 ? \`<span>Tools: \${call.response.toolUseCount}</span>\` : ''}
                </div>
                \${call.error ? \`<div style="color: var(--error); margin-top: 8px;">Error: \${call.error.message}</div>\` : ''}
              </div>
            \`).join('')}
          </div>
        </div>
        
        \${t.toolExecutions?.length > 0 ? \`
        <div class="section">
          <div class="section-header" onclick="toggleSection(this)">
            <h3>Tool Executions (\${t.toolExecutions.length})</h3>
            <span class="section-toggle">▶</span>
          </div>
          <div class="section-content">
            \${t.toolExecutions.map(tool => \`
              <div class="llm-call">
                <div class="llm-call-header">
                  <strong>\${tool.toolName}</strong>
                  <span>\${formatDuration(tool.durationMs)}</span>
                </div>
                <div style="margin-top: 8px;">
                  <div style="color: var(--text-muted); font-size: 0.85rem;">Input:</div>
                  <div class="json-view" style="max-height: 100px;">\${escapeHtml(JSON.stringify(tool.input, null, 2))}</div>
                </div>
                <div style="margin-top: 8px;">
                  <div style="color: var(--text-muted); font-size: 0.85rem;">Output:\${tool.outputTruncated ? ' (truncated)' : ''}</div>
                  <div class="json-view" style="max-height: 100px;">\${escapeHtml(tool.output)}</div>
                </div>
              </div>
            \`).join('')}
          </div>
        </div>
        \` : ''}
        
        <div class="section">
          <div class="section-header" onclick="toggleSection(this)">
            <h3>Console Logs (\${t.logs?.length || 0})</h3>
            <span class="section-toggle">▶</span>
          </div>
          <div class="section-content">
            <div class="filters">
              <button class="filter-btn active" onclick="filterLogs('all', this)">All</button>
              <button class="filter-btn" onclick="filterLogs('error', this)">Errors</button>
              <button class="filter-btn" onclick="filterLogs('warn', this)">Warnings</button>
              <button class="filter-btn" onclick="filterLogs('info', this)">Info</button>
              <button class="filter-btn" onclick="filterLogs('debug', this)">Debug</button>
            </div>
            <div id="logsList" style="margin-top: 12px; max-height: 400px; overflow-y: auto;">
              \${renderLogs(t.logs || [])}
            </div>
          </div>
        </div>
        
        <div class="section open">
          <div class="section-header" onclick="toggleSection(this)">
            <h3>Outcome</h3>
            <span class="section-toggle">▼</span>
          </div>
          <div class="section-content">
            \${t.outcome ? \`
              <div class="\${t.outcome.success ? 'outcome-success' : 'outcome-error'}" style="font-size: 1.2rem; margin-bottom: 12px;">
                \${t.outcome.success ? '✓ Success' : '✗ Failed'}
              </div>
              \${t.outcome.success ? \`
                <div style="margin-bottom: 8px;"><strong>Response (\${t.outcome.responseLength} chars):</strong></div>
                <div class="json-view">\${escapeHtml(t.outcome.responseText)}</div>
                <div style="margin-top: 12px; color: var(--text-muted);">
                  Sent \${t.outcome.messagesSent} message(s): \${t.outcome.sentMessageIds?.join(', ') || 'none'}
                </div>
              \` : \`
                <div style="color: var(--error);">
                  <div>Phase: \${t.outcome.error?.phase}</div>
                  <div>Error: \${t.outcome.error?.message}</div>
                </div>
              \`}
            \` : '<div class="empty-state">No outcome recorded</div>'}
          </div>
        </div>
      \`;
      
      document.getElementById('traceContent').innerHTML = html;
    }
    
    function renderLogs(logs, filter = 'all') {
      const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter);
      return filtered.map(log => \`
        <div class="log-entry \${log.level}">
          <span class="log-time">+\${(log.offsetMs / 1000).toFixed(2)}s</span>
          <span class="log-level">\${log.level.toUpperCase()}</span>
          <span>\${escapeHtml(log.message)}</span>
          \${log.data ? \`<span style="color: var(--text-muted);"> \${escapeHtml(JSON.stringify(log.data))}</span>\` : ''}
        </div>
      \`).join('');
    }
    
    function filterLogs(level, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('logsList').innerHTML = renderLogs(currentTrace.logs || [], level);
    }
    
    function toggleSection(header) {
      const section = header.parentElement;
      section.classList.toggle('open');
      header.querySelector('.section-toggle').textContent = section.classList.contains('open') ? '▼' : '▶';
    }
    
    function toggleMessage(item) {
      item.classList.toggle('expanded');
    }
    
    async function viewRequest(ref) {
      if (!ref) { alert('No request body stored'); return; }
      const res = await apiFetch('/api/request/' + ref);
      const data = await res.json();
      showJsonModal('LLM Request', data);
    }
    
    async function viewResponse(ref) {
      if (!ref) { alert('No response body stored'); return; }
      const res = await apiFetch('/api/response/' + ref);
      const data = await res.json();
      showJsonModal('LLM Response', data);
    }
    
    function showJsonModal(title, data) {
      const modal = document.createElement('div');
      modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;';
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      
      const formattedHtml = renderFormattedLLMData(title, data);
      const rawJson = escapeHtml(JSON.stringify(data, null, 2));
      
      modal.innerHTML = \`
        <div style="background: var(--bg-secondary); border-radius: 8px; width: 95%; max-width: 1200px; max-height: 95vh; overflow: hidden; display: flex; flex-direction: column;">
          <div style="padding: 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
            <h3>\${title}</h3>
            <div style="display: flex; gap: 8px; align-items: center;">
              <button class="modal-tab active" onclick="switchModalTab(this, 'formatted')" style="background: var(--accent); border: none; color: white; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Formatted</button>
              <button class="modal-tab" onclick="switchModalTab(this, 'raw')" style="background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 4px; cursor: pointer;">Raw JSON</button>
              <button onclick="this.closest('[style*=fixed]').remove()" style="background: none; border: none; color: var(--text); font-size: 1.5rem; cursor: pointer; margin-left: 12px;">×</button>
            </div>
          </div>
          <div class="modal-content-formatted" style="padding: 16px; overflow: auto; flex: 1;">
            \${formattedHtml}
          </div>
          <div class="modal-content-raw" style="padding: 16px; overflow: auto; flex: 1; display: none;">
            <pre class="json-view" style="max-height: none;">\${rawJson}</pre>
          </div>
        </div>
      \`;
      
      document.body.appendChild(modal);
    }
    
    function switchModalTab(btn, view) {
      const modal = btn.closest('[style*="fixed"]');
      modal.querySelectorAll('.modal-tab').forEach(t => {
        t.style.background = 'var(--bg)';
        t.style.border = '1px solid var(--border)';
        t.style.color = 'var(--text)';
      });
      btn.style.background = 'var(--accent)';
      btn.style.border = 'none';
      btn.style.color = 'white';
      
      modal.querySelector('.modal-content-formatted').style.display = view === 'formatted' ? 'block' : 'none';
      modal.querySelector('.modal-content-raw').style.display = view === 'raw' ? 'block' : 'none';
    }
    
    function renderFormattedLLMData(title, data) {
      if (title.includes('Request')) {
        return renderFormattedRequest(data);
      } else {
        return renderFormattedResponse(data);
      }
    }
    
    function renderFormattedRequest(data) {
      let html = '';
      const renderedKeys = new Set(['system', 'messages', 'tools', 'model', 'max_tokens', 'temperature']);
      
      if (data.system) {
        // System can be string or array with cache_control
        const isArraySystem = Array.isArray(data.system);
        const hasSystemCache = isArraySystem && data.system.some(b => b.cache_control);
        const systemText = isArraySystem 
          ? data.system.filter(b => b.type === 'text').map(b => b.text).join('\\n')
          : (typeof data.system === 'string' ? data.system : JSON.stringify(data.system));
        const systemCacheBadge = hasSystemCache ? '<span style="background: #10b981; color: white; font-size: 0.65rem; padding: 2px 6px; border-radius: 3px; margin-left: 8px;">📍 CACHED</span>' : '';
        const systemCacheStyle = hasSystemCache ? 'border: 2px solid #10b981; box-shadow: 0 0 8px rgba(16, 185, 129, 0.3);' : '';
        
        html += \`
          <div style="margin-bottom: 20px; \${systemCacheStyle} border-radius: 8px;">
            <div style="font-weight: 600; color: var(--accent); margin-bottom: 8px; display: flex; justify-content: space-between; padding: 8px 12px;">
              <span>📋 System Prompt\${systemCacheBadge}</span>
              <span style="color: var(--text-muted); font-weight: normal;">\${systemText.length} chars</span>
            </div>
            <div style="background: var(--bg); padding: 16px; border-radius: 8px; border-left: 3px solid #6366f1; white-space: pre-wrap; font-family: inherit; line-height: 1.6;">\${escapeHtml(systemText)}</div>
          </div>
        \`;
      }
      
      if (data.messages && data.messages.length > 0) {
        html += \`<div style="font-weight: 600; color: var(--accent); margin-bottom: 12px;">💬 Messages (\${data.messages.length})</div>\`;
        
        for (const msg of data.messages) {
          const role = msg.role || 'unknown';
          const roleColor = role === 'user' ? '#22c55e' : role === 'assistant' ? '#6366f1' : '#f59e0b';
          const roleIcon = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '⚙️';
          
          // Check if this message has cache_control
          let hasCache = false;
          let content = '';
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.cache_control) hasCache = true;
              if (block.type === 'text') {
                content += block.text + '\\n';
              } else if (block.type === 'image') {
                content += '[IMAGE: ' + (block.source?.media_type || 'image') + ']\\n';
              } else if (block.type === 'tool_use') {
                content += '[TOOL USE: ' + block.name + ']\\n' + JSON.stringify(block.input, null, 2) + '\\n';
              } else if (block.type === 'tool_result') {
                content += '[TOOL RESULT]\\n' + (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)) + '\\n';
              } else {
                content += '[' + block.type.toUpperCase() + ']\\n' + JSON.stringify(block, null, 2) + '\\n';
              }
            }
          }
          
          const msgExtraKeys = Object.keys(msg).filter(k => !['role', 'content'].includes(k));
          const msgExtra = msgExtraKeys.length > 0 ? \`\\n--- Extra fields: \${JSON.stringify(Object.fromEntries(msgExtraKeys.map(k => [k, msg[k]])), null, 2)}\` : '';
          
          const cacheBadge = hasCache ? '<span style="background: #10b981; color: white; font-size: 0.65rem; padding: 2px 6px; border-radius: 3px; margin-left: 8px;">📍 CACHED</span>' : '';
          const cacheHighlight = hasCache ? 'border: 2px solid #10b981; box-shadow: 0 0 8px rgba(16, 185, 129, 0.3);' : '';
          
          html += \`
            <div style="margin-bottom: 16px; background: var(--bg); border-radius: 8px; overflow: hidden; \${cacheHighlight}">
              <div style="padding: 8px 12px; background: var(--bg-tertiary); border-left: 3px solid \${roleColor}; display: flex; justify-content: space-between; align-items: center;">
                <span>\${roleIcon} <strong style="color: \${roleColor};">\${role}</strong>\${cacheBadge}\${msgExtraKeys.length > 0 ? \` <span style="color: var(--text-muted); font-size: 0.75rem;">+\${msgExtraKeys.length} fields</span>\` : ''}</span>
                <span style="color: var(--text-muted); font-size: 0.8rem;">\${content.length} chars</span>
              </div>
              <div style="padding: 12px; white-space: pre-wrap; font-family: inherit; line-height: 1.6; max-height: 400px; overflow-y: auto;">\${escapeHtml(content.trim() + msgExtra)}</div>
            </div>
          \`;
        }
      }
      
      if (data.tools && data.tools.length > 0) {
        html += \`
          <div style="margin-top: 20px;">
            <div style="font-weight: 600; color: var(--accent); margin-bottom: 8px;">🔧 Tools Available (\${data.tools.length})</div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              \${data.tools.map(t => \`<span style="background: var(--bg); padding: 4px 8px; border-radius: 4px; font-size: 0.85rem;">\${t.name}</span>\`).join('')}
            </div>
          </div>
        \`;
      }
      
      html += \`
        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); display: flex; gap: 24px; color: var(--text-muted); font-size: 0.85rem; flex-wrap: wrap;">
          <span>Model: <strong>\${data.model || 'unknown'}</strong></span>
          <span>Max tokens: <strong>\${data.max_tokens || 'default'}</strong></span>
          <span>Temperature: <strong>\${data.temperature ?? 'default'}</strong></span>
        </div>
      \`;
      
      const otherKeys = Object.keys(data).filter(k => !renderedKeys.has(k));
      if (otherKeys.length > 0) {
        html += \`
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border);">
            <div style="font-weight: 600; color: var(--warning); margin-bottom: 12px;">📦 Other Fields (\${otherKeys.length})</div>
            \${otherKeys.map(key => \`
              <div style="margin-bottom: 12px;">
                <div style="color: var(--accent); font-size: 0.85rem; margin-bottom: 4px;">\${key}:</div>
                <div style="background: var(--bg); padding: 12px; border-radius: 4px; white-space: pre-wrap; font-family: monospace; font-size: 0.85rem; max-height: 200px; overflow-y: auto;">\${escapeHtml(typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key], null, 2))}</div>
              </div>
            \`).join('')}
          </div>
        \`;
      }
      
      return html;
    }
    
    function renderFormattedResponse(data) {
      let html = '';
      const renderedKeys = new Set(['content', 'stop_reason', 'model', 'usage', 'id', 'type']);
      
      if (data.content && data.content.length > 0) {
        for (let i = 0; i < data.content.length; i++) {
          const block = data.content[i];
          const blockExtraKeys = Object.keys(block).filter(k => !['type', 'text', 'name', 'id', 'input', 'source'].includes(k));
          
          if (block.type === 'text') {
            html += \`
              <div style="margin-bottom: 16px;">
                <div style="font-weight: 600; color: var(--accent); margin-bottom: 8px; display: flex; justify-content: space-between;">
                  <span>📝 Text Response [\${i}]</span>
                  <span style="color: var(--text-muted); font-weight: normal;">\${block.text?.length || 0} chars</span>
                </div>
                <div style="background: var(--bg); padding: 16px; border-radius: 8px; border-left: 3px solid #6366f1; white-space: pre-wrap; font-family: inherit; line-height: 1.6;">\${escapeHtml(block.text || '')}</div>
                \${blockExtraKeys.length > 0 ? \`<div style="margin-top: 8px; padding: 8px; background: var(--bg-tertiary); border-radius: 4px; font-size: 0.8rem;"><strong>Extra fields:</strong> <code>\${escapeHtml(JSON.stringify(Object.fromEntries(blockExtraKeys.map(k => [k, block[k]]))))}</code></div>\` : ''}
              </div>
            \`;
          } else if (block.type === 'tool_use') {
            html += \`
              <div style="margin-bottom: 16px;">
                <div style="font-weight: 600; color: #f59e0b; margin-bottom: 8px;">🔧 Tool Call [\${i}]: \${block.name}</div>
                <div style="background: var(--bg); padding: 16px; border-radius: 8px; border-left: 3px solid #f59e0b;">
                  <div style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 8px;">ID: \${block.id}</div>
                  <pre style="margin: 0; white-space: pre-wrap;">\${escapeHtml(JSON.stringify(block.input, null, 2))}</pre>
                </div>
                \${blockExtraKeys.length > 0 ? \`<div style="margin-top: 8px; padding: 8px; background: var(--bg-tertiary); border-radius: 4px; font-size: 0.8rem;"><strong>Extra fields:</strong> <code>\${escapeHtml(JSON.stringify(Object.fromEntries(blockExtraKeys.map(k => [k, block[k]]))))}</code></div>\` : ''}
              </div>
            \`;
          } else {
            html += \`
              <div style="margin-bottom: 16px;">
                <div style="font-weight: 600; color: var(--warning); margin-bottom: 8px;">❓ \${block.type || 'Unknown'} Block [\${i}]</div>
                <div style="background: var(--bg); padding: 16px; border-radius: 8px; border-left: 3px solid var(--warning);">
                  <pre style="margin: 0; white-space: pre-wrap;">\${escapeHtml(JSON.stringify(block, null, 2))}</pre>
                </div>
              </div>
            \`;
          }
        }
      }
      
      html += \`
        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border);">
          <div style="display: flex; gap: 24px; color: var(--text-muted); font-size: 0.85rem; flex-wrap: wrap;">
            <span>Stop reason: <strong style="color: var(--text);">\${data.stop_reason || 'unknown'}</strong></span>
            <span>Model: <strong>\${data.model || 'unknown'}</strong></span>
            \${data.id ? \`<span>ID: <strong>\${data.id}</strong></span>\` : ''}
            \${data.type ? \`<span>Type: <strong>\${data.type}</strong></span>\` : ''}
          </div>
          \${data.usage ? \`
            <div style="display: flex; gap: 24px; color: var(--text-muted); font-size: 0.85rem; margin-top: 8px; flex-wrap: wrap;">
              <span>Input tokens: <strong>\${data.usage.input_tokens?.toLocaleString() || 0}</strong></span>
              <span>Output tokens: <strong>\${data.usage.output_tokens?.toLocaleString() || 0}</strong></span>
              \${data.usage.cache_read_input_tokens ? \`<span>Cache read: <strong>\${data.usage.cache_read_input_tokens?.toLocaleString()}</strong></span>\` : ''}
              \${data.usage.cache_creation_input_tokens ? \`<span>Cache created: <strong>\${data.usage.cache_creation_input_tokens?.toLocaleString()}</strong></span>\` : ''}
            </div>
          \` : ''}
        </div>
      \`;
      
      const otherKeys = Object.keys(data).filter(k => !renderedKeys.has(k));
      if (otherKeys.length > 0) {
        html += \`
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border);">
            <div style="font-weight: 600; color: var(--warning); margin-bottom: 12px;">📦 Other Fields (\${otherKeys.length})</div>
            \${otherKeys.map(key => \`
              <div style="margin-bottom: 12px;">
                <div style="color: var(--accent); font-size: 0.85rem; margin-bottom: 4px;">\${key}:</div>
                <div style="background: var(--bg); padding: 12px; border-radius: 4px; white-space: pre-wrap; font-family: monospace; font-size: 0.85rem; max-height: 200px; overflow-y: auto;">\${escapeHtml(typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key], null, 2))}</div>
              </div>
            \`).join('')}
          </div>
        \`;
      }
      
      return html;
    }
    
    // Utilities
    function formatTokens(n) {
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }
    
    function formatDuration(ms) {
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(1) + 's';
    }
    
    function truncate(s, len) {
      if (!s) return '';
      s = s.replace(/\\n/g, ' ');
      if (s.length <= len) return s;
      return s.slice(0, len - 3) + '...';
    }
    
    function escapeHtml(s) {
      if (!s) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    
    function copyTraceLink() {
      const url = window.location.origin + '/trace/' + currentTrace.traceId;
      navigator.clipboard.writeText(url).then(() => {
        // Show brief feedback
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = originalText; }, 1500);
      }).catch(err => {
        console.error('Failed to copy:', err);
        prompt('Copy this link:', url);
      });
    }
  </script>
</body>
</html>
`

// ============================================================================
// Server
// ============================================================================

const server = createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`)
  
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url.pathname)
  } else {
    // Serve HTML for all paths (including /trace/:id for deep links)
    // The client-side JS will handle routing based on pathname
    res.setHeader('Content-Type', 'text/html')
    res.end(HTML)
  }
})

const HOST = process.env.HOST || '127.0.0.1'

server.listen(PORT, HOST, () => {
  console.log(`\n  🔍 Trace Viewer running at http://${HOST}:${PORT}\n`)
  if (AUTH_TOKEN) {
    console.log(`  🔐 Authentication enabled (set AUTH_TOKEN env var)\n`)
  } else {
    console.log(`  ⚠️  No authentication (set AUTH_TOKEN for production)\n`)
  }
  console.log(`  📁 Logs directory: ${LOGS_DIR}\n`)
})
