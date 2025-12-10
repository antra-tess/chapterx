/**
 * Notes Plugin
 * 
 * Simple note-taking plugin that demonstrates:
 * - Channel-scoped persistent state
 * - Context injection with aging behavior
 * - Lifecycle hooks for updating injection depth
 */

import { ToolPlugin, PluginContext, PluginStateContext, ContextInjection } from './types.js'
import { logger } from '../../utils/logger.js'

interface Note {
  id: string
  content: string
  createdAt: string
  createdByMessageId: string
}

interface NotesState {
  notes: Note[]
  lastModifiedMessageId: string | null
}

const plugin: ToolPlugin = {
  name: 'notes',
  description: 'Simple note-taking plugin with context injection',
  
  tools: [
    {
      name: 'save_note',
      description: 'Save a note. Notes are visible in the context and age toward a stable position.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The note content to save',
          },
        },
        required: ['content'],
      },
      handler: async (input: { content: string }, context: PluginContext) => {
        // Note: For actual state management, this would use PluginStateContext
        // This handler just logs - real state updates happen in onToolExecution
        logger.debug({ 
          content: input.content.slice(0, 50),
          channelId: context.channelId 
        }, 'Note save requested')
        
        return `Note will be saved: "${input.content.slice(0, 50)}${input.content.length > 50 ? '...' : ''}"`
      },
    },
    {
      name: 'list_notes',
      description: 'List all saved notes with their IDs and full content',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_input: any, context: PluginContext) => {
        logger.debug({ channelId: context.channelId }, 'Notes list requested')
        // Note: Handler can't access state directly, but we return a message
        // The actual notes are visible in context injection
        return 'Notes are displayed in context above. Use read_note with an ID to retrieve a specific note.'
      },
    },
    {
      name: 'read_note',
      description: 'Read a specific note by ID or search by title/content',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The note ID (e.g., note_abc123)',
          },
          search: {
            type: 'string',
            description: 'Search term to find notes by title or content',
          },
        },
      },
      handler: async (input: { id?: string; search?: string }, context: PluginContext) => {
        logger.debug({ 
          noteId: input.id,
          search: input.search,
          channelId: context.channelId 
        }, 'Note read requested')
        
        if (!input.id && !input.search) {
          return 'Please provide either an id or search term'
        }
        
        // Handler returns placeholder - actual retrieval happens in onToolExecution
        return input.id 
          ? `Looking up note: ${input.id}`
          : `Searching notes for: ${input.search}`
      },
    },
    {
      name: 'delete_note',
      description: 'Delete a note by ID',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The ID of the note to delete',
          },
        },
        required: ['id'],
      },
      handler: async (input: { id: string }, context: PluginContext) => {
        logger.debug({ 
          noteId: input.id,
          channelId: context.channelId 
        }, 'Note delete requested')
        
        return `Note ${input.id} will be deleted`
      },
    },
  ],
  
  /**
   * Get context injections - returns notes to be injected into context
   */
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    // Check if injection is disabled via config (defaults to true)
    const config = context.pluginConfig as { inject_into_context?: boolean } | undefined
    if (config?.inject_into_context === false) {
      return []
    }
    
    // Use configured scope (defaults to 'channel')
    const scope = context.configuredScope
    const state = await context.getState<NotesState>(scope)
    
    if (!state?.notes.length) {
      return []
    }
    
    // Format notes for display
    const notesContent = [
      '## 📝 Saved Notes',
      '',
      ...state.notes.map((note, i) => `${i + 1}. [${note.id}] ${note.content}`),
      '',
      '_Use save_note/delete_note to manage notes._',
    ].join('\n')
    
    return [{
      id: 'notes-display',
      content: notesContent,
      targetDepth: 10,  // Settle near tool descriptions
      lastModifiedAt: state.lastModifiedMessageId,
      priority: 100,  // High priority - show before other injections
    }]
  },
  
  /**
   * Lifecycle hook - called after tool execution to update state
   */
  onToolExecution: async (
    toolName: string,
    input: any,
    _result: any,
    context: PluginStateContext
  ): Promise<void> => {
    // Use configured scope (defaults to 'channel')
    const scope = context.configuredScope
    const state = await context.getState<NotesState>(scope) || {
      notes: [],
      lastModifiedMessageId: null,
    }
    
    if (toolName === 'save_note') {
      const newNote: Note = {
        id: `note_${Date.now().toString(36)}`,
        content: input.content,
        createdAt: new Date().toISOString(),
        createdByMessageId: context.currentMessageId,
      }
      
      state.notes.push(newNote)
      state.lastModifiedMessageId = context.currentMessageId
      
      await context.setState(scope, state)
      logger.info({ 
        noteId: newNote.id, 
        channelId: context.channelId,
        scope 
      }, 'Note saved')
    }
    
    if (toolName === 'delete_note') {
      const noteIndex = state.notes.findIndex(n => n.id === input.id)
      if (noteIndex >= 0) {
        state.notes.splice(noteIndex, 1)
        state.lastModifiedMessageId = context.currentMessageId
        
        await context.setState(scope, state)
        logger.info({ 
          noteId: input.id, 
          channelId: context.channelId,
          scope 
        }, 'Note deleted')
      }
    }
  },
  
  /**
   * Post-process tool results to inject actual note content
   */
  postProcessResult: async (
    toolName: string,
    input: any,
    result: string,
    context: PluginStateContext
  ): Promise<string> => {
    if (toolName === 'read_note') {
      const scope = context.configuredScope
      const state = await context.getState<NotesState>(scope)
      
      if (!state?.notes.length) {
        return 'No notes saved yet.'
      }
      
      if (input.id) {
        const note = state.notes.find(n => n.id === input.id)
        if (note) {
          return `**Note [${note.id}]** (created ${note.createdAt}):\n\n${note.content}`
        }
        return `Note not found: ${input.id}`
      }
      
      if (input.search) {
        const searchLower = input.search.toLowerCase()
        const matches = state.notes.filter(n => 
          n.content.toLowerCase().includes(searchLower)
        )
        
        if (matches.length === 0) {
          return `No notes found matching: "${input.search}"`
        }
        
        if (matches.length === 1) {
          const note = matches[0]!
          return `**Note [${note.id}]** (created ${note.createdAt}):\n\n${note.content}`
        }
        
        return `Found ${matches.length} notes matching "${input.search}":\n\n` +
          matches.map(n => `- [${n.id}] ${n.content.slice(0, 100)}${n.content.length > 100 ? '...' : ''}`).join('\n')
      }
      
      return result
    }
    
    if (toolName === 'list_notes') {
      const scope = context.configuredScope
      const state = await context.getState<NotesState>(scope)
      
      if (!state?.notes.length) {
        return 'No notes saved yet. Use save_note to create one.'
      }
      
      return `**${state.notes.length} notes:**\n\n` +
        state.notes.map((n, i) => `${i + 1}. [${n.id}] ${n.content}`).join('\n\n')
    }
    
    return result
  },
}

export default plugin

