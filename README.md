# OpenRouter Assistant (Obsidian Plugin)

Chat with your vault using OpenRouter. Reads your Markdown notes, retrieves relevant chunks for context, and generates answers powered by your choice of AI models.

## Features

- Indexes Markdown notes from your vault
- Uses lightweight local keyword retrieval for RAG context
- Sends question + context to OpenRouter chat completions API
- Search and pick OpenRouter models from plugin settings
- Chat with the currently open note in a multi-turn session
- Vault-wide agent chat with optional folder/file creation actions
- Approval step for agent file/folder actions before execution
- Advanced agent actions: append, insert-after-heading, exact replace, template creation
- Save chat sessions as markdown notes
- Click referenced file links directly from assistant answers
- Citation links like [1], [2] open source notes directly
- Configurable citation style: phrase links, source links, or footer-only citations
- Slash commands in chat: /help, /model, /reindex, /clear, /save, /mode, /find, /tag, /open, /pin
- Memory controls: keep last N turns, summarize old turns, pin messages
- Workspace-aware note tools via slash commands (find/tag/open)
- Built-in templates for generated notes with variables
- Stream assistant responses token-by-token in chat windows
- Show model thinking/reasoning when provided by the model
- Configurable thinking display: collapsed, expanded, or hidden
- Drag and drop Obsidian note URIs (obsidian://open?...) into chat input
- Creates a new note with answer and sources

## Setup

1. Install dependencies:
   - `npm install`
2. Build plugin:
   - `npm run build`
3. Copy these files into your vault plugin folder:
   - `main.js`
   - `manifest.json`
   - `styles.css`
4. Enable plugin in Obsidian Community Plugins.
5. Open plugin settings and add your OpenRouter API key.
6. Optional: use the `Search` button next to `Model` to browse OpenRouter model IDs (for example `nvidia/nemotron-3-super-120b-a12b:free`).
7. Optional: set `Citation style` in plugin settings to control inline vs footer citations.

## Usage

- Run command: `Ask Question With Vault Context`
  - Type your question and the plugin retrieves relevant notes to answer it
  - Answer is saved to a new note in your vault with citations
- Run command: `Chat With Current Note`
  - Opens multi-turn chat focused on the active markdown note
  - Use `Save Chat` to export transcript as a markdown file
- Run command: `Agent Chat With Vault`
  - Opens vault-wide agent chat in the right sidebar
  - Agent can create/modify notes (with approval before execution)
  - Use `/help` in chat to see all slash commands
- Drag and drop note links (e.g., `obsidian://open?vault=...&file=...`) into chat to auto-reference notes

## Security

- Your API key is stored in Obsidian plugin data.
- Retrieved note chunks are sent to OpenRouter to generate an answer.
