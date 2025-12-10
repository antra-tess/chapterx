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
      description: 'List all saved notes for this channel',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_input: any, context: PluginContext) => {
        // This would use PluginStateContext.getState('channel') in practice
        logger.debug({ channelId: context.channelId }, 'Notes list requested')
        return 'Use save_note to add new notes.'
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
}

export default plugin

