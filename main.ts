import {
  App,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  requestUrl
} from "obsidian";

interface RagOpenRouterSettings {
  openRouterApiKey: string;
  model: string;
  maxChunks: number;
  chunkSize: number;
  answerFolder: string;
  citationStyle: "phrase" | "source" | "footer";
  thinkingView: "collapsed" | "expanded" | "hidden";
}

interface NoteChunk {
  filePath: string;
  chunkText: string;
  tokens: string[];
}

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface StreamHandlers {
  onAnswerDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

type AgentAction =
  | {
      type: "create_folder";
      path: string;
    }
  | {
      type: "create_file";
      path: string;
      content: string;
      overwrite?: boolean;
    }
  | {
      type: "append_file";
      path: string;
      content: string;
    }
  | {
      type: "insert_after_heading";
      path: string;
      heading: string;
      content: string;
      createIfMissing?: boolean;
    }
  | {
      type: "replace_in_file";
      path: string;
      find: string;
      replace: string;
      replaceAll?: boolean;
    }
  | {
      type: "create_from_template";
      path: string;
      template: string;
      variables?: Record<string, string>;
      overwrite?: boolean;
    };

interface CitationLink {
  number: number;
  file: TFile;
}

const DEFAULT_SETTINGS: RagOpenRouterSettings = {
  openRouterApiKey: "",
  model: "openai/gpt-4o-mini",
  maxChunks: 6,
  chunkSize: 700,
  answerFolder: "RAG Answers",
  citationStyle: "phrase",
  thinkingView: "collapsed"
};

const RAG_CHAT_VIEW_TYPE = "rag-openrouter-chat-sidebar";

export default class RagOpenRouterPlugin extends Plugin {
  settings: RagOpenRouterSettings;
  noteIndex: NoteChunk[] = [];
  private modelCache: OpenRouterModel[] = [];
  private modelCacheUpdatedAt = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      RAG_CHAT_VIEW_TYPE,
      (leaf) => new RagChatSidebarView(leaf, this)
    );

    this.addSettingTab(new RagOpenRouterSettingTab(this.app, this));

    this.addCommand({
      id: "rag-openrouter-index-notes",
      name: "Index Vault Notes",
      callback: async () => {
        await this.rebuildIndex();
      }
    });

    this.addCommand({
      id: "rag-openrouter-ask-question",
      name: "Ask Question With Vault Context",
      callback: () => {
        new AskQuestionModal(this.app, async (question) => {
          await this.handleQuestion(question);
        }).open();
      }
    });

    this.addCommand({
      id: "rag-openrouter-chat-current-note",
      name: "Chat With Current Note",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== "md") {
          new Notice("Open a markdown note first.");
          return;
        }

        await this.openChatSidebar("note", activeFile.path);
      }
    });

    this.addCommand({
      id: "rag-openrouter-agent-chat-vault",
      name: "Agent Chat With Vault",
      callback: async () => {
        await this.openChatSidebar("vault");
      }
    });

    await this.rebuildIndex();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.openRouterApiKey = this.settings.openRouterApiKey.trim();
    this.settings.model = this.settings.model.trim() || DEFAULT_SETTINGS.model;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    this.noteIndex = [];
    this.app.workspace
      .getLeavesOfType(RAG_CHAT_VIEW_TYPE)
      .forEach((leaf) => leaf.detach());
  }

  private async openChatSidebar(mode: "vault" | "note", notePath?: string): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getRightLeaf(true);
    if (!leaf) {
      new Notice("Unable to open chat sidebar.");
      return;
    }

    await leaf.setViewState({
      type: RAG_CHAT_VIEW_TYPE,
      active: true,
      state: {
        mode,
        notePath: notePath ?? ""
      }
    });
    this.app.workspace.revealLeaf(leaf);
  }

  private getApiKeyOrThrow(): string {
    const key = this.settings.openRouterApiKey.trim();
    if (!key) {
      throw new Error("Set your OpenRouter API key in plugin settings first.");
    }

    return key;
  }

  async getOpenRouterModels(forceRefresh = false): Promise<OpenRouterModel[]> {
    const cacheIsFresh =
      this.modelCache.length > 0 && Date.now() - this.modelCacheUpdatedAt < 10 * 60 * 1000;

    if (!forceRefresh && cacheIsFresh) {
      return this.modelCache;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "HTTP-Referer": "https://obsidian.md",
      "X-Title": "Obsidian RAG OpenRouter Plugin"
    };

    if (this.settings.openRouterApiKey.trim()) {
      headers.Authorization = `Bearer ${this.settings.openRouterApiKey.trim()}`;
    }

    const response = await requestUrl({
      url: "https://openrouter.ai/api/v1/models",
      method: "GET",
      headers
    });

    const modelsRaw = Array.isArray(response.json?.data) ? response.json.data : [];
    const models = modelsRaw
      .map((item: unknown): OpenRouterModel | null => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const obj = item as Record<string, unknown>;
        const id = typeof obj.id === "string" ? obj.id : "";
        if (!id) {
          return null;
        }

        return {
          id,
          name: typeof obj.name === "string" ? obj.name : undefined,
          description: typeof obj.description === "string" ? obj.description : undefined,
          contextLength:
            typeof obj.context_length === "number" ? obj.context_length : undefined
        } as OpenRouterModel;
      })
      .filter((model: OpenRouterModel | null): model is OpenRouterModel => Boolean(model))
      .sort((a: OpenRouterModel, b: OpenRouterModel) => a.id.localeCompare(b.id));

    this.modelCache = models;
    this.modelCacheUpdatedAt = Date.now();
    return models;
  }

  private async handleQuestion(question: string): Promise<void> {
    if (!question.trim()) {
      new Notice("Question cannot be empty.");
      return;
    }

    if (!this.settings.openRouterApiKey.trim()) {
      new Notice("Set your OpenRouter API key in plugin settings first.");
      return;
    }

    if (!this.noteIndex.length) {
      await this.rebuildIndex();
    }

    const topChunks = this.retrieveRelevantChunks(question);
    const answer = await this.queryOpenRouter(question, topChunks);
    const createdFile = await this.writeAnswerNote(question, answer, topChunks);

    await this.app.workspace.getLeaf(true).openFile(createdFile);
    new Notice(`Answer created: ${createdFile.path}`);
  }

  private tokenize(input: string): string[] {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  private splitIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    let current = "";

    for (const paragraph of paragraphs) {
      if (current.length + paragraph.length + 2 <= chunkSize) {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
        continue;
      }

      if (current) {
        chunks.push(current);
      }

      if (paragraph.length <= chunkSize) {
        current = paragraph;
      } else {
        const hardSplit = this.hardSplit(paragraph, chunkSize);
        chunks.push(...hardSplit.slice(0, -1));
        current = hardSplit[hardSplit.length - 1];
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  private hardSplit(text: string, chunkSize: number): string[] {
    const result: string[] = [];
    let start = 0;

    while (start < text.length) {
      result.push(text.slice(start, start + chunkSize));
      start += chunkSize;
    }

    return result;
  }

  async rebuildIndex(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const chunks: NoteChunk[] = [];

    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const split = this.splitIntoChunks(content, this.settings.chunkSize);

        for (const chunkText of split) {
          const tokens = this.tokenize(chunkText);
          if (!tokens.length) {
            continue;
          }

          chunks.push({
            filePath: file.path,
            chunkText,
            tokens
          });
        }
      } catch (error) {
        console.error(`Failed to index ${file.path}`, error);
      }
    }

    this.noteIndex = chunks;
    new Notice(`Indexed ${files.length} notes into ${chunks.length} chunks.`);
  }

  private retrieveRelevantChunks(question: string): NoteChunk[] {
    const queryTokens = this.tokenize(question);
    if (!queryTokens.length) {
      return [];
    }

    const scored = this.noteIndex
      .map((chunk) => {
        const tokenSet = new Set(chunk.tokens);
        let score = 0;

        for (const token of queryTokens) {
          if (tokenSet.has(token)) {
            score += 1;
          }
        }

        // Favor denser matches by normalizing for chunk length.
        const normalizedScore = score / Math.sqrt(chunk.tokens.length);
        return { chunk, score: normalizedScore };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.settings.maxChunks)
      .map((x) => x.chunk);

    return scored;
  }

  private retrieveRelevantChunksForFile(question: string, filePath: string): NoteChunk[] {
    const queryTokens = this.tokenize(question);
    if (!queryTokens.length) {
      return [];
    }

    const scored = this.noteIndex
      .filter((chunk) => chunk.filePath === filePath)
      .map((chunk) => {
        const tokenSet = new Set(chunk.tokens);
        let score = 0;

        for (const token of queryTokens) {
          if (tokenSet.has(token)) {
            score += 1;
          }
        }

        const normalizedScore = score / Math.sqrt(chunk.tokens.length);
        return { chunk, score: normalizedScore };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.settings.maxChunks)
      .map((x) => x.chunk);

    return scored;
  }

  private async queryOpenRouterWithMessages(
    systemPrompt: string,
    messages: ChatMessage[]
  ): Promise<string> {
    const apiKey = this.getApiKeyOrThrow();

    const response = await requestUrl({
      url: "https://openrouter.ai/api/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://obsidian.md",
        "X-Title": "Obsidian RAG OpenRouter Plugin"
      },
      body: JSON.stringify({
        model: this.settings.model,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((msg) => ({ role: msg.role, content: msg.content }))
        ],
        temperature: 0.2
      })
    });

    const answer = response.json?.choices?.[0]?.message?.content;
    if (!answer || typeof answer !== "string") {
      throw new Error("OpenRouter returned an unexpected response.");
    }

    return answer;
  }

  async summarizeChatMessages(messages: ChatMessage[]): Promise<string> {
    if (!messages.length) {
      return "";
    }

    const transcript = messages
      .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
      .join("\n\n");

    const summary = await this.queryOpenRouterWithMessages(
      "Summarize the conversation into compact factual memory bullets. Keep critical constraints and decisions.",
      [{ role: "user", content: transcript }]
    );

    return summary.trim();
  }

  private async streamOpenRouterWithMessages(
    systemPrompt: string,
    messages: ChatMessage[],
    handlers: StreamHandlers = {}
  ): Promise<{ rawAnswer: string; thinking: string }> {
    const apiKey = this.getApiKeyOrThrow();

    const body = {
      model: this.settings.model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((msg) => ({ role: msg.role, content: msg.content }))
      ],
      temperature: 0.2,
      stream: true,
      include_reasoning: true
    };

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://obsidian.md",
        "X-Title": "Obsidian RAG OpenRouter Plugin"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      let details = "";
      try {
        details = (await response.text()).slice(0, 300);
      } catch {
        details = "";
      }

      if (response.status === 401) {
        throw new Error("OpenRouter authentication failed (401). Verify API key in plugin settings.");
      }

      throw new Error(
        `OpenRouter request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${details ? `: ${details}` : ""}`
      );
    }

    if (!response.body) {
      const fallbackAnswer = await this.queryOpenRouterWithMessages(systemPrompt, messages);
      handlers.onAnswerDelta?.(fallbackAnswer);
      return { rawAnswer: fallbackAnswer, thinking: "" };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let rawAnswer = "";
    let thinking = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const payloadText = trimmed.slice(5).trim();
        if (!payloadText || payloadText === "[DONE]") {
          continue;
        }

        try {
          const payload = JSON.parse(payloadText) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning?: string;
                reasoning_content?: string;
              };
            }>;
          };

          const delta = payload.choices?.[0]?.delta;
          const contentDelta = typeof delta?.content === "string" ? delta.content : "";
          const reasoningDelta =
            typeof delta?.reasoning === "string"
              ? delta.reasoning
              : typeof delta?.reasoning_content === "string"
                ? delta.reasoning_content
                : "";

          if (contentDelta) {
            rawAnswer += contentDelta;
            handlers.onAnswerDelta?.(contentDelta);
          }

          if (reasoningDelta) {
            thinking += reasoningDelta;
            handlers.onThinkingDelta?.(reasoningDelta);
          }
        } catch {
          continue;
        }
      }
    }

    return { rawAnswer, thinking };
  }

  private async queryOpenRouter(question: string, contextChunks: NoteChunk[]): Promise<string> {
    const contextText = contextChunks
      .map((chunk, index) => {
        return `Source ${index + 1} (${chunk.filePath}):\n${chunk.chunkText}`;
      })
      .join("\n\n---\n\n");

    const systemPrompt =
      "You are a note assistant. Answer the question using the provided note context when relevant. If context is insufficient, say what is missing.";

    const userPrompt = [
      "Question:",
      question,
      "",
      "Retrieved Note Context:",
      contextText || "No context retrieved.",
      "",
      "Requirements:",
      "- Be concise and factual.",
      "- Cite source numbers like [1], [2] when using context.",
      "- If you are uncertain, clearly say so."
    ].join("\n");

    return this.queryOpenRouterWithMessages(systemPrompt, [{ role: "user", content: userPrompt }]);
  }

  async chatWithNote(
    noteFilePath: string,
    question: string,
    history: ChatMessage[]
  ): Promise<{ answer: string; chunks: NoteChunk[] }> {
    if (!question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    if (!this.settings.openRouterApiKey.trim()) {
      throw new Error("Set your OpenRouter API key in plugin settings first.");
    }

    if (!this.noteIndex.length) {
      await this.rebuildIndex();
    }

    const topChunks = this.retrieveRelevantChunksForFile(question, noteFilePath);
    const contextText = topChunks
      .map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):\n${chunk.chunkText}`)
      .join("\n\n---\n\n");

    const systemPrompt =
      "You are a note assistant. Keep responses grounded in the provided note context and conversation history. If context is missing, say what is missing.";

    const userPrompt = [
      `Current note: ${noteFilePath}`,
      "",
      "Question:",
      question,
      "",
      "Retrieved Note Context:",
      contextText || "No context retrieved from this note.",
      "",
      "Requirements:",
      "- Be concise and factual.",
      "- Cite source numbers like [1], [2] when using context.",
      "- If uncertain, clearly say so."
    ].join("\n");

    const boundedHistory = history.slice(-8);
    const answer = await this.queryOpenRouterWithMessages(systemPrompt, [
      ...boundedHistory,
      { role: "user", content: userPrompt }
    ]);

    return { answer, chunks: topChunks };
  }

  async streamChatWithNote(
    noteFilePath: string,
    question: string,
    history: ChatMessage[],
    handlers: StreamHandlers = {}
  ): Promise<{ answer: string; chunks: NoteChunk[]; thinking: string }> {
    if (!question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    if (!this.settings.openRouterApiKey.trim()) {
      throw new Error("Set your OpenRouter API key in plugin settings first.");
    }

    if (!this.noteIndex.length) {
      await this.rebuildIndex();
    }

    const topChunks = this.retrieveRelevantChunksForFile(question, noteFilePath);
    const contextText = topChunks
      .map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):\n${chunk.chunkText}`)
      .join("\n\n---\n\n");

    const systemPrompt =
      "You are a note assistant. Keep responses grounded in the provided note context and conversation history. If context is missing, say what is missing.";

    const userPrompt = [
      `Current note: ${noteFilePath}`,
      "",
      "Question:",
      question,
      "",
      "Retrieved Note Context:",
      contextText || "No context retrieved from this note.",
      "",
      "Requirements:",
      "- Be concise and factual.",
      "- Cite source numbers like [1], [2] when using context.",
      "- If uncertain, clearly say so."
    ].join("\n");

    const boundedHistory = history.slice(-8);
    const streamed = await this.streamOpenRouterWithMessages(
      systemPrompt,
      [...boundedHistory, { role: "user", content: userPrompt }],
      handlers
    );

    return { answer: streamed.rawAnswer, chunks: topChunks, thinking: streamed.thinking };
  }

  async chatWithVault(
    question: string,
    history: ChatMessage[]
  ): Promise<{ answer: string; chunks: NoteChunk[]; pendingActions: AgentAction[] }> {
    if (!question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    if (!this.settings.openRouterApiKey.trim()) {
      throw new Error("Set your OpenRouter API key in plugin settings first.");
    }

    if (!this.noteIndex.length) {
      await this.rebuildIndex();
    }

    const topChunks = this.retrieveRelevantChunks(question);
    const contextText = topChunks
      .map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):\n${chunk.chunkText}`)
      .join("\n\n---\n\n");

    const systemPrompt = [
      "You are a vault assistant. Use provided note context and conversation history.",
      "You may create folders/files when explicitly useful to the user's request.",
      "Never delete or rename files.",
      "When proposing actions, append exactly one fenced code block with language tag agent-actions and JSON payload:",
      "{\"actions\":[{\"type\":\"create_folder\",\"path\":\"Folder\"},{\"type\":\"create_file\",\"path\":\"Folder/file.md\",\"content\":\"...\",\"overwrite\":false},{\"type\":\"append_file\",\"path\":\"Folder/file.md\",\"content\":\"...\"},{\"type\":\"insert_after_heading\",\"path\":\"Folder/file.md\",\"heading\":\"## Section\",\"content\":\"...\"},{\"type\":\"replace_in_file\",\"path\":\"Folder/file.md\",\"find\":\"old\",\"replace\":\"new\",\"replaceAll\":false},{\"type\":\"create_from_template\",\"path\":\"Folder/plan.md\",\"template\":\"project-plan\",\"variables\":{\"title\":\"Project\"}}]}",
      "Template names available: project-plan, meeting-note, world-lore, character-sheet.",
      "Only use relative vault paths."
    ].join(" ");

    const userPrompt = [
      "Question:",
      question,
      "",
      "Retrieved Vault Context:",
      contextText || "No context retrieved.",
      "",
      "Requirements:",
      "- Be concise and factual.",
      "- Cite source numbers like [1], [2] when using context.",
      "- If uncertain, clearly say so."
    ].join("\n");

    const boundedHistory = history.slice(-8);
    const rawAnswer = await this.queryOpenRouterWithMessages(systemPrompt, [
      ...boundedHistory,
      { role: "user", content: userPrompt }
    ]);

    const { answerText, actions } = this.extractAgentActions(rawAnswer);

    return {
      answer: answerText,
      chunks: topChunks,
      pendingActions: actions
    };
  }

  async streamChatWithVault(
    question: string,
    history: ChatMessage[],
    handlers: StreamHandlers = {}
  ): Promise<{ answer: string; chunks: NoteChunk[]; pendingActions: AgentAction[]; thinking: string }> {
    if (!question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    if (!this.settings.openRouterApiKey.trim()) {
      throw new Error("Set your OpenRouter API key in plugin settings first.");
    }

    if (!this.noteIndex.length) {
      await this.rebuildIndex();
    }

    const topChunks = this.retrieveRelevantChunks(question);
    const contextText = topChunks
      .map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):\n${chunk.chunkText}`)
      .join("\n\n---\n\n");

    const systemPrompt = [
      "You are a vault assistant. Use provided note context and conversation history.",
      "You may create folders/files when explicitly useful to the user's request.",
      "Never delete or rename files.",
      "When proposing actions, append exactly one fenced code block with language tag agent-actions and JSON payload:",
      "{\"actions\":[{\"type\":\"create_folder\",\"path\":\"Folder\"},{\"type\":\"create_file\",\"path\":\"Folder/file.md\",\"content\":\"...\",\"overwrite\":false},{\"type\":\"append_file\",\"path\":\"Folder/file.md\",\"content\":\"...\"},{\"type\":\"insert_after_heading\",\"path\":\"Folder/file.md\",\"heading\":\"## Section\",\"content\":\"...\"},{\"type\":\"replace_in_file\",\"path\":\"Folder/file.md\",\"find\":\"old\",\"replace\":\"new\",\"replaceAll\":false},{\"type\":\"create_from_template\",\"path\":\"Folder/plan.md\",\"template\":\"project-plan\",\"variables\":{\"title\":\"Project\"}}]}",
      "Template names available: project-plan, meeting-note, world-lore, character-sheet.",
      "Only use relative vault paths."
    ].join(" ");

    const userPrompt = [
      "Question:",
      question,
      "",
      "Retrieved Vault Context:",
      contextText || "No context retrieved.",
      "",
      "Requirements:",
      "- Be concise and factual.",
      "- Cite source numbers like [1], [2] when using context.",
      "- If uncertain, clearly say so."
    ].join("\n");

    const boundedHistory = history.slice(-8);
    const streamed = await this.streamOpenRouterWithMessages(
      systemPrompt,
      [...boundedHistory, { role: "user", content: userPrompt }],
      handlers
    );

    const { answerText, actions } = this.extractAgentActions(streamed.rawAnswer);

    return {
      answer: answerText,
      chunks: topChunks,
      pendingActions: actions,
      thinking: streamed.thinking
    };
  }

  private extractAgentActions(rawAnswer: string): { answerText: string; actions: AgentAction[] } {
    const candidates: Array<{ jsonText: string; removeText: string }> = [];

    const agentActionFence = rawAnswer.match(/```agent-actions\s*([\s\S]*?)```/i);
    if (agentActionFence) {
      candidates.push({
        jsonText: agentActionFence[1].trim(),
        removeText: agentActionFence[0]
      });
    }

    const jsonFence = rawAnswer.match(/```json\s*([\s\S]*?)```/i);
    if (jsonFence && /"actions"\s*:/.test(jsonFence[1])) {
      candidates.push({
        jsonText: jsonFence[1].trim(),
        removeText: jsonFence[0]
      });
    }

    const rawJsonObject = this.extractFirstActionsJSONObject(rawAnswer);
    if (rawJsonObject) {
      candidates.push({
        jsonText: rawJsonObject,
        removeText: rawJsonObject
      });
    }

    let parsedActions: AgentAction[] = [];
    let removeText = "";

    for (const candidate of candidates) {
      const maybe = this.parseActionsFromJson(candidate.jsonText);
      if (maybe.length) {
        parsedActions = maybe;
        removeText = candidate.removeText;
        break;
      }
    }

    if (!parsedActions.length) {
      return { answerText: rawAnswer.trim(), actions: [] };
    }

    const stripped = removeText ? rawAnswer.replace(removeText, "").trim() : rawAnswer.trim();
    const answerText = stripped || "Planned actions are ready. Review and approve below.";

    return {
      answerText,
      actions: parsedActions
    };
  }

  private parseActionsFromJson(jsonText: string): AgentAction[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return [];
    }

    if (!parsed || typeof parsed !== "object") {
      return [];
    }

    const maybeActions = (parsed as Record<string, unknown>).actions;
    if (!Array.isArray(maybeActions)) {
      return [];
    }

    const actions: AgentAction[] = [];

    for (const action of maybeActions) {
      if (!action || typeof action !== "object") {
        continue;
      }

      const obj = action as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      const path = typeof obj.path === "string" ? obj.path : "";

      if (type === "create_folder" && path) {
        actions.push({ type: "create_folder", path });
        continue;
      }

      if (type === "create_file" && path && typeof obj.content === "string") {
        actions.push({
          type: "create_file",
          path,
          content: obj.content,
          overwrite: typeof obj.overwrite === "boolean" ? obj.overwrite : undefined
        });
        continue;
      }

      if (type === "append_file" && path && typeof obj.content === "string") {
        actions.push({ type: "append_file", path, content: obj.content });
        continue;
      }

      if (
        type === "insert_after_heading" &&
        path &&
        typeof obj.heading === "string" &&
        typeof obj.content === "string"
      ) {
        actions.push({
          type: "insert_after_heading",
          path,
          heading: obj.heading,
          content: obj.content,
          createIfMissing: typeof obj.createIfMissing === "boolean" ? obj.createIfMissing : undefined
        });
        continue;
      }

      if (
        type === "replace_in_file" &&
        path &&
        typeof obj.find === "string" &&
        typeof obj.replace === "string"
      ) {
        actions.push({
          type: "replace_in_file",
          path,
          find: obj.find,
          replace: obj.replace,
          replaceAll: typeof obj.replaceAll === "boolean" ? obj.replaceAll : undefined
        });
        continue;
      }

      if (type === "create_from_template" && path && typeof obj.template === "string") {
        const variablesRaw = obj.variables;
        const variables: Record<string, string> = {};
        if (variablesRaw && typeof variablesRaw === "object") {
          for (const [key, value] of Object.entries(variablesRaw as Record<string, unknown>)) {
            if (typeof value === "string") {
              variables[key] = value;
            }
          }
        }

        actions.push({
          type: "create_from_template",
          path,
          template: obj.template,
          variables,
          overwrite: typeof obj.overwrite === "boolean" ? obj.overwrite : undefined
        });
      }
    }

    return actions;
  }

  private extractFirstActionsJSONObject(text: string): string | null {
    const actionsKeyIndex = text.search(/"actions"\s*:/);
    if (actionsKeyIndex < 0) {
      return null;
    }

    const objectStart = text.lastIndexOf("{", actionsKeyIndex);
    if (objectStart < 0) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = objectStart; i < text.length; i += 1) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === "\\") {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") {
        depth += 1;
        continue;
      }

      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(objectStart, i + 1);
        }
      }
    }

    return null;
  }

  private sanitizeVaultPath(path: string): string | null {
    const trimmed = path.trim().replace(/\\/g, "/");
    if (!trimmed) {
      return null;
    }

    if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("/")) {
      return null;
    }

    const normalized = normalizePath(trimmed);
    if (!normalized || normalized === ".") {
      return null;
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "..")) {
      return null;
    }

    return normalized;
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath) {
      return;
    }

    const segments = folderPath.split("/");
    let current = "";

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing) {
        if (existing instanceof TFile) {
          throw new Error(`Cannot create folder ${current}: a file exists at this path.`);
        }
        continue;
      }

      await this.app.vault.createFolder(current);
    }
  }

  async applyAgentActions(actions: AgentAction[]): Promise<string> {
    let createdFolders = 0;
    let createdFiles = 0;
    let updatedFiles = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const action of actions) {
      try {
        const safePath = this.sanitizeVaultPath(action.path);
        if (!safePath) {
          skipped += 1;
          continue;
        }

        if (action.type === "create_folder") {
          const existing = this.app.vault.getAbstractFileByPath(safePath);
          if (existing) {
            skipped += 1;
            continue;
          }

          await this.ensureFolderExists(safePath);
          createdFolders += 1;
          continue;
        }

        if (action.type === "create_from_template") {
          const content = this.renderTemplate(action.template, action.variables ?? {});
          const folderPath = safePath.includes("/") ? safePath.slice(0, safePath.lastIndexOf("/")) : "";
          await this.ensureFolderExists(folderPath);

          const existing = this.app.vault.getAbstractFileByPath(safePath);
          if (existing) {
            if (!(existing instanceof TFile)) {
              errors.push(`Cannot create file ${safePath}: a folder exists at this path.`);
              continue;
            }

            if (!action.overwrite) {
              skipped += 1;
              continue;
            }

            await this.app.vault.modify(existing, content);
            updatedFiles += 1;
            continue;
          }

          await this.app.vault.create(safePath, content);
          createdFiles += 1;
          continue;
        }

        if (action.type === "append_file") {
          const existing = this.app.vault.getAbstractFileByPath(safePath);
          if (!(existing instanceof TFile)) {
            errors.push(`Cannot append to ${safePath}: file not found.`);
            continue;
          }

          const current = await this.app.vault.cachedRead(existing);
          const separator = current.endsWith("\n") || action.content.startsWith("\n") ? "" : "\n\n";
          await this.app.vault.modify(existing, `${current}${separator}${action.content}`);
          updatedFiles += 1;
          continue;
        }

        if (action.type === "insert_after_heading") {
          const existing = this.app.vault.getAbstractFileByPath(safePath);
          if (!(existing instanceof TFile)) {
            errors.push(`Cannot insert in ${safePath}: file not found.`);
            continue;
          }

          const current = await this.app.vault.cachedRead(existing);
          const escapedHeading = action.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const headingRegex = new RegExp(`^${escapedHeading}\\s*$`, "m");
          const headingMatch = headingRegex.exec(current);

          if (!headingMatch) {
            if (action.createIfMissing) {
              const appended = `${current}${current.endsWith("\n") ? "" : "\n\n"}${action.heading}\n${action.content}`;
              await this.app.vault.modify(existing, appended);
              updatedFiles += 1;
            } else {
              skipped += 1;
            }
            continue;
          }

          const insertIndex = headingMatch.index + headingMatch[0].length;
          const updated = `${current.slice(0, insertIndex)}\n${action.content}${current.slice(insertIndex)}`;
          await this.app.vault.modify(existing, updated);
          updatedFiles += 1;
          continue;
        }

        if (action.type === "replace_in_file") {
          const existing = this.app.vault.getAbstractFileByPath(safePath);
          if (!(existing instanceof TFile)) {
            errors.push(`Cannot replace in ${safePath}: file not found.`);
            continue;
          }

          const current = await this.app.vault.cachedRead(existing);
          if (!current.includes(action.find)) {
            skipped += 1;
            continue;
          }

          const updated = action.replaceAll
            ? current.split(action.find).join(action.replace)
            : current.replace(action.find, action.replace);
          await this.app.vault.modify(existing, updated);
          updatedFiles += 1;
          continue;
        }

        const folderPath = safePath.includes("/") ? safePath.slice(0, safePath.lastIndexOf("/")) : "";
        await this.ensureFolderExists(folderPath);

        const existing = this.app.vault.getAbstractFileByPath(safePath);
        if (existing) {
          if (!(existing instanceof TFile)) {
            errors.push(`Cannot create file ${safePath}: a folder exists at this path.`);
            continue;
          }

          if (!action.overwrite) {
            skipped += 1;
            continue;
          }

          await this.app.vault.modify(existing, action.content);
          updatedFiles += 1;
          continue;
        }

        await this.app.vault.create(safePath, action.content);
        createdFiles += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const parts = [
      `Actions executed: folders created ${createdFolders}, files created ${createdFiles}, files updated ${updatedFiles}, skipped ${skipped}`
    ];
    if (errors.length) {
      parts.push(`Errors: ${errors.join(" | ")}`);
    }

    return parts.join(". ");
  }

  private renderTemplate(template: string, variables: Record<string, string>): string {
    const now = new Date().toISOString();
    const templates: Record<string, string> = {
      "project-plan": [
        "# {{title}}",
        "",
        "Created: {{created}}",
        "",
        "## Goal",
        "{{goal}}",
        "",
        "## Milestones",
        "- {{milestone1}}",
        "- {{milestone2}}",
        "",
        "## Risks",
        "- {{risk1}}"
      ].join("\n"),
      "meeting-note": [
        "# Meeting: {{title}}",
        "",
        "Date: {{date}}",
        "Attendees: {{attendees}}",
        "",
        "## Agenda",
        "- ",
        "",
        "## Notes",
        "",
        "## Action Items",
        "- [ ] "
      ].join("\n"),
      "world-lore": [
        "# Lore: {{title}}",
        "",
        "## Summary",
        "{{summary}}",
        "",
        "## Factions",
        "- ",
        "",
        "## Timeline",
        "- "
      ].join("\n"),
      "character-sheet": [
        "# Character: {{name}}",
        "",
        "## Role",
        "{{role}}",
        "",
        "## Traits",
        "- ",
        "",
        "## Goals",
        "- "
      ].join("\n")
    };

    const defaults: Record<string, string> = {
      title: "Untitled",
      goal: "",
      milestone1: "",
      milestone2: "",
      risk1: "",
      created: now,
      date: now.slice(0, 10),
      attendees: "",
      summary: "",
      name: "Unnamed",
      role: ""
    };

    const source = templates[template] ?? templates["project-plan"];
    return source.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_full, key: string) => {
      return variables[key] ?? defaults[key] ?? "";
    });
  }

  private async writeAnswerNote(
    question: string,
    answer: string,
    chunks: NoteChunk[]
  ): Promise<TFile> {
    const folder = this.settings.answerFolder.trim();
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `RAG Answer ${timestamp}.md`;
    const filePath = folder ? `${folder}/${baseName}` : baseName;

    const sourceList = chunks.length
      ? chunks.map((chunk, idx) => `- [${idx + 1}] ${chunk.filePath}`).join("\n")
      : "- No relevant sources found.";

    const note = [
      `# RAG Answer`,
      "",
      `## Question`,
      question,
      "",
      `## Answer`,
      answer,
      "",
      `## Sources`,
      sourceList
    ].join("\n");

    return this.app.vault.create(filePath, note);
  }

  getReferencedFiles(answer: string, chunks: NoteChunk[]): TFile[] {
    const referencedPaths = new Set<string>();

    for (const chunk of chunks) {
      referencedPaths.add(chunk.filePath);
    }

    const mdPathRegex = /(^|[\s(\["'])((?:[^\s)\]"']+\/)*[^\s)\]"']+\.md)($|[\s)\]"'.,;:!?])/gi;
    let match: RegExpExecArray | null;
    while ((match = mdPathRegex.exec(answer)) !== null) {
      const candidate = match[2].replace(/^\/+/, "");
      if (candidate) {
        referencedPaths.add(candidate);
      }
    }

    const files: TFile[] = [];
    for (const path of referencedPaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        files.push(file);
      }
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  getCitationLinks(answer: string, chunks: NoteChunk[]): CitationLink[] {
    const seen = new Set<number>();
    const citations: CitationLink[] = [];
    const citationRegex = /\[(\d+)\]/g;
    let match: RegExpExecArray | null;

    while ((match = citationRegex.exec(answer)) !== null) {
      const number = Number.parseInt(match[1], 10);
      if (!Number.isFinite(number) || number < 1 || seen.has(number)) {
        continue;
      }

      const chunk = chunks[number - 1];
      if (!chunk) {
        continue;
      }

      const file = this.app.vault.getAbstractFileByPath(chunk.filePath);
      if (file instanceof TFile) {
        seen.add(number);
        citations.push({ number, file });
      }
    }

    return citations;
  }

  resolveObsidianUriToPath(uriText: string): string | null {
    const trimmed = uriText.trim();
    if (!trimmed.toLowerCase().startsWith("obsidian://open?")) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }

    const vaultName = parsed.searchParams.get("vault") ?? "";
    const currentVault = this.app.vault.getName();
    if (vaultName && vaultName !== currentVault) {
      return null;
    }

    const fileParam = parsed.searchParams.get("file");
    if (!fileParam) {
      return null;
    }

    const decoded = decodeURIComponent(fileParam).replace(/\\/g, "/").trim();
    const safe = this.sanitizeVaultPath(decoded);
    return safe;
  }

  resolveObsidianUriToFile(uriText: string): TFile | null {
    const safePath = this.resolveObsidianUriToPath(uriText);
    if (!safePath) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    return file instanceof TFile ? file : null;
  }

  async saveChatAsNote(chatTitle: string, messages: ChatMessage[]): Promise<TFile> {
    if (!messages.length) {
      throw new Error("No chat messages to save yet.");
    }

    const rootFolder = this.settings.answerFolder.trim();
    const chatFolder = rootFolder ? `${rootFolder}/RAG Chats` : "RAG Chats";
    await this.ensureFolderExists(chatFolder);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeTitle = (chatTitle || "Vault Chat")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    const fileName = `${safeTitle} ${timestamp}.md`;
    const filePath = `${chatFolder}/${fileName}`;

    const transcript = messages
      .map((msg, index) => {
        const role = msg.role === "user" ? "User" : "Assistant";
        return [`### ${index + 1}. ${role}`, "", msg.content.trim()].join("\n");
      })
      .join("\n\n");

    const content = [
      `# ${safeTitle}`,
      "",
      `Created: ${new Date().toISOString()}`,
      "",
      "## Transcript",
      "",
      transcript
    ].join("\n");

    return this.app.vault.create(filePath, content);
  }
}

class RagChatSidebarView extends ItemView {
  private plugin: RagOpenRouterPlugin;
  private mode: "vault" | "note" = "vault";
  private notePath = "";
  private messages: ChatMessage[] = [];
  private pinnedMessages: ChatMessage[] = [];
  private keepTurns = 8;
  private summarizeOldTurns = true;
  private conversationSummary = "";
  private pendingActions: AgentAction[] = [];
  private transcriptEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private saveButtonEl!: HTMLButtonElement;
  private isDraggingUri = false;

  constructor(leaf: WorkspaceLeaf, plugin: RagOpenRouterPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return RAG_CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "RAG Chat";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const state = this.leaf.getViewState().state as { mode?: "vault" | "note"; notePath?: string };
    this.mode = state?.mode === "note" ? "note" : "vault";
    this.notePath = typeof state?.notePath === "string" ? state.notePath : "";
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rag-openrouter-chat-sidebar");

    const header = contentEl.createDiv({ cls: "rag-openrouter-chat-sidebar-header" });
    header.createEl("h3", { text: this.mode === "vault" ? "Vault Agent Chat" : "Note Chat" });

    const modeActions = header.createDiv({ cls: "rag-openrouter-chat-sidebar-mode-actions" });
    const vaultButton = modeActions.createEl("button", { text: "Vault" });
    const noteButton = modeActions.createEl("button", { text: "Current note" });

    if (this.mode === "vault") {
      vaultButton.addClass("mod-cta");
    } else {
      noteButton.addClass("mod-cta");
    }

    vaultButton.addEventListener("click", async () => {
      await this.switchMode("vault");
    });

    noteButton.addEventListener("click", async () => {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile || activeFile.extension !== "md") {
        new Notice("Open a markdown note first.");
        return;
      }

      await this.switchMode("note", activeFile.path);
    });

    const scopeText =
      this.mode === "vault"
        ? "Scope: Entire vault."
        : this.notePath
          ? `Scope: ${this.notePath}`
          : "Scope: Current markdown note.";

    contentEl.createDiv({
      cls: "rag-openrouter-note-chat-note-path",
      text: scopeText
    });

    const memoryControls = contentEl.createDiv({ cls: "rag-openrouter-chat-sidebar-memory-controls" });
    memoryControls.createDiv({ text: "Keep turns" });
    const keepTurnsInput = memoryControls.createEl("input", {
      type: "number",
      value: String(this.keepTurns)
    });
    keepTurnsInput.min = "2";
    keepTurnsInput.max = "30";
    keepTurnsInput.addEventListener("change", () => {
      const parsed = Number.parseInt(keepTurnsInput.value, 10);
      if (Number.isFinite(parsed)) {
        this.keepTurns = Math.max(2, Math.min(30, parsed));
      }
      keepTurnsInput.value = String(this.keepTurns);
    });

    const summarizeToggleWrap = memoryControls.createEl("label", {
      cls: "rag-openrouter-chat-sidebar-memory-toggle"
    });
    const summarizeToggle = summarizeToggleWrap.createEl("input", { type: "checkbox" });
    summarizeToggle.checked = this.summarizeOldTurns;
    summarizeToggleWrap.appendText("summarize old");
    summarizeToggle.addEventListener("change", () => {
      this.summarizeOldTurns = summarizeToggle.checked;
    });

    const pinLastButton = memoryControls.createEl("button", { text: "Pin last" });
    pinLastButton.addEventListener("click", () => {
      this.pinLastMessage();
    });

    const clearPinsButton = memoryControls.createEl("button", { text: "Clear pins" });
    clearPinsButton.addEventListener("click", () => {
      this.pinnedMessages = [];
      new Notice("Pinned messages cleared.");
    });

    memoryControls.createDiv({
      cls: "rag-openrouter-chat-sidebar-memory-count",
      text: `Pins: ${this.pinnedMessages.length}`
    });

    this.transcriptEl = contentEl.createDiv({ cls: "rag-openrouter-note-chat-transcript" });

    const inputWrap = contentEl.createDiv({ cls: "rag-openrouter-note-chat-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      attr: {
        placeholder:
          this.mode === "vault"
            ? "Ask about your vault or request file/folder creation..."
            : "Ask about this note..."
      }
    });

    this.sendButtonEl = inputWrap.createEl("button", { text: "Send" });
    this.saveButtonEl = inputWrap.createEl("button", { text: "Save Chat" });

    this.sendButtonEl.addEventListener("click", async () => {
      await this.sendMessage();
    });

    this.saveButtonEl.addEventListener("click", async () => {
      await this.saveChat();
    });

    this.inputEl.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        await this.sendMessage();
      }
    });

    this.inputEl.addEventListener("dragover", (event) => {
      if (!event.dataTransfer) {
        return;
      }

      const hasText = Array.from(event.dataTransfer.types).some((type) =>
        type === "text/plain" || type === "text/uri-list"
      );
      if (!hasText) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!this.isDraggingUri) {
        this.isDraggingUri = true;
        this.inputEl.addClass("is-drag-over");
      }
    });

    this.inputEl.addEventListener("dragleave", () => {
      this.isDraggingUri = false;
      this.inputEl.removeClass("is-drag-over");
    });

    this.inputEl.addEventListener("drop", (event) => {
      event.preventDefault();
      this.isDraggingUri = false;
      this.inputEl.removeClass("is-drag-over");

      const dt = event.dataTransfer;
      if (!dt) {
        return;
      }

      const uriList = dt.getData("text/uri-list") || "";
      const plainText = dt.getData("text/plain") || "";
      const merged = `${uriList}\n${plainText}`.trim();
      if (!merged) {
        return;
      }

      const lines = merged
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const references: string[] = [];
      for (const line of lines) {
        const file = this.plugin.resolveObsidianUriToFile(line);
        if (file) {
          references.push(`[[${file.path}]]`);
          continue;
        }

        const safePath = this.plugin.resolveObsidianUriToPath(line);
        if (safePath) {
          references.push(`[[${safePath}]]`);
          continue;
        }

        if (line.toLowerCase().endsWith(".md")) {
          references.push(`[[${line}]]`);
        }
      }

      if (!references.length) {
        new Notice("Dropped item did not contain a supported Obsidian note link.");
        return;
      }

      const prefix = this.inputEl.value.trim() ? "\n" : "";
      this.inputEl.value = `${this.inputEl.value}${prefix}${references.join("\n")}`;
      this.inputEl.focus();
      new Notice(`Added ${references.length} note reference(s) from drop.`);
    });

    this.inputEl.focus();
  }

  private async switchMode(mode: "vault" | "note", notePath = ""): Promise<void> {
    this.mode = mode;
    this.notePath = notePath;
    this.messages = [];
    this.pendingActions = [];

    const currentState = this.leaf.getViewState();
    await this.leaf.setViewState({
      ...currentState,
      state: {
        mode: this.mode,
        notePath: this.notePath
      }
    });

    this.render();
  }

  private pinLastMessage(): void {
    const last = [...this.messages].reverse().find((msg) => msg.role === "user" || msg.role === "assistant");
    if (!last) {
      new Notice("No message to pin yet.");
      return;
    }

    this.pinnedMessages.push({ role: last.role, content: last.content });
    new Notice("Pinned last message for memory.");
    this.render();
  }

  private getHistoryForModel(historyBeforeTurn: ChatMessage[]): ChatMessage[] {
    const keepCount = Math.max(2, this.keepTurns) * 2;
    if (!this.summarizeOldTurns || historyBeforeTurn.length <= keepCount) {
      return [...this.pinnedMessages, ...historyBeforeTurn.slice(-keepCount)];
    }

    return [...this.pinnedMessages, ...historyBeforeTurn.slice(-keepCount)];
  }

  private async maybeSummarizeHistory(historyBeforeTurn: ChatMessage[]): Promise<void> {
    const keepCount = Math.max(2, this.keepTurns) * 2;
    if (!this.summarizeOldTurns || historyBeforeTurn.length <= keepCount) {
      return;
    }

    const older = historyBeforeTurn.slice(0, -keepCount);
    if (!older.length) {
      return;
    }

    const summary = await this.plugin.summarizeChatMessages(older);
    if (!summary) {
      return;
    }

    this.conversationSummary = this.conversationSummary
      ? `${this.conversationSummary}\n- ${summary}`
      : summary;
  }

  private renderCitationLinks(parent: HTMLElement, answer: string, chunks: NoteChunk[]): void {
    if (this.plugin.settings.citationStyle !== "footer") {
      return;
    }

    const citations = this.plugin.getCitationLinks(answer, chunks);
    if (!citations.length) {
      return;
    }

    const wrap = parent.createDiv({ cls: "rag-openrouter-note-chat-message-links" });
    wrap.createDiv({
      cls: "rag-openrouter-note-chat-message-links-title",
      text: "Citations"
    });
    const list = wrap.createEl("ul", { cls: "rag-openrouter-note-chat-message-links-list" });
    for (const citation of citations) {
      const li = list.createEl("li");
      const link = li.createEl("a", { text: `[${citation.number}] ${citation.file.path}`, href: "#" });
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        await this.app.workspace.getLeaf(true).openFile(citation.file);
      });
    }
  }

  private renderReferencedFiles(parent: HTMLElement, answer: string, chunks: NoteChunk[]): void {
    const referencedFiles = this.plugin.getReferencedFiles(answer, chunks);
    if (!referencedFiles.length) {
      return;
    }

    const refsWrap = parent.createDiv({ cls: "rag-openrouter-note-chat-message-links" });
    refsWrap.createDiv({
      cls: "rag-openrouter-note-chat-message-links-title",
      text: "Referenced files"
    });

    const refsList = refsWrap.createEl("ul", { cls: "rag-openrouter-note-chat-message-links-list" });
    for (const file of referencedFiles) {
      const li = refsList.createEl("li");
      const link = li.createEl("a", { text: file.path, href: "#" });
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        await this.app.workspace.getLeaf(true).openFile(file);
      });
    }
  }

  private renderPendingActions(parent: HTMLElement): void {
    if (!this.pendingActions.length) {
      return;
    }

    const panel = parent.createDiv({ cls: "rag-openrouter-action-approval" });
    panel.createDiv({
      cls: "rag-openrouter-note-chat-message-links-title",
      text: `Planned actions (${this.pendingActions.length})`
    });

    const list = panel.createEl("ul", { cls: "rag-openrouter-note-chat-message-links-list" });
    for (const action of this.pendingActions) {
      const li = list.createEl("li");
      li.setText(this.describeAction(action));
    }

    const buttons = panel.createDiv({ cls: "rag-openrouter-action-approval-buttons" });
    const approveButton = buttons.createEl("button", { text: "Approve actions" });
    const discardButton = buttons.createEl("button", { text: "Discard" });

    approveButton.addEventListener("click", async () => {
      try {
        approveButton.disabled = true;
        discardButton.disabled = true;
        const summary = await this.plugin.applyAgentActions(this.pendingActions);
        this.pendingActions = [];
        panel.remove();
        new Notice(summary);
        this.addMessage("assistant", "Actions applied.", summary);
      } catch (error) {
        approveButton.disabled = false;
        discardButton.disabled = false;
        new Notice(`Failed to apply actions: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    discardButton.addEventListener("click", () => {
      this.pendingActions = [];
      new Notice("Pending actions discarded.");
      panel.remove();
    });
  }

  private replaceCitationMarkersWithWikiLinks(text: string, chunks: NoteChunk[]): string {
    return text.replace(/\[(\d+)\]/g, (full, numText: string) => {
      const idx = Number.parseInt(numText, 10);
      if (!Number.isFinite(idx) || idx < 1 || idx > chunks.length) {
        return full;
      }

      const path = chunks[idx - 1]?.filePath;
      if (!path) {
        return full;
      }

      return `[[${path}]]`;
    });
  }

  private prepareActionsWithCitationLinks(actions: AgentAction[], chunks: NoteChunk[]): AgentAction[] {
    return actions.map((action) => {
      if (action.type === "create_file") {
        return {
          ...action,
          content: this.replaceCitationMarkersWithWikiLinks(action.content, chunks)
        };
      }

      if (action.type === "append_file") {
        return {
          ...action,
          content: this.replaceCitationMarkersWithWikiLinks(action.content, chunks)
        };
      }

      if (action.type === "insert_after_heading") {
        return {
          ...action,
          content: this.replaceCitationMarkersWithWikiLinks(action.content, chunks)
        };
      }

      if (action.type === "replace_in_file") {
        return {
          ...action,
          replace: this.replaceCitationMarkersWithWikiLinks(action.replace, chunks)
        };
      }

      if (action.type === "create_from_template") {
        const vars = action.variables ?? {};
        const updatedVars: Record<string, string> = {};
        for (const [key, value] of Object.entries(vars)) {
          updatedVars[key] = this.replaceCitationMarkersWithWikiLinks(value, chunks);
        }

        return {
          ...action,
          variables: updatedVars
        };
      }

      return action;
    });
  }

  private describeAction(action: AgentAction): string {
    if (action.type === "create_folder") {
      return `create_folder: ${action.path}`;
    }
    if (action.type === "create_file") {
      return `create_file: ${action.path}${action.overwrite ? " (overwrite)" : ""}`;
    }
    if (action.type === "append_file") {
      return `append_file: ${action.path}`;
    }
    if (action.type === "insert_after_heading") {
      return `insert_after_heading: ${action.path} after ${action.heading}`;
    }
    if (action.type === "replace_in_file") {
      return `replace_in_file: ${action.path} find \"${action.find}\"`;
    }
    return `create_from_template: ${action.template} -> ${action.path}`;
  }

  private async handleSlashCommand(commandText: string): Promise<boolean> {
    if (!commandText.startsWith("/")) {
      return false;
    }

    const [command, ...rest] = commandText.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").trim();

    switch (command.toLowerCase()) {
      case "help":
        this.addMessage(
          "assistant",
          [
            "Slash commands:",
            "/help",
            "/model <model-id>",
            "/reindex",
            "/clear",
            "/save",
            "/mode vault|note",
            "/find <query>",
            "/tag <tag>",
            "/open <query>",
            "/pin <text>",
            "/pins"
          ].join("\n")
        );
        return true;
      case "model":
        if (!arg) {
          this.addMessage("assistant", `Current model: ${this.plugin.settings.model}`);
        } else {
          this.plugin.settings.model = arg;
          await this.plugin.saveSettings();
          this.addMessage("assistant", `Model set to: ${arg}`);
        }
        return true;
      case "reindex":
        await this.plugin.rebuildIndex();
        this.addMessage("assistant", "Vault index rebuilt.");
        return true;
      case "clear":
        this.messages = [];
        this.pendingActions = [];
        this.conversationSummary = "";
        this.transcriptEl.empty();
        return true;
      case "save":
        await this.saveChat();
        return true;
      case "mode":
        if (arg === "vault") {
          await this.switchMode("vault");
        } else if (arg === "note") {
          const activeFile = this.app.workspace.getActiveFile();
          if (!activeFile || activeFile.extension !== "md") {
            new Notice("Open a markdown note first.");
          } else {
            await this.switchMode("note", activeFile.path);
          }
        } else {
          this.addMessage("assistant", "Usage: /mode vault|note");
        }
        return true;
      case "find":
        if (!arg) {
          this.addMessage("assistant", "Usage: /find <query>");
          return true;
        }
        this.handleFind(arg);
        return true;
      case "tag":
        if (!arg) {
          this.addMessage("assistant", "Usage: /tag <tag>");
          return true;
        }
        await this.handleTag(arg.replace(/^#/, ""));
        return true;
      case "open":
        if (!arg) {
          this.addMessage("assistant", "Usage: /open <path-fragment>");
          return true;
        }
        await this.handleOpen(arg);
        return true;
      case "pin":
        if (!arg) {
          this.pinLastMessage();
        } else {
          this.pinnedMessages.push({ role: "user", content: arg });
          this.addMessage("assistant", `Pinned: ${arg}`);
        }
        return true;
      case "pins":
        this.addMessage(
          "assistant",
          this.pinnedMessages.length
            ? this.pinnedMessages.map((msg, idx) => `${idx + 1}. ${msg.role}: ${msg.content}`).join("\n")
            : "No pinned messages."
        );
        return true;
      default:
        this.addMessage("assistant", `Unknown command: /${command}. Use /help.`);
        return true;
    }
  }

  private handleFind(query: string): void {
    const q = query.toLowerCase();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.toLowerCase().includes(q))
      .slice(0, 20);

    if (!files.length) {
      this.addMessage("assistant", `No notes found for: ${query}`);
      return;
    }

    this.addMessage("assistant", files.map((file) => `- ${file.path}`).join("\n"));
  }

  private async handleTag(tag: string): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const matches: string[] = [];

    for (const file of files) {
      const text = await this.app.vault.cachedRead(file);
      const hasInlineTag = new RegExp(`(^|\\s)#${tag}(\\b|\\s|$)`, "i").test(text);
      const hasFrontmatterTag = new RegExp(`(^|\\n)tags:\\s*(.*${tag}.*)$`, "im").test(text);
      if (hasInlineTag || hasFrontmatterTag) {
        matches.push(file.path);
      }
      if (matches.length >= 20) {
        break;
      }
    }

    this.addMessage(
      "assistant",
      matches.length ? matches.map((path) => `- ${path}`).join("\n") : `No notes found for tag #${tag}`
    );
  }

  private async handleOpen(query: string): Promise<void> {
    const q = query.toLowerCase();
    const file = this.app.vault
      .getMarkdownFiles()
      .find((candidate) => candidate.path.toLowerCase().includes(q));

    if (!file) {
      this.addMessage("assistant", `No matching note to open for: ${query}`);
      return;
    }

    await this.app.workspace.getLeaf(true).openFile(file);
    this.addMessage("assistant", `Opened: ${file.path}`);
  }

  private addMessage(
    role: "user" | "assistant",
    text: string,
    metaText?: string,
    referencedFiles: TFile[] = [],
    thinkingText?: string
  ): void {
    const bubble = this.transcriptEl.createDiv({
      cls: `rag-openrouter-note-chat-message rag-openrouter-note-chat-message-${role}`
    });

    bubble.createDiv({
      cls: "rag-openrouter-note-chat-message-role",
      text: role === "user" ? "You" : "Assistant"
    });

    const contentEl = bubble.createDiv({
      cls: "rag-openrouter-note-chat-message-content",
      text
    });

    if (role === "assistant") {
      void this.renderAssistantMarkdown(contentEl, text);
    }

    if (role === "assistant" && thinkingText) {
      bubble.createDiv({
        cls: "rag-openrouter-note-chat-message-thinking",
        text: thinkingText
      });
    }

    if (metaText) {
      bubble.createDiv({
        cls: "rag-openrouter-note-chat-message-meta",
        text: metaText
      });
    }

    if (role === "assistant" && referencedFiles.length) {
      const refsWrap = bubble.createDiv({ cls: "rag-openrouter-note-chat-message-links" });
      refsWrap.createDiv({
        cls: "rag-openrouter-note-chat-message-links-title",
        text: "Referenced files"
      });

      const refsList = refsWrap.createEl("ul", { cls: "rag-openrouter-note-chat-message-links-list" });
      for (const file of referencedFiles) {
        const li = refsList.createEl("li");
        const link = li.createEl("a", { text: file.path, href: "#" });
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          await this.app.workspace.getLeaf(true).openFile(file);
        });
      }
    }

    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private async sendMessage(): Promise<void> {
    const question = this.inputEl.value.trim();
    if (!question) {
      return;
    }

    if (await this.handleSlashCommand(question)) {
      this.inputEl.value = "";
      return;
    }

    if (this.mode === "note" && !this.notePath) {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile || activeFile.extension !== "md") {
        new Notice("Open a markdown note first.");
        return;
      }
      this.notePath = activeFile.path;
    }

    const historyBeforeTurn = [...this.messages];
    await this.maybeSummarizeHistory(historyBeforeTurn);
    const modelHistory = this.getHistoryForModel(historyBeforeTurn);

    if (this.conversationSummary) {
      modelHistory.unshift({
        role: "assistant",
        content: `Conversation summary memory:\n${this.conversationSummary}`
      });
    }

    this.messages.push({ role: "user", content: question });
    this.addMessage("user", question);
    this.inputEl.value = "";
    this.sendButtonEl.disabled = true;
    this.saveButtonEl.disabled = true;

    const assistantBubble = this.transcriptEl.createDiv({
      cls: "rag-openrouter-note-chat-message rag-openrouter-note-chat-message-assistant"
    });
    assistantBubble.createDiv({
      cls: "rag-openrouter-note-chat-message-role",
      text: "Assistant"
    });
    const assistantContentEl = assistantBubble.createDiv({
      cls: "rag-openrouter-note-chat-message-content",
      text: ""
    });
    const assistantThinkingWrap = assistantBubble.createDiv({
      cls: "rag-openrouter-thinking-wrap"
    });
    const assistantThinkingToggleEl = assistantThinkingWrap.createEl("button", {
      cls: "rag-openrouter-thinking-toggle",
      text: "Thinking (streaming)"
    });
    const assistantThinkingEl = assistantThinkingWrap.createDiv({
      cls: "rag-openrouter-note-chat-message-thinking",
      text: ""
    });
    const assistantMetaEl = assistantBubble.createDiv({
      cls: "rag-openrouter-note-chat-message-meta",
      text: "Streaming..."
    });
    const thinkingView = this.plugin.settings.thinkingView;

    let streamedAnswer = "";
    let streamedThinking = "";
    let thinkingExpanded = true;

    const setThinkingExpanded = (expanded: boolean, streaming: boolean): void => {
      thinkingExpanded = expanded;
      assistantThinkingWrap.toggleClass("is-collapsed", !thinkingExpanded);
      if (streamedThinking) {
        if (streaming) {
          assistantThinkingToggleEl.setText(
            thinkingExpanded ? "Thinking (streaming)" : "Thinking (streaming, collapsed)"
          );
        } else {
          assistantThinkingToggleEl.setText(thinkingExpanded ? "Thinking" : "Thinking (collapsed)");
        }
      }
    };

    assistantThinkingToggleEl.addEventListener("click", () => {
      setThinkingExpanded(!thinkingExpanded, false);
    });

    try {
      if (this.mode === "note") {
        const result = await this.plugin.streamChatWithNote(this.notePath, question, modelHistory, {
          onAnswerDelta: (delta) => {
            streamedAnswer += delta;
            assistantContentEl.setText(streamedAnswer);
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
          },
          onThinkingDelta: (delta) => {
            if (thinkingView === "hidden") {
              return;
            }

            streamedThinking += delta;
            assistantThinkingEl.setText(streamedThinking);
            setThinkingExpanded(true, true);
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
          }
        });

        this.messages.push({ role: "assistant", content: result.answer });
        const sourceMeta =
          result.chunks.length > 0
            ? `Sources from this note: ${result.chunks.length}`
            : "No matching chunks found in this note.";

        await this.renderAssistantMarkdown(assistantContentEl, result.answer, result.chunks);
        assistantMetaEl.setText(sourceMeta);
        this.renderCitationLinks(assistantBubble, result.answer, result.chunks);
        this.renderReferencedFiles(assistantBubble, result.answer, result.chunks);
      } else {
        const result = await this.plugin.streamChatWithVault(question, modelHistory, {
          onAnswerDelta: (delta) => {
            streamedAnswer += delta;
            assistantContentEl.setText(streamedAnswer);
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
          },
          onThinkingDelta: (delta) => {
            if (thinkingView === "hidden") {
              return;
            }

            streamedThinking += delta;
            assistantThinkingEl.setText(streamedThinking);
            setThinkingExpanded(true, true);
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
          }
        });

        this.messages.push({ role: "assistant", content: result.answer });
        const metaParts: string[] = [];
        metaParts.push(
          result.chunks.length > 0
            ? `Vault sources used: ${result.chunks.length}`
            : "No matching vault chunks found."
        );

        await this.renderAssistantMarkdown(assistantContentEl, result.answer, result.chunks);
        assistantMetaEl.setText(metaParts.join(" | "));

        this.pendingActions = this.prepareActionsWithCitationLinks(result.pendingActions, result.chunks);

        this.renderCitationLinks(assistantBubble, result.answer, result.chunks);
        this.renderReferencedFiles(assistantBubble, result.answer, result.chunks);
        this.renderPendingActions(assistantBubble);
      }

      if (thinkingView === "hidden" || !streamedThinking) {
        assistantThinkingWrap.remove();
      } else {
        setThinkingExpanded(thinkingView === "expanded", false);
      }
    } catch (error) {
      assistantMetaEl.setText("Failed");
      console.error("Sidebar chat failed", error);
      new Notice(`Chat failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sendButtonEl.disabled = false;
      this.saveButtonEl.disabled = false;
      this.inputEl.focus();
    }
  }

  private async saveChat(): Promise<void> {
    try {
      const title = this.mode === "note" ? "Sidebar Note Chat" : "Sidebar Vault Agent Chat";
      const file = await this.plugin.saveChatAsNote(title, this.messages);
      new Notice(`Chat saved: ${file.path}`);
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (error) {
      new Notice(`Failed to save chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private normalizeAssistantMarkdown(text: string, chunks: NoteChunk[] = []): string {
    const vaultName = this.app.vault.getName();
    let output = text;
    const style = this.plugin.settings.citationStyle;

    // Normalize model-specific citation tokens like [4†L13-L16] -> [4]
    output = output.replace(/\[(\d+)\s*†[^\]]*\]/g, "[$1]");

    const citationUri = (numText: string): string | null => {
      const idx = Number.parseInt(numText, 10);
      if (!Number.isFinite(idx) || idx < 1 || idx > chunks.length) {
        return null;
      }

      const path = chunks[idx - 1]?.filePath;
      if (!path) {
        return null;
      }

      return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path)}`;
    };

    if (style === "phrase") {
      // Turn bold cited phrases into clickable phrase links: **Registry Rewrite** [1]
      output = output.replace(
        /\*\*([^*\n][^*\n]{0,120}?)\*\*\s*\[(\d+)\]/g,
        (full, phrase: string, numText: string) => {
          const uri = citationUri(numText);
          if (!uri) {
            return full;
          }

          return `**[${phrase.trim()}](${uri})**`;
        }
      );

      // Turn plain cited phrases into clickable phrase links: Registry Rewrite [1]
      output = output.replace(
        /(^|[\s(>\-•])([A-Za-z][A-Za-z0-9'’\-]{1,30}(?:\s+[A-Za-z0-9'’\-]{1,30}){0,5})\s*\[(\d+)\]/gm,
        (full, prefix: string, phrase: string, numText: string) => {
          const uri = citationUri(numText);
          if (!uri) {
            return full;
          }

          return `${prefix}[${phrase.trim()}](${uri})`;
        }
      );

      output = output.replace(/\[(\d+)\]/g, (full, numText: string) => {
        const uri = citationUri(numText);
        if (!uri) {
          return full;
        }

        return `[source ${numText}](${uri})`;
      });
      return output;
    }

    if (style === "source") {
      output = output.replace(/\[(\d+)\]/g, (full, numText: string) => {
        const uri = citationUri(numText);
        if (!uri) {
          return full;
        }

        return `[source ${numText}](${uri})`;
      });
      return output;
    }

    // footer mode: remove inline citation markers and rely on footer citations list.
    output = output.replace(/\[(\d+)\]/g, "");
    output = output.replace(/\s{2,}/g, " ");
    output = output.replace(/\s+([.,;:!?])/g, "$1");

    return output;
  }

  private async renderAssistantMarkdown(
    target: HTMLElement,
    text: string,
    chunks: NoteChunk[] = []
  ): Promise<void> {
    target.empty();
    const markdown = this.normalizeAssistantMarkdown(text, chunks);
    await MarkdownRenderer.renderMarkdown(markdown, target, this.notePath || "", this);
  }
}

class AskQuestionModal extends Modal {
  private onSubmit: (question: string) => Promise<void>;

  constructor(app: App, onSubmit: (question: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rag-openrouter-modal");

    contentEl.createEl("h2", { text: "Ask With Vault Context" });

    const input = contentEl.createEl("textarea", {
      attr: { placeholder: "Ask a question about your notes..." }
    });

    const button = contentEl.createEl("button", { text: "Ask" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await this.onSubmit(input.value);
        this.close();
      } catch (error) {
        console.error(error);
        new Notice(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        button.disabled = false;
      }
    });

    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ModelSearchModal extends Modal {
  private plugin: RagOpenRouterPlugin;
  private onSelectModel: (modelId: string) => Promise<void>;
  private models: OpenRouterModel[] = [];
  private query = "";
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;

  constructor(
    app: App,
    plugin: RagOpenRouterPlugin,
    onSelectModel: (modelId: string) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.onSelectModel = onSelectModel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rag-openrouter-model-search-modal");

    contentEl.createEl("h2", { text: "Search OpenRouter Models" });

    const controlsEl = contentEl.createDiv({ cls: "rag-openrouter-model-search-controls" });

    const input = controlsEl.createEl("input", {
      type: "search",
      placeholder: "Search model id, for example nvidia/nemotron-3-super-120b-a12b:free"
    });

    const refreshButton = controlsEl.createEl("button", { text: "Refresh" });

    this.statusEl = contentEl.createDiv({ cls: "rag-openrouter-model-search-status" });
    this.listEl = contentEl.createDiv({ cls: "rag-openrouter-model-search-results" });

    input.addEventListener("input", () => {
      this.query = input.value.trim().toLowerCase();
      this.renderModelList();
    });

    refreshButton.addEventListener("click", async () => {
      await this.loadModels(true);
    });

    void this.loadModels(false);
    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadModels(forceRefresh: boolean): Promise<void> {
    this.statusEl.setText("Loading models...");
    this.listEl.empty();

    try {
      this.models = await this.plugin.getOpenRouterModels(forceRefresh);
      this.renderModelList();
    } catch (error) {
      console.error("Failed to load OpenRouter models", error);
      this.statusEl.setText(
        `Failed to load models: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private renderModelList(): void {
    this.listEl.empty();

    const filteredModels = this.models.filter((model) => {
      const modelId = model.id.toLowerCase();
      return !this.query || modelId.includes(this.query);
    });

    this.statusEl.setText(`Showing ${filteredModels.length} of ${this.models.length} models`);

    if (!filteredModels.length) {
      this.listEl.createDiv({
        cls: "rag-openrouter-model-search-empty",
        text: "No models match your search."
      });
      return;
    }

    for (const model of filteredModels.slice(0, 200)) {
      const row = this.listEl.createEl("button", {
        cls: "rag-openrouter-model-row"
      });

      row.createDiv({ cls: "rag-openrouter-model-id", text: model.id });

      row.addEventListener("click", async () => {
        try {
          await this.onSelectModel(model.id);
          new Notice(`Selected model: ${model.id}`);
          this.close();
        } catch (error) {
          console.error("Failed to set model", error);
          new Notice(`Failed to set model: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  }
}

class RagOpenRouterSettingTab extends PluginSettingTab {
  plugin: RagOpenRouterPlugin;

  constructor(app: App, plugin: RagOpenRouterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "RAG OpenRouter Notes Settings" });

    new Setting(containerEl)
      .setName("OpenRouter API key")
      .setDesc("Used to call OpenRouter chat completion API.")
      .addText((text) =>
        text
          .setPlaceholder("sk-or-v1-...")
          .setValue(this.plugin.settings.openRouterApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openRouterApiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("OpenRouter model slug, for example openai/gpt-4o-mini.")
      .addText((text) =>
        text
          .setPlaceholder("openai/gpt-4o-mini")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) =>
        button.setButtonText("Search").onClick(() => {
          new ModelSearchModal(this.app, this.plugin, async (modelId) => {
            this.plugin.settings.model = modelId;
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Max retrieved chunks")
      .setDesc("Number of note chunks sent as context.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setValue(this.plugin.settings.maxChunks)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxChunks = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Approximate number of characters per indexed chunk.")
      .addSlider((slider) =>
        slider
          .setLimits(300, 2000, 50)
          .setValue(this.plugin.settings.chunkSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.chunkSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Answer folder")
      .setDesc("Folder where generated answer notes are stored.")
      .addText((text) =>
        text
          .setPlaceholder("RAG Answers")
          .setValue(this.plugin.settings.answerFolder)
          .onChange(async (value) => {
            this.plugin.settings.answerFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Citation style")
      .setDesc("How citations appear in assistant answers.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("phrase", "Phrase links")
          .addOption("source", "Source links")
          .addOption("footer", "Footer only")
          .setValue(this.plugin.settings.citationStyle)
          .onChange(async (value: "phrase" | "source" | "footer") => {
            this.plugin.settings.citationStyle = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Thinking view")
      .setDesc("How model thinking is displayed in chat answers.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("collapsed", "Collapsed")
          .addOption("expanded", "Expanded")
          .addOption("hidden", "Hidden")
          .setValue(this.plugin.settings.thinkingView)
          .onChange(async (value: "collapsed" | "expanded" | "hidden") => {
            this.plugin.settings.thinkingView = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Re-index notes")
      .setDesc("Run indexing after changing chunk settings or note content.")
      .addButton((button) =>
        button.setButtonText("Rebuild index").onClick(async () => {
          await this.plugin.rebuildIndex();
        })
      );
  }
}
