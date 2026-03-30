var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => RagOpenRouterPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  openRouterApiKey: "",
  model: "openai/gpt-4o-mini",
  maxChunks: 6,
  chunkSize: 700,
  answerFolder: "RAG Answers",
  citationStyle: "phrase",
  thinkingView: "collapsed"
};
var RAG_CHAT_VIEW_TYPE = "rag-openrouter-chat-sidebar";
var RagOpenRouterPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.noteIndex = [];
    this.modelCache = [];
    this.modelCacheUpdatedAt = 0;
  }
  async onload() {
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
          new import_obsidian.Notice("Open a markdown note first.");
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
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.openRouterApiKey = this.settings.openRouterApiKey.trim();
    this.settings.model = this.settings.model.trim() || DEFAULT_SETTINGS.model;
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  onunload() {
    this.noteIndex = [];
    this.app.workspace.getLeavesOfType(RAG_CHAT_VIEW_TYPE).forEach((leaf) => leaf.detach());
  }
  async openChatSidebar(mode, notePath) {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getRightLeaf(true);
    if (!leaf) {
      new import_obsidian.Notice("Unable to open chat sidebar.");
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
  getApiKeyOrThrow() {
    const key = this.settings.openRouterApiKey.trim();
    if (!key) {
      throw new Error("Set your OpenRouter API key in plugin settings first.");
    }
    return key;
  }
  async getOpenRouterModels(forceRefresh = false) {
    const cacheIsFresh = this.modelCache.length > 0 && Date.now() - this.modelCacheUpdatedAt < 10 * 60 * 1e3;
    if (!forceRefresh && cacheIsFresh) {
      return this.modelCache;
    }
    const headers = {
      "Content-Type": "application/json",
      "HTTP-Referer": "https://obsidian.md",
      "X-Title": "Obsidian RAG OpenRouter Plugin"
    };
    if (this.settings.openRouterApiKey.trim()) {
      headers.Authorization = `Bearer ${this.settings.openRouterApiKey.trim()}`;
    }
    const response = await (0, import_obsidian.requestUrl)({
      url: "https://openrouter.ai/api/v1/models",
      method: "GET",
      headers
    });
    const modelsRaw = Array.isArray(response.json?.data) ? response.json.data : [];
    const models = modelsRaw.map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const obj = item;
      const id = typeof obj.id === "string" ? obj.id : "";
      if (!id) {
        return null;
      }
      return {
        id,
        name: typeof obj.name === "string" ? obj.name : void 0,
        description: typeof obj.description === "string" ? obj.description : void 0,
        contextLength: typeof obj.context_length === "number" ? obj.context_length : void 0
      };
    }).filter((model) => Boolean(model)).sort((a, b) => a.id.localeCompare(b.id));
    this.modelCache = models;
    this.modelCacheUpdatedAt = Date.now();
    return models;
  }
  async handleQuestion(question) {
    if (!question.trim()) {
      new import_obsidian.Notice("Question cannot be empty.");
      return;
    }
    if (!this.settings.openRouterApiKey.trim()) {
      new import_obsidian.Notice("Set your OpenRouter API key in plugin settings first.");
      return;
    }
    if (!this.noteIndex.length) {
      await this.rebuildIndex();
    }
    const topChunks = this.retrieveRelevantChunks(question);
    const answer = await this.queryOpenRouter(question, topChunks);
    const createdFile = await this.writeAnswerNote(question, answer, topChunks);
    await this.app.workspace.getLeaf(true).openFile(createdFile);
    new import_obsidian.Notice(`Answer created: ${createdFile.path}`);
  }
  tokenize(input) {
    return input.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2);
  }
  splitIntoChunks(text, chunkSize) {
    const chunks = [];
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
    let current = "";
    for (const paragraph of paragraphs) {
      if (current.length + paragraph.length + 2 <= chunkSize) {
        current = current ? `${current}

${paragraph}` : paragraph;
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
  hardSplit(text, chunkSize) {
    const result = [];
    let start = 0;
    while (start < text.length) {
      result.push(text.slice(start, start + chunkSize));
      start += chunkSize;
    }
    return result;
  }
  async rebuildIndex() {
    const files = this.app.vault.getMarkdownFiles();
    const chunks = [];
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
    new import_obsidian.Notice(`Indexed ${files.length} notes into ${chunks.length} chunks.`);
  }
  retrieveRelevantChunks(question) {
    const queryTokens = this.tokenize(question);
    if (!queryTokens.length) {
      return [];
    }
    const scored = this.noteIndex.map((chunk) => {
      const tokenSet = new Set(chunk.tokens);
      let score = 0;
      for (const token of queryTokens) {
        if (tokenSet.has(token)) {
          score += 1;
        }
      }
      const normalizedScore = score / Math.sqrt(chunk.tokens.length);
      return { chunk, score: normalizedScore };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, this.settings.maxChunks).map((x) => x.chunk);
    return scored;
  }
  retrieveRelevantChunksForFile(question, filePath) {
    const queryTokens = this.tokenize(question);
    if (!queryTokens.length) {
      return [];
    }
    const scored = this.noteIndex.filter((chunk) => chunk.filePath === filePath).map((chunk) => {
      const tokenSet = new Set(chunk.tokens);
      let score = 0;
      for (const token of queryTokens) {
        if (tokenSet.has(token)) {
          score += 1;
        }
      }
      const normalizedScore = score / Math.sqrt(chunk.tokens.length);
      return { chunk, score: normalizedScore };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, this.settings.maxChunks).map((x) => x.chunk);
    return scored;
  }
  async queryOpenRouterWithMessages(systemPrompt, messages) {
    const apiKey = this.getApiKeyOrThrow();
    const response = await (0, import_obsidian.requestUrl)({
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
  async summarizeChatMessages(messages) {
    if (!messages.length) {
      return "";
    }
    const transcript = messages.map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`).join("\n\n");
    const summary = await this.queryOpenRouterWithMessages(
      "Summarize the conversation into compact factual memory bullets. Keep critical constraints and decisions.",
      [{ role: "user", content: transcript }]
    );
    return summary.trim();
  }
  async streamOpenRouterWithMessages(systemPrompt, messages, handlers = {}) {
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
          const payload = JSON.parse(payloadText);
          const delta = payload.choices?.[0]?.delta;
          const contentDelta = typeof delta?.content === "string" ? delta.content : "";
          const reasoningDelta = typeof delta?.reasoning === "string" ? delta.reasoning : typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
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
  async queryOpenRouter(question, contextChunks) {
    const contextText = contextChunks.map((chunk, index) => {
      return `Source ${index + 1} (${chunk.filePath}):
${chunk.chunkText}`;
    }).join("\n\n---\n\n");
    const systemPrompt = "You are a note assistant. Answer the question using the provided note context when relevant. If context is insufficient, say what is missing.";
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
  async chatWithNote(noteFilePath, question, history) {
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
    const contextText = topChunks.map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):
${chunk.chunkText}`).join("\n\n---\n\n");
    const systemPrompt = "You are a note assistant. Keep responses grounded in the provided note context and conversation history. If context is missing, say what is missing.";
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
  async streamChatWithNote(noteFilePath, question, history, handlers = {}) {
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
    const contextText = topChunks.map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):
${chunk.chunkText}`).join("\n\n---\n\n");
    const systemPrompt = "You are a note assistant. Keep responses grounded in the provided note context and conversation history. If context is missing, say what is missing.";
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
  async chatWithVault(question, history) {
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
    const contextText = topChunks.map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):
${chunk.chunkText}`).join("\n\n---\n\n");
    const systemPrompt = [
      "You are a vault assistant. Use provided note context and conversation history.",
      "You may create folders/files when explicitly useful to the user's request.",
      "Never delete or rename files.",
      "When proposing actions, append exactly one fenced code block with language tag agent-actions and JSON payload:",
      '{"actions":[{"type":"create_folder","path":"Folder"},{"type":"create_file","path":"Folder/file.md","content":"...","overwrite":false},{"type":"append_file","path":"Folder/file.md","content":"..."},{"type":"insert_after_heading","path":"Folder/file.md","heading":"## Section","content":"..."},{"type":"replace_in_file","path":"Folder/file.md","find":"old","replace":"new","replaceAll":false},{"type":"create_from_template","path":"Folder/plan.md","template":"project-plan","variables":{"title":"Project"}}]}',
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
  async streamChatWithVault(question, history, handlers = {}) {
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
    const contextText = topChunks.map((chunk, index) => `Source ${index + 1} (${chunk.filePath}):
${chunk.chunkText}`).join("\n\n---\n\n");
    const systemPrompt = [
      "You are a vault assistant. Use provided note context and conversation history.",
      "You may create folders/files when explicitly useful to the user's request.",
      "Never delete or rename files.",
      "When proposing actions, append exactly one fenced code block with language tag agent-actions and JSON payload:",
      '{"actions":[{"type":"create_folder","path":"Folder"},{"type":"create_file","path":"Folder/file.md","content":"...","overwrite":false},{"type":"append_file","path":"Folder/file.md","content":"..."},{"type":"insert_after_heading","path":"Folder/file.md","heading":"## Section","content":"..."},{"type":"replace_in_file","path":"Folder/file.md","find":"old","replace":"new","replaceAll":false},{"type":"create_from_template","path":"Folder/plan.md","template":"project-plan","variables":{"title":"Project"}}]}',
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
  extractAgentActions(rawAnswer) {
    const candidates = [];
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
    let parsedActions = [];
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
  parseActionsFromJson(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object") {
      return [];
    }
    const maybeActions = parsed.actions;
    if (!Array.isArray(maybeActions)) {
      return [];
    }
    const actions = [];
    for (const action of maybeActions) {
      if (!action || typeof action !== "object") {
        continue;
      }
      const obj = action;
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
          overwrite: typeof obj.overwrite === "boolean" ? obj.overwrite : void 0
        });
        continue;
      }
      if (type === "append_file" && path && typeof obj.content === "string") {
        actions.push({ type: "append_file", path, content: obj.content });
        continue;
      }
      if (type === "insert_after_heading" && path && typeof obj.heading === "string" && typeof obj.content === "string") {
        actions.push({
          type: "insert_after_heading",
          path,
          heading: obj.heading,
          content: obj.content,
          createIfMissing: typeof obj.createIfMissing === "boolean" ? obj.createIfMissing : void 0
        });
        continue;
      }
      if (type === "replace_in_file" && path && typeof obj.find === "string" && typeof obj.replace === "string") {
        actions.push({
          type: "replace_in_file",
          path,
          find: obj.find,
          replace: obj.replace,
          replaceAll: typeof obj.replaceAll === "boolean" ? obj.replaceAll : void 0
        });
        continue;
      }
      if (type === "create_from_template" && path && typeof obj.template === "string") {
        const variablesRaw = obj.variables;
        const variables = {};
        if (variablesRaw && typeof variablesRaw === "object") {
          for (const [key, value] of Object.entries(variablesRaw)) {
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
          overwrite: typeof obj.overwrite === "boolean" ? obj.overwrite : void 0
        });
      }
    }
    return actions;
  }
  extractFirstActionsJSONObject(text) {
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
  sanitizeVaultPath(path) {
    const trimmed = path.trim().replace(/\\/g, "/");
    if (!trimmed) {
      return null;
    }
    if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("/")) {
      return null;
    }
    const normalized = (0, import_obsidian.normalizePath)(trimmed);
    if (!normalized || normalized === ".") {
      return null;
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "..")) {
      return null;
    }
    return normalized;
  }
  async ensureFolderExists(folderPath) {
    if (!folderPath) {
      return;
    }
    const segments = folderPath.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing) {
        if (existing instanceof import_obsidian.TFile) {
          throw new Error(`Cannot create folder ${current}: a file exists at this path.`);
        }
        continue;
      }
      await this.app.vault.createFolder(current);
    }
  }
  async applyAgentActions(actions) {
    let createdFolders = 0;
    let createdFiles = 0;
    let updatedFiles = 0;
    let skipped = 0;
    const errors = [];
    for (const action of actions) {
      try {
        const safePath = this.sanitizeVaultPath(action.path);
        if (!safePath) {
          skipped += 1;
          continue;
        }
        if (action.type === "create_folder") {
          const existing2 = this.app.vault.getAbstractFileByPath(safePath);
          if (existing2) {
            skipped += 1;
            continue;
          }
          await this.ensureFolderExists(safePath);
          createdFolders += 1;
          continue;
        }
        if (action.type === "create_from_template") {
          const content = this.renderTemplate(action.template, action.variables ?? {});
          const folderPath2 = safePath.includes("/") ? safePath.slice(0, safePath.lastIndexOf("/")) : "";
          await this.ensureFolderExists(folderPath2);
          const existing2 = this.app.vault.getAbstractFileByPath(safePath);
          if (existing2) {
            if (!(existing2 instanceof import_obsidian.TFile)) {
              errors.push(`Cannot create file ${safePath}: a folder exists at this path.`);
              continue;
            }
            if (!action.overwrite) {
              skipped += 1;
              continue;
            }
            await this.app.vault.modify(existing2, content);
            updatedFiles += 1;
            continue;
          }
          await this.app.vault.create(safePath, content);
          createdFiles += 1;
          continue;
        }
        if (action.type === "append_file") {
          const existing2 = this.app.vault.getAbstractFileByPath(safePath);
          if (!(existing2 instanceof import_obsidian.TFile)) {
            errors.push(`Cannot append to ${safePath}: file not found.`);
            continue;
          }
          const current = await this.app.vault.cachedRead(existing2);
          const separator = current.endsWith("\n") || action.content.startsWith("\n") ? "" : "\n\n";
          await this.app.vault.modify(existing2, `${current}${separator}${action.content}`);
          updatedFiles += 1;
          continue;
        }
        if (action.type === "insert_after_heading") {
          const existing2 = this.app.vault.getAbstractFileByPath(safePath);
          if (!(existing2 instanceof import_obsidian.TFile)) {
            errors.push(`Cannot insert in ${safePath}: file not found.`);
            continue;
          }
          const current = await this.app.vault.cachedRead(existing2);
          const escapedHeading = action.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const headingRegex = new RegExp(`^${escapedHeading}\\s*$`, "m");
          const headingMatch = headingRegex.exec(current);
          if (!headingMatch) {
            if (action.createIfMissing) {
              const appended = `${current}${current.endsWith("\n") ? "" : "\n\n"}${action.heading}
${action.content}`;
              await this.app.vault.modify(existing2, appended);
              updatedFiles += 1;
            } else {
              skipped += 1;
            }
            continue;
          }
          const insertIndex = headingMatch.index + headingMatch[0].length;
          const updated = `${current.slice(0, insertIndex)}
${action.content}${current.slice(insertIndex)}`;
          await this.app.vault.modify(existing2, updated);
          updatedFiles += 1;
          continue;
        }
        if (action.type === "replace_in_file") {
          const existing2 = this.app.vault.getAbstractFileByPath(safePath);
          if (!(existing2 instanceof import_obsidian.TFile)) {
            errors.push(`Cannot replace in ${safePath}: file not found.`);
            continue;
          }
          const current = await this.app.vault.cachedRead(existing2);
          if (!current.includes(action.find)) {
            skipped += 1;
            continue;
          }
          const updated = action.replaceAll ? current.split(action.find).join(action.replace) : current.replace(action.find, action.replace);
          await this.app.vault.modify(existing2, updated);
          updatedFiles += 1;
          continue;
        }
        const folderPath = safePath.includes("/") ? safePath.slice(0, safePath.lastIndexOf("/")) : "";
        await this.ensureFolderExists(folderPath);
        const existing = this.app.vault.getAbstractFileByPath(safePath);
        if (existing) {
          if (!(existing instanceof import_obsidian.TFile)) {
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
  renderTemplate(template, variables) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const templates = {
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
    const defaults = {
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
    return source.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_full, key) => {
      return variables[key] ?? defaults[key] ?? "";
    });
  }
  async writeAnswerNote(question, answer, chunks) {
    const folder = this.settings.answerFolder.trim();
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const baseName = `RAG Answer ${timestamp}.md`;
    const filePath = folder ? `${folder}/${baseName}` : baseName;
    const sourceList = chunks.length ? chunks.map((chunk, idx) => `- [${idx + 1}] ${chunk.filePath}`).join("\n") : "- No relevant sources found.";
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
  getReferencedFiles(answer, chunks) {
    const referencedPaths = /* @__PURE__ */ new Set();
    for (const chunk of chunks) {
      referencedPaths.add(chunk.filePath);
    }
    const mdPathRegex = /(^|[\s(\["'])((?:[^\s)\]"']+\/)*[^\s)\]"']+\.md)($|[\s)\]"'.,;:!?])/gi;
    let match;
    while ((match = mdPathRegex.exec(answer)) !== null) {
      const candidate = match[2].replace(/^\/+/, "");
      if (candidate) {
        referencedPaths.add(candidate);
      }
    }
    const files = [];
    for (const path of referencedPaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof import_obsidian.TFile) {
        files.push(file);
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }
  getCitationLinks(answer, chunks) {
    const seen = /* @__PURE__ */ new Set();
    const citations = [];
    const citationRegex = /\[(\d+)\]/g;
    let match;
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
      if (file instanceof import_obsidian.TFile) {
        seen.add(number);
        citations.push({ number, file });
      }
    }
    return citations;
  }
  resolveObsidianUriToPath(uriText) {
    const trimmed = uriText.trim();
    if (!trimmed.toLowerCase().startsWith("obsidian://open?")) {
      return null;
    }
    let parsed;
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
  resolveObsidianUriToFile(uriText) {
    const safePath = this.resolveObsidianUriToPath(uriText);
    if (!safePath) {
      return null;
    }
    const file = this.app.vault.getAbstractFileByPath(safePath);
    return file instanceof import_obsidian.TFile ? file : null;
  }
  async saveChatAsNote(chatTitle, messages) {
    if (!messages.length) {
      throw new Error("No chat messages to save yet.");
    }
    const rootFolder = this.settings.answerFolder.trim();
    const chatFolder = rootFolder ? `${rootFolder}/RAG Chats` : "RAG Chats";
    await this.ensureFolderExists(chatFolder);
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const safeTitle = (chatTitle || "Vault Chat").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
    const fileName = `${safeTitle} ${timestamp}.md`;
    const filePath = `${chatFolder}/${fileName}`;
    const transcript = messages.map((msg, index) => {
      const role = msg.role === "user" ? "User" : "Assistant";
      return [`### ${index + 1}. ${role}`, "", msg.content.trim()].join("\n");
    }).join("\n\n");
    const content = [
      `# ${safeTitle}`,
      "",
      `Created: ${(/* @__PURE__ */ new Date()).toISOString()}`,
      "",
      "## Transcript",
      "",
      transcript
    ].join("\n");
    return this.app.vault.create(filePath, content);
  }
};
var RagChatSidebarView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.mode = "vault";
    this.notePath = "";
    this.messages = [];
    this.pinnedMessages = [];
    this.keepTurns = 8;
    this.summarizeOldTurns = true;
    this.conversationSummary = "";
    this.pendingActions = [];
    this.isDraggingUri = false;
    this.plugin = plugin;
  }
  getViewType() {
    return RAG_CHAT_VIEW_TYPE;
  }
  getDisplayText() {
    return "RAG Chat";
  }
  getIcon() {
    return "message-square";
  }
  async onOpen() {
    const state = this.leaf.getViewState().state;
    this.mode = state?.mode === "note" ? "note" : "vault";
    this.notePath = typeof state?.notePath === "string" ? state.notePath : "";
    this.render();
  }
  async onClose() {
    this.contentEl.empty();
  }
  render() {
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
        new import_obsidian.Notice("Open a markdown note first.");
        return;
      }
      await this.switchMode("note", activeFile.path);
    });
    const scopeText = this.mode === "vault" ? "Scope: Entire vault." : this.notePath ? `Scope: ${this.notePath}` : "Scope: Current markdown note.";
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
      new import_obsidian.Notice("Pinned messages cleared.");
    });
    memoryControls.createDiv({
      cls: "rag-openrouter-chat-sidebar-memory-count",
      text: `Pins: ${this.pinnedMessages.length}`
    });
    this.transcriptEl = contentEl.createDiv({ cls: "rag-openrouter-note-chat-transcript" });
    const inputWrap = contentEl.createDiv({ cls: "rag-openrouter-note-chat-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      attr: {
        placeholder: this.mode === "vault" ? "Ask about your vault or request file/folder creation..." : "Ask about this note..."
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
      const hasText = Array.from(event.dataTransfer.types).some(
        (type) => type === "text/plain" || type === "text/uri-list"
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
      const merged = `${uriList}
${plainText}`.trim();
      if (!merged) {
        return;
      }
      const lines = merged.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const references = [];
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
        new import_obsidian.Notice("Dropped item did not contain a supported Obsidian note link.");
        return;
      }
      const prefix = this.inputEl.value.trim() ? "\n" : "";
      this.inputEl.value = `${this.inputEl.value}${prefix}${references.join("\n")}`;
      this.inputEl.focus();
      new import_obsidian.Notice(`Added ${references.length} note reference(s) from drop.`);
    });
    this.inputEl.focus();
  }
  async switchMode(mode, notePath = "") {
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
  pinLastMessage() {
    const last = [...this.messages].reverse().find((msg) => msg.role === "user" || msg.role === "assistant");
    if (!last) {
      new import_obsidian.Notice("No message to pin yet.");
      return;
    }
    this.pinnedMessages.push({ role: last.role, content: last.content });
    new import_obsidian.Notice("Pinned last message for memory.");
    this.render();
  }
  getHistoryForModel(historyBeforeTurn) {
    const keepCount = Math.max(2, this.keepTurns) * 2;
    if (!this.summarizeOldTurns || historyBeforeTurn.length <= keepCount) {
      return [...this.pinnedMessages, ...historyBeforeTurn.slice(-keepCount)];
    }
    return [...this.pinnedMessages, ...historyBeforeTurn.slice(-keepCount)];
  }
  async maybeSummarizeHistory(historyBeforeTurn) {
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
    this.conversationSummary = this.conversationSummary ? `${this.conversationSummary}
- ${summary}` : summary;
  }
  renderCitationLinks(parent, answer, chunks) {
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
  renderReferencedFiles(parent, answer, chunks) {
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
  renderPendingActions(parent) {
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
        new import_obsidian.Notice(summary);
        this.addMessage("assistant", "Actions applied.", summary);
      } catch (error) {
        approveButton.disabled = false;
        discardButton.disabled = false;
        new import_obsidian.Notice(`Failed to apply actions: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    discardButton.addEventListener("click", () => {
      this.pendingActions = [];
      new import_obsidian.Notice("Pending actions discarded.");
      panel.remove();
    });
  }
  replaceCitationMarkersWithWikiLinks(text, chunks) {
    return text.replace(/\[(\d+)\]/g, (full, numText) => {
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
  prepareActionsWithCitationLinks(actions, chunks) {
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
        const updatedVars = {};
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
  describeAction(action) {
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
      return `replace_in_file: ${action.path} find "${action.find}"`;
    }
    return `create_from_template: ${action.template} -> ${action.path}`;
  }
  async handleSlashCommand(commandText) {
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
            new import_obsidian.Notice("Open a markdown note first.");
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
          this.pinnedMessages.length ? this.pinnedMessages.map((msg, idx) => `${idx + 1}. ${msg.role}: ${msg.content}`).join("\n") : "No pinned messages."
        );
        return true;
      default:
        this.addMessage("assistant", `Unknown command: /${command}. Use /help.`);
        return true;
    }
  }
  handleFind(query) {
    const q = query.toLowerCase();
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.toLowerCase().includes(q)).slice(0, 20);
    if (!files.length) {
      this.addMessage("assistant", `No notes found for: ${query}`);
      return;
    }
    this.addMessage("assistant", files.map((file) => `- ${file.path}`).join("\n"));
  }
  async handleTag(tag) {
    const files = this.app.vault.getMarkdownFiles();
    const matches = [];
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
  async handleOpen(query) {
    const q = query.toLowerCase();
    const file = this.app.vault.getMarkdownFiles().find((candidate) => candidate.path.toLowerCase().includes(q));
    if (!file) {
      this.addMessage("assistant", `No matching note to open for: ${query}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
    this.addMessage("assistant", `Opened: ${file.path}`);
  }
  addMessage(role, text, metaText, referencedFiles = [], thinkingText) {
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
  async sendMessage() {
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
        new import_obsidian.Notice("Open a markdown note first.");
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
        content: `Conversation summary memory:
${this.conversationSummary}`
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
    const setThinkingExpanded = (expanded, streaming) => {
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
        const sourceMeta = result.chunks.length > 0 ? `Sources from this note: ${result.chunks.length}` : "No matching chunks found in this note.";
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
        const metaParts = [];
        metaParts.push(
          result.chunks.length > 0 ? `Vault sources used: ${result.chunks.length}` : "No matching vault chunks found."
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
      new import_obsidian.Notice(`Chat failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sendButtonEl.disabled = false;
      this.saveButtonEl.disabled = false;
      this.inputEl.focus();
    }
  }
  async saveChat() {
    try {
      const title = this.mode === "note" ? "Sidebar Note Chat" : "Sidebar Vault Agent Chat";
      const file = await this.plugin.saveChatAsNote(title, this.messages);
      new import_obsidian.Notice(`Chat saved: ${file.path}`);
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (error) {
      new import_obsidian.Notice(`Failed to save chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  normalizeAssistantMarkdown(text, chunks = []) {
    const vaultName = this.app.vault.getName();
    let output = text;
    const style = this.plugin.settings.citationStyle;
    output = output.replace(/\[(\d+)\s*†[^\]]*\]/g, "[$1]");
    const citationUri = (numText) => {
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
      output = output.replace(
        /\*\*([^*\n][^*\n]{0,120}?)\*\*\s*\[(\d+)\]/g,
        (full, phrase, numText) => {
          const uri = citationUri(numText);
          if (!uri) {
            return full;
          }
          return `**[${phrase.trim()}](${uri})**`;
        }
      );
      output = output.replace(
        /(^|[\s(>\-•])([A-Za-z][A-Za-z0-9'’\-]{1,30}(?:\s+[A-Za-z0-9'’\-]{1,30}){0,5})\s*\[(\d+)\]/gm,
        (full, prefix, phrase, numText) => {
          const uri = citationUri(numText);
          if (!uri) {
            return full;
          }
          return `${prefix}[${phrase.trim()}](${uri})`;
        }
      );
      output = output.replace(/\[(\d+)\]/g, (full, numText) => {
        const uri = citationUri(numText);
        if (!uri) {
          return full;
        }
        return `[source ${numText}](${uri})`;
      });
      return output;
    }
    if (style === "source") {
      output = output.replace(/\[(\d+)\]/g, (full, numText) => {
        const uri = citationUri(numText);
        if (!uri) {
          return full;
        }
        return `[source ${numText}](${uri})`;
      });
      return output;
    }
    output = output.replace(/\[(\d+)\]/g, "");
    output = output.replace(/\s{2,}/g, " ");
    output = output.replace(/\s+([.,;:!?])/g, "$1");
    return output;
  }
  async renderAssistantMarkdown(target, text, chunks = []) {
    target.empty();
    const markdown = this.normalizeAssistantMarkdown(text, chunks);
    await import_obsidian.MarkdownRenderer.renderMarkdown(markdown, target, this.notePath || "", this);
  }
};
var AskQuestionModal = class extends import_obsidian.Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
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
        new import_obsidian.Notice(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        button.disabled = false;
      }
    });
    input.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ModelSearchModal = class extends import_obsidian.Modal {
  constructor(app, plugin, onSelectModel) {
    super(app);
    this.models = [];
    this.query = "";
    this.plugin = plugin;
    this.onSelectModel = onSelectModel;
  }
  onOpen() {
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
  onClose() {
    this.contentEl.empty();
  }
  async loadModels(forceRefresh) {
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
  renderModelList() {
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
          new import_obsidian.Notice(`Selected model: ${model.id}`);
          this.close();
        } catch (error) {
          console.error("Failed to set model", error);
          new import_obsidian.Notice(`Failed to set model: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  }
};
var RagOpenRouterSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "RAG OpenRouter Notes Settings" });
    new import_obsidian.Setting(containerEl).setName("OpenRouter API key").setDesc("Used to call OpenRouter chat completion API.").addText(
      (text) => text.setPlaceholder("sk-or-v1-...").setValue(this.plugin.settings.openRouterApiKey).onChange(async (value) => {
        this.plugin.settings.openRouterApiKey = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Model").setDesc("OpenRouter model slug, for example openai/gpt-4o-mini.").addText(
      (text) => text.setPlaceholder("openai/gpt-4o-mini").setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
        await this.plugin.saveSettings();
      })
    ).addButton(
      (button) => button.setButtonText("Search").onClick(() => {
        new ModelSearchModal(this.app, this.plugin, async (modelId) => {
          this.plugin.settings.model = modelId;
          await this.plugin.saveSettings();
          this.display();
        }).open();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Max retrieved chunks").setDesc("Number of note chunks sent as context.").addSlider(
      (slider) => slider.setLimits(1, 12, 1).setValue(this.plugin.settings.maxChunks).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.maxChunks = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Chunk size").setDesc("Approximate number of characters per indexed chunk.").addSlider(
      (slider) => slider.setLimits(300, 2e3, 50).setValue(this.plugin.settings.chunkSize).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.chunkSize = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Answer folder").setDesc("Folder where generated answer notes are stored.").addText(
      (text) => text.setPlaceholder("RAG Answers").setValue(this.plugin.settings.answerFolder).onChange(async (value) => {
        this.plugin.settings.answerFolder = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Citation style").setDesc("How citations appear in assistant answers.").addDropdown(
      (dropdown) => dropdown.addOption("phrase", "Phrase links").addOption("source", "Source links").addOption("footer", "Footer only").setValue(this.plugin.settings.citationStyle).onChange(async (value) => {
        this.plugin.settings.citationStyle = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Thinking view").setDesc("How model thinking is displayed in chat answers.").addDropdown(
      (dropdown) => dropdown.addOption("collapsed", "Collapsed").addOption("expanded", "Expanded").addOption("hidden", "Hidden").setValue(this.plugin.settings.thinkingView).onChange(async (value) => {
        this.plugin.settings.thinkingView = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Re-index notes").setDesc("Run indexing after changing chunk settings or note content.").addButton(
      (button) => button.setButtonText("Rebuild index").onClick(async () => {
        await this.plugin.rebuildIndex();
      })
    );
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHtcclxuICBBcHAsXHJcbiAgSXRlbVZpZXcsXHJcbiAgTWFya2Rvd25SZW5kZXJlcixcclxuICBNb2RhbCxcclxuICBOb3RpY2UsXHJcbiAgbm9ybWFsaXplUGF0aCxcclxuICBQbHVnaW4sXHJcbiAgUGx1Z2luU2V0dGluZ1RhYixcclxuICBTZXR0aW5nLFxyXG4gIFRGaWxlLFxyXG4gIFdvcmtzcGFjZUxlYWYsXHJcbiAgcmVxdWVzdFVybFxyXG59IGZyb20gXCJvYnNpZGlhblwiO1xyXG5cclxuaW50ZXJmYWNlIFJhZ09wZW5Sb3V0ZXJTZXR0aW5ncyB7XHJcbiAgb3BlblJvdXRlckFwaUtleTogc3RyaW5nO1xyXG4gIG1vZGVsOiBzdHJpbmc7XHJcbiAgbWF4Q2h1bmtzOiBudW1iZXI7XHJcbiAgY2h1bmtTaXplOiBudW1iZXI7XHJcbiAgYW5zd2VyRm9sZGVyOiBzdHJpbmc7XHJcbiAgY2l0YXRpb25TdHlsZTogXCJwaHJhc2VcIiB8IFwic291cmNlXCIgfCBcImZvb3RlclwiO1xyXG4gIHRoaW5raW5nVmlldzogXCJjb2xsYXBzZWRcIiB8IFwiZXhwYW5kZWRcIiB8IFwiaGlkZGVuXCI7XHJcbn1cclxuXHJcbmludGVyZmFjZSBOb3RlQ2h1bmsge1xyXG4gIGZpbGVQYXRoOiBzdHJpbmc7XHJcbiAgY2h1bmtUZXh0OiBzdHJpbmc7XHJcbiAgdG9rZW5zOiBzdHJpbmdbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIE9wZW5Sb3V0ZXJNb2RlbCB7XHJcbiAgaWQ6IHN0cmluZztcclxuICBuYW1lPzogc3RyaW5nO1xyXG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xyXG4gIGNvbnRleHRMZW5ndGg/OiBudW1iZXI7XHJcbn1cclxuXHJcbmludGVyZmFjZSBDaGF0TWVzc2FnZSB7XHJcbiAgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiO1xyXG4gIGNvbnRlbnQ6IHN0cmluZztcclxufVxyXG5cclxuaW50ZXJmYWNlIFN0cmVhbUhhbmRsZXJzIHtcclxuICBvbkFuc3dlckRlbHRhPzogKGRlbHRhOiBzdHJpbmcpID0+IHZvaWQ7XHJcbiAgb25UaGlua2luZ0RlbHRhPzogKGRlbHRhOiBzdHJpbmcpID0+IHZvaWQ7XHJcbn1cclxuXHJcbnR5cGUgQWdlbnRBY3Rpb24gPVxyXG4gIHwge1xyXG4gICAgICB0eXBlOiBcImNyZWF0ZV9mb2xkZXJcIjtcclxuICAgICAgcGF0aDogc3RyaW5nO1xyXG4gICAgfVxyXG4gIHwge1xyXG4gICAgICB0eXBlOiBcImNyZWF0ZV9maWxlXCI7XHJcbiAgICAgIHBhdGg6IHN0cmluZztcclxuICAgICAgY29udGVudDogc3RyaW5nO1xyXG4gICAgICBvdmVyd3JpdGU/OiBib29sZWFuO1xyXG4gICAgfVxyXG4gIHwge1xyXG4gICAgICB0eXBlOiBcImFwcGVuZF9maWxlXCI7XHJcbiAgICAgIHBhdGg6IHN0cmluZztcclxuICAgICAgY29udGVudDogc3RyaW5nO1xyXG4gICAgfVxyXG4gIHwge1xyXG4gICAgICB0eXBlOiBcImluc2VydF9hZnRlcl9oZWFkaW5nXCI7XHJcbiAgICAgIHBhdGg6IHN0cmluZztcclxuICAgICAgaGVhZGluZzogc3RyaW5nO1xyXG4gICAgICBjb250ZW50OiBzdHJpbmc7XHJcbiAgICAgIGNyZWF0ZUlmTWlzc2luZz86IGJvb2xlYW47XHJcbiAgICB9XHJcbiAgfCB7XHJcbiAgICAgIHR5cGU6IFwicmVwbGFjZV9pbl9maWxlXCI7XHJcbiAgICAgIHBhdGg6IHN0cmluZztcclxuICAgICAgZmluZDogc3RyaW5nO1xyXG4gICAgICByZXBsYWNlOiBzdHJpbmc7XHJcbiAgICAgIHJlcGxhY2VBbGw/OiBib29sZWFuO1xyXG4gICAgfVxyXG4gIHwge1xyXG4gICAgICB0eXBlOiBcImNyZWF0ZV9mcm9tX3RlbXBsYXRlXCI7XHJcbiAgICAgIHBhdGg6IHN0cmluZztcclxuICAgICAgdGVtcGxhdGU6IHN0cmluZztcclxuICAgICAgdmFyaWFibGVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgICAgb3ZlcndyaXRlPzogYm9vbGVhbjtcclxuICAgIH07XHJcblxyXG5pbnRlcmZhY2UgQ2l0YXRpb25MaW5rIHtcclxuICBudW1iZXI6IG51bWJlcjtcclxuICBmaWxlOiBURmlsZTtcclxufVxyXG5cclxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogUmFnT3BlblJvdXRlclNldHRpbmdzID0ge1xyXG4gIG9wZW5Sb3V0ZXJBcGlLZXk6IFwiXCIsXHJcbiAgbW9kZWw6IFwib3BlbmFpL2dwdC00by1taW5pXCIsXHJcbiAgbWF4Q2h1bmtzOiA2LFxyXG4gIGNodW5rU2l6ZTogNzAwLFxyXG4gIGFuc3dlckZvbGRlcjogXCJSQUcgQW5zd2Vyc1wiLFxyXG4gIGNpdGF0aW9uU3R5bGU6IFwicGhyYXNlXCIsXHJcbiAgdGhpbmtpbmdWaWV3OiBcImNvbGxhcHNlZFwiXHJcbn07XHJcblxyXG5jb25zdCBSQUdfQ0hBVF9WSUVXX1RZUEUgPSBcInJhZy1vcGVucm91dGVyLWNoYXQtc2lkZWJhclwiO1xyXG5cclxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUmFnT3BlblJvdXRlclBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XHJcbiAgc2V0dGluZ3M6IFJhZ09wZW5Sb3V0ZXJTZXR0aW5ncztcclxuICBub3RlSW5kZXg6IE5vdGVDaHVua1tdID0gW107XHJcbiAgcHJpdmF0ZSBtb2RlbENhY2hlOiBPcGVuUm91dGVyTW9kZWxbXSA9IFtdO1xyXG4gIHByaXZhdGUgbW9kZWxDYWNoZVVwZGF0ZWRBdCA9IDA7XHJcblxyXG4gIGFzeW5jIG9ubG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGF3YWl0IHRoaXMubG9hZFNldHRpbmdzKCk7XHJcblxyXG4gICAgdGhpcy5yZWdpc3RlclZpZXcoXHJcbiAgICAgIFJBR19DSEFUX1ZJRVdfVFlQRSxcclxuICAgICAgKGxlYWYpID0+IG5ldyBSYWdDaGF0U2lkZWJhclZpZXcobGVhZiwgdGhpcylcclxuICAgICk7XHJcblxyXG4gICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBSYWdPcGVuUm91dGVyU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xyXG5cclxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XHJcbiAgICAgIGlkOiBcInJhZy1vcGVucm91dGVyLWluZGV4LW5vdGVzXCIsXHJcbiAgICAgIG5hbWU6IFwiSW5kZXggVmF1bHQgTm90ZXNcIixcclxuICAgICAgY2FsbGJhY2s6IGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCB0aGlzLnJlYnVpbGRJbmRleCgpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLmFkZENvbW1hbmQoe1xyXG4gICAgICBpZDogXCJyYWctb3BlbnJvdXRlci1hc2stcXVlc3Rpb25cIixcclxuICAgICAgbmFtZTogXCJBc2sgUXVlc3Rpb24gV2l0aCBWYXVsdCBDb250ZXh0XCIsXHJcbiAgICAgIGNhbGxiYWNrOiAoKSA9PiB7XHJcbiAgICAgICAgbmV3IEFza1F1ZXN0aW9uTW9kYWwodGhpcy5hcHAsIGFzeW5jIChxdWVzdGlvbikgPT4ge1xyXG4gICAgICAgICAgYXdhaXQgdGhpcy5oYW5kbGVRdWVzdGlvbihxdWVzdGlvbik7XHJcbiAgICAgICAgfSkub3BlbigpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLmFkZENvbW1hbmQoe1xyXG4gICAgICBpZDogXCJyYWctb3BlbnJvdXRlci1jaGF0LWN1cnJlbnQtbm90ZVwiLFxyXG4gICAgICBuYW1lOiBcIkNoYXQgV2l0aCBDdXJyZW50IE5vdGVcIixcclxuICAgICAgY2FsbGJhY2s6IGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcclxuICAgICAgICBpZiAoIWFjdGl2ZUZpbGUgfHwgYWN0aXZlRmlsZS5leHRlbnNpb24gIT09IFwibWRcIikge1xyXG4gICAgICAgICAgbmV3IE5vdGljZShcIk9wZW4gYSBtYXJrZG93biBub3RlIGZpcnN0LlwiKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGF3YWl0IHRoaXMub3BlbkNoYXRTaWRlYmFyKFwibm90ZVwiLCBhY3RpdmVGaWxlLnBhdGgpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLmFkZENvbW1hbmQoe1xyXG4gICAgICBpZDogXCJyYWctb3BlbnJvdXRlci1hZ2VudC1jaGF0LXZhdWx0XCIsXHJcbiAgICAgIG5hbWU6IFwiQWdlbnQgQ2hhdCBXaXRoIFZhdWx0XCIsXHJcbiAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQgdGhpcy5vcGVuQ2hhdFNpZGViYXIoXCJ2YXVsdFwiKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgYXdhaXQgdGhpcy5yZWJ1aWxkSW5kZXgoKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGxvYWRTZXR0aW5ncygpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xyXG4gICAgdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5ID0gdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKTtcclxuICAgIHRoaXMuc2V0dGluZ3MubW9kZWwgPSB0aGlzLnNldHRpbmdzLm1vZGVsLnRyaW0oKSB8fCBERUZBVUxUX1NFVFRJTkdTLm1vZGVsO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgc2F2ZVNldHRpbmdzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcclxuICB9XHJcblxyXG4gIG9udW5sb2FkKCk6IHZvaWQge1xyXG4gICAgdGhpcy5ub3RlSW5kZXggPSBbXTtcclxuICAgIHRoaXMuYXBwLndvcmtzcGFjZVxyXG4gICAgICAuZ2V0TGVhdmVzT2ZUeXBlKFJBR19DSEFUX1ZJRVdfVFlQRSlcclxuICAgICAgLmZvckVhY2goKGxlYWYpID0+IGxlYWYuZGV0YWNoKCkpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhc3luYyBvcGVuQ2hhdFNpZGViYXIobW9kZTogXCJ2YXVsdFwiIHwgXCJub3RlXCIsIG5vdGVQYXRoPzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmdldFJpZ2h0TGVhZihmYWxzZSkgPz8gdGhpcy5hcHAud29ya3NwYWNlLmdldFJpZ2h0TGVhZih0cnVlKTtcclxuICAgIGlmICghbGVhZikge1xyXG4gICAgICBuZXcgTm90aWNlKFwiVW5hYmxlIHRvIG9wZW4gY2hhdCBzaWRlYmFyLlwiKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGF3YWl0IGxlYWYuc2V0Vmlld1N0YXRlKHtcclxuICAgICAgdHlwZTogUkFHX0NIQVRfVklFV19UWVBFLFxyXG4gICAgICBhY3RpdmU6IHRydWUsXHJcbiAgICAgIHN0YXRlOiB7XHJcbiAgICAgICAgbW9kZSxcclxuICAgICAgICBub3RlUGF0aDogbm90ZVBhdGggPz8gXCJcIlxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIHRoaXMuYXBwLndvcmtzcGFjZS5yZXZlYWxMZWFmKGxlYWYpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBnZXRBcGlLZXlPclRocm93KCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBrZXkgPSB0aGlzLnNldHRpbmdzLm9wZW5Sb3V0ZXJBcGlLZXkudHJpbSgpO1xyXG4gICAgaWYgKCFrZXkpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU2V0IHlvdXIgT3BlblJvdXRlciBBUEkga2V5IGluIHBsdWdpbiBzZXR0aW5ncyBmaXJzdC5cIik7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGtleTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGdldE9wZW5Sb3V0ZXJNb2RlbHMoZm9yY2VSZWZyZXNoID0gZmFsc2UpOiBQcm9taXNlPE9wZW5Sb3V0ZXJNb2RlbFtdPiB7XHJcbiAgICBjb25zdCBjYWNoZUlzRnJlc2ggPVxyXG4gICAgICB0aGlzLm1vZGVsQ2FjaGUubGVuZ3RoID4gMCAmJiBEYXRlLm5vdygpIC0gdGhpcy5tb2RlbENhY2hlVXBkYXRlZEF0IDwgMTAgKiA2MCAqIDEwMDA7XHJcblxyXG4gICAgaWYgKCFmb3JjZVJlZnJlc2ggJiYgY2FjaGVJc0ZyZXNoKSB7XHJcbiAgICAgIHJldHVybiB0aGlzLm1vZGVsQ2FjaGU7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcclxuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXHJcbiAgICAgIFwiSFRUUC1SZWZlcmVyXCI6IFwiaHR0cHM6Ly9vYnNpZGlhbi5tZFwiLFxyXG4gICAgICBcIlgtVGl0bGVcIjogXCJPYnNpZGlhbiBSQUcgT3BlblJvdXRlciBQbHVnaW5cIlxyXG4gICAgfTtcclxuXHJcbiAgICBpZiAodGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xyXG4gICAgICBoZWFkZXJzLkF1dGhvcml6YXRpb24gPSBgQmVhcmVyICR7dGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKX1gO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdFVybCh7XHJcbiAgICAgIHVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxL21vZGVsc1wiLFxyXG4gICAgICBtZXRob2Q6IFwiR0VUXCIsXHJcbiAgICAgIGhlYWRlcnNcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IG1vZGVsc1JhdyA9IEFycmF5LmlzQXJyYXkocmVzcG9uc2UuanNvbj8uZGF0YSkgPyByZXNwb25zZS5qc29uLmRhdGEgOiBbXTtcclxuICAgIGNvbnN0IG1vZGVscyA9IG1vZGVsc1Jhd1xyXG4gICAgICAubWFwKChpdGVtOiB1bmtub3duKTogT3BlblJvdXRlck1vZGVsIHwgbnVsbCA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtIHx8IHR5cGVvZiBpdGVtICE9PSBcIm9iamVjdFwiKSB7XHJcbiAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IG9iaiA9IGl0ZW0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICAgICAgY29uc3QgaWQgPSB0eXBlb2Ygb2JqLmlkID09PSBcInN0cmluZ1wiID8gb2JqLmlkIDogXCJcIjtcclxuICAgICAgICBpZiAoIWlkKSB7XHJcbiAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICBpZCxcclxuICAgICAgICAgIG5hbWU6IHR5cGVvZiBvYmoubmFtZSA9PT0gXCJzdHJpbmdcIiA/IG9iai5uYW1lIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgZGVzY3JpcHRpb246IHR5cGVvZiBvYmouZGVzY3JpcHRpb24gPT09IFwic3RyaW5nXCIgPyBvYmouZGVzY3JpcHRpb24gOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICBjb250ZXh0TGVuZ3RoOlxyXG4gICAgICAgICAgICB0eXBlb2Ygb2JqLmNvbnRleHRfbGVuZ3RoID09PSBcIm51bWJlclwiID8gb2JqLmNvbnRleHRfbGVuZ3RoIDogdW5kZWZpbmVkXHJcbiAgICAgICAgfSBhcyBPcGVuUm91dGVyTW9kZWw7XHJcbiAgICAgIH0pXHJcbiAgICAgIC5maWx0ZXIoKG1vZGVsOiBPcGVuUm91dGVyTW9kZWwgfCBudWxsKTogbW9kZWwgaXMgT3BlblJvdXRlck1vZGVsID0+IEJvb2xlYW4obW9kZWwpKVxyXG4gICAgICAuc29ydCgoYTogT3BlblJvdXRlck1vZGVsLCBiOiBPcGVuUm91dGVyTW9kZWwpID0+IGEuaWQubG9jYWxlQ29tcGFyZShiLmlkKSk7XHJcblxyXG4gICAgdGhpcy5tb2RlbENhY2hlID0gbW9kZWxzO1xyXG4gICAgdGhpcy5tb2RlbENhY2hlVXBkYXRlZEF0ID0gRGF0ZS5ub3coKTtcclxuICAgIHJldHVybiBtb2RlbHM7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIGhhbmRsZVF1ZXN0aW9uKHF1ZXN0aW9uOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmICghcXVlc3Rpb24udHJpbSgpKSB7XHJcbiAgICAgIG5ldyBOb3RpY2UoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCF0aGlzLnNldHRpbmdzLm9wZW5Sb3V0ZXJBcGlLZXkudHJpbSgpKSB7XHJcbiAgICAgIG5ldyBOb3RpY2UoXCJTZXQgeW91ciBPcGVuUm91dGVyIEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzIGZpcnN0LlwiKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghdGhpcy5ub3RlSW5kZXgubGVuZ3RoKSB7XHJcbiAgICAgIGF3YWl0IHRoaXMucmVidWlsZEluZGV4KCk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgdG9wQ2h1bmtzID0gdGhpcy5yZXRyaWV2ZVJlbGV2YW50Q2h1bmtzKHF1ZXN0aW9uKTtcclxuICAgIGNvbnN0IGFuc3dlciA9IGF3YWl0IHRoaXMucXVlcnlPcGVuUm91dGVyKHF1ZXN0aW9uLCB0b3BDaHVua3MpO1xyXG4gICAgY29uc3QgY3JlYXRlZEZpbGUgPSBhd2FpdCB0aGlzLndyaXRlQW5zd2VyTm90ZShxdWVzdGlvbiwgYW5zd2VyLCB0b3BDaHVua3MpO1xyXG5cclxuICAgIGF3YWl0IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWFmKHRydWUpLm9wZW5GaWxlKGNyZWF0ZWRGaWxlKTtcclxuICAgIG5ldyBOb3RpY2UoYEFuc3dlciBjcmVhdGVkOiAke2NyZWF0ZWRGaWxlLnBhdGh9YCk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHRva2VuaXplKGlucHV0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XHJcbiAgICByZXR1cm4gaW5wdXRcclxuICAgICAgLnRvTG93ZXJDYXNlKClcclxuICAgICAgLnJlcGxhY2UoL1teYS16MC05XFxzXS9nLCBcIiBcIilcclxuICAgICAgLnNwbGl0KC9cXHMrLylcclxuICAgICAgLmZpbHRlcigodCkgPT4gdC5sZW5ndGggPiAyKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgc3BsaXRJbnRvQ2h1bmtzKHRleHQ6IHN0cmluZywgY2h1bmtTaXplOiBudW1iZXIpOiBzdHJpbmdbXSB7XHJcbiAgICBjb25zdCBjaHVua3M6IHN0cmluZ1tdID0gW107XHJcbiAgICBjb25zdCBwYXJhZ3JhcGhzID0gdGV4dFxyXG4gICAgICAuc3BsaXQoL1xcbnsyLH0vKVxyXG4gICAgICAubWFwKChwKSA9PiBwLnRyaW0oKSlcclxuICAgICAgLmZpbHRlcigocCkgPT4gcC5sZW5ndGggPiAwKTtcclxuXHJcbiAgICBsZXQgY3VycmVudCA9IFwiXCI7XHJcblxyXG4gICAgZm9yIChjb25zdCBwYXJhZ3JhcGggb2YgcGFyYWdyYXBocykge1xyXG4gICAgICBpZiAoY3VycmVudC5sZW5ndGggKyBwYXJhZ3JhcGgubGVuZ3RoICsgMiA8PSBjaHVua1NpemUpIHtcclxuICAgICAgICBjdXJyZW50ID0gY3VycmVudCA/IGAke2N1cnJlbnR9XFxuXFxuJHtwYXJhZ3JhcGh9YCA6IHBhcmFncmFwaDtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKGN1cnJlbnQpIHtcclxuICAgICAgICBjaHVua3MucHVzaChjdXJyZW50KTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKHBhcmFncmFwaC5sZW5ndGggPD0gY2h1bmtTaXplKSB7XHJcbiAgICAgICAgY3VycmVudCA9IHBhcmFncmFwaDtcclxuICAgICAgfSBlbHNlIHtcclxuICAgICAgICBjb25zdCBoYXJkU3BsaXQgPSB0aGlzLmhhcmRTcGxpdChwYXJhZ3JhcGgsIGNodW5rU2l6ZSk7XHJcbiAgICAgICAgY2h1bmtzLnB1c2goLi4uaGFyZFNwbGl0LnNsaWNlKDAsIC0xKSk7XHJcbiAgICAgICAgY3VycmVudCA9IGhhcmRTcGxpdFtoYXJkU3BsaXQubGVuZ3RoIC0gMV07XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBpZiAoY3VycmVudCkge1xyXG4gICAgICBjaHVua3MucHVzaChjdXJyZW50KTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gY2h1bmtzO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBoYXJkU3BsaXQodGV4dDogc3RyaW5nLCBjaHVua1NpemU6IG51bWJlcik6IHN0cmluZ1tdIHtcclxuICAgIGNvbnN0IHJlc3VsdDogc3RyaW5nW10gPSBbXTtcclxuICAgIGxldCBzdGFydCA9IDA7XHJcblxyXG4gICAgd2hpbGUgKHN0YXJ0IDwgdGV4dC5sZW5ndGgpIHtcclxuICAgICAgcmVzdWx0LnB1c2godGV4dC5zbGljZShzdGFydCwgc3RhcnQgKyBjaHVua1NpemUpKTtcclxuICAgICAgc3RhcnQgKz0gY2h1bmtTaXplO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbiAgfVxyXG5cclxuICBhc3luYyByZWJ1aWxkSW5kZXgoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBmaWxlcyA9IHRoaXMuYXBwLnZhdWx0LmdldE1hcmtkb3duRmlsZXMoKTtcclxuICAgIGNvbnN0IGNodW5rczogTm90ZUNodW5rW10gPSBbXTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQuY2FjaGVkUmVhZChmaWxlKTtcclxuICAgICAgICBjb25zdCBzcGxpdCA9IHRoaXMuc3BsaXRJbnRvQ2h1bmtzKGNvbnRlbnQsIHRoaXMuc2V0dGluZ3MuY2h1bmtTaXplKTtcclxuXHJcbiAgICAgICAgZm9yIChjb25zdCBjaHVua1RleHQgb2Ygc3BsaXQpIHtcclxuICAgICAgICAgIGNvbnN0IHRva2VucyA9IHRoaXMudG9rZW5pemUoY2h1bmtUZXh0KTtcclxuICAgICAgICAgIGlmICghdG9rZW5zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICBjaHVua3MucHVzaCh7XHJcbiAgICAgICAgICAgIGZpbGVQYXRoOiBmaWxlLnBhdGgsXHJcbiAgICAgICAgICAgIGNodW5rVGV4dCxcclxuICAgICAgICAgICAgdG9rZW5zXHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmFpbGVkIHRvIGluZGV4ICR7ZmlsZS5wYXRofWAsIGVycm9yKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHRoaXMubm90ZUluZGV4ID0gY2h1bmtzO1xyXG4gICAgbmV3IE5vdGljZShgSW5kZXhlZCAke2ZpbGVzLmxlbmd0aH0gbm90ZXMgaW50byAke2NodW5rcy5sZW5ndGh9IGNodW5rcy5gKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgcmV0cmlldmVSZWxldmFudENodW5rcyhxdWVzdGlvbjogc3RyaW5nKTogTm90ZUNodW5rW10ge1xyXG4gICAgY29uc3QgcXVlcnlUb2tlbnMgPSB0aGlzLnRva2VuaXplKHF1ZXN0aW9uKTtcclxuICAgIGlmICghcXVlcnlUb2tlbnMubGVuZ3RoKSB7XHJcbiAgICAgIHJldHVybiBbXTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBzY29yZWQgPSB0aGlzLm5vdGVJbmRleFxyXG4gICAgICAubWFwKChjaHVuaykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRva2VuU2V0ID0gbmV3IFNldChjaHVuay50b2tlbnMpO1xyXG4gICAgICAgIGxldCBzY29yZSA9IDA7XHJcblxyXG4gICAgICAgIGZvciAoY29uc3QgdG9rZW4gb2YgcXVlcnlUb2tlbnMpIHtcclxuICAgICAgICAgIGlmICh0b2tlblNldC5oYXModG9rZW4pKSB7XHJcbiAgICAgICAgICAgIHNjb3JlICs9IDE7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBGYXZvciBkZW5zZXIgbWF0Y2hlcyBieSBub3JtYWxpemluZyBmb3IgY2h1bmsgbGVuZ3RoLlxyXG4gICAgICAgIGNvbnN0IG5vcm1hbGl6ZWRTY29yZSA9IHNjb3JlIC8gTWF0aC5zcXJ0KGNodW5rLnRva2Vucy5sZW5ndGgpO1xyXG4gICAgICAgIHJldHVybiB7IGNodW5rLCBzY29yZTogbm9ybWFsaXplZFNjb3JlIH07XHJcbiAgICAgIH0pXHJcbiAgICAgIC5maWx0ZXIoKHgpID0+IHguc2NvcmUgPiAwKVxyXG4gICAgICAuc29ydCgoYSwgYikgPT4gYi5zY29yZSAtIGEuc2NvcmUpXHJcbiAgICAgIC5zbGljZSgwLCB0aGlzLnNldHRpbmdzLm1heENodW5rcylcclxuICAgICAgLm1hcCgoeCkgPT4geC5jaHVuayk7XHJcblxyXG4gICAgcmV0dXJuIHNjb3JlZDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgcmV0cmlldmVSZWxldmFudENodW5rc0ZvckZpbGUocXVlc3Rpb246IHN0cmluZywgZmlsZVBhdGg6IHN0cmluZyk6IE5vdGVDaHVua1tdIHtcclxuICAgIGNvbnN0IHF1ZXJ5VG9rZW5zID0gdGhpcy50b2tlbml6ZShxdWVzdGlvbik7XHJcbiAgICBpZiAoIXF1ZXJ5VG9rZW5zLmxlbmd0aCkge1xyXG4gICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgc2NvcmVkID0gdGhpcy5ub3RlSW5kZXhcclxuICAgICAgLmZpbHRlcigoY2h1bmspID0+IGNodW5rLmZpbGVQYXRoID09PSBmaWxlUGF0aClcclxuICAgICAgLm1hcCgoY2h1bmspID0+IHtcclxuICAgICAgICBjb25zdCB0b2tlblNldCA9IG5ldyBTZXQoY2h1bmsudG9rZW5zKTtcclxuICAgICAgICBsZXQgc2NvcmUgPSAwO1xyXG5cclxuICAgICAgICBmb3IgKGNvbnN0IHRva2VuIG9mIHF1ZXJ5VG9rZW5zKSB7XHJcbiAgICAgICAgICBpZiAodG9rZW5TZXQuaGFzKHRva2VuKSkge1xyXG4gICAgICAgICAgICBzY29yZSArPSAxO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZFNjb3JlID0gc2NvcmUgLyBNYXRoLnNxcnQoY2h1bmsudG9rZW5zLmxlbmd0aCk7XHJcbiAgICAgICAgcmV0dXJuIHsgY2h1bmssIHNjb3JlOiBub3JtYWxpemVkU2NvcmUgfTtcclxuICAgICAgfSlcclxuICAgICAgLmZpbHRlcigoeCkgPT4geC5zY29yZSA+IDApXHJcbiAgICAgIC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSlcclxuICAgICAgLnNsaWNlKDAsIHRoaXMuc2V0dGluZ3MubWF4Q2h1bmtzKVxyXG4gICAgICAubWFwKCh4KSA9PiB4LmNodW5rKTtcclxuXHJcbiAgICByZXR1cm4gc2NvcmVkO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhc3luYyBxdWVyeU9wZW5Sb3V0ZXJXaXRoTWVzc2FnZXMoXHJcbiAgICBzeXN0ZW1Qcm9tcHQ6IHN0cmluZyxcclxuICAgIG1lc3NhZ2VzOiBDaGF0TWVzc2FnZVtdXHJcbiAgKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICAgIGNvbnN0IGFwaUtleSA9IHRoaXMuZ2V0QXBpS2V5T3JUaHJvdygpO1xyXG5cclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdFVybCh7XHJcbiAgICAgIHVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxL2NoYXQvY29tcGxldGlvbnNcIixcclxuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcclxuICAgICAgaGVhZGVyczoge1xyXG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthcGlLZXl9YCxcclxuICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcclxuICAgICAgICBcIkhUVFAtUmVmZXJlclwiOiBcImh0dHBzOi8vb2JzaWRpYW4ubWRcIixcclxuICAgICAgICBcIlgtVGl0bGVcIjogXCJPYnNpZGlhbiBSQUcgT3BlblJvdXRlciBQbHVnaW5cIlxyXG4gICAgICB9LFxyXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgbW9kZWw6IHRoaXMuc2V0dGluZ3MubW9kZWwsXHJcbiAgICAgICAgbWVzc2FnZXM6IFtcclxuICAgICAgICAgIHsgcm9sZTogXCJzeXN0ZW1cIiwgY29udGVudDogc3lzdGVtUHJvbXB0IH0sXHJcbiAgICAgICAgICAuLi5tZXNzYWdlcy5tYXAoKG1zZykgPT4gKHsgcm9sZTogbXNnLnJvbGUsIGNvbnRlbnQ6IG1zZy5jb250ZW50IH0pKVxyXG4gICAgICAgIF0sXHJcbiAgICAgICAgdGVtcGVyYXR1cmU6IDAuMlxyXG4gICAgICB9KVxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3QgYW5zd2VyID0gcmVzcG9uc2UuanNvbj8uY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50O1xyXG4gICAgaWYgKCFhbnN3ZXIgfHwgdHlwZW9mIGFuc3dlciAhPT0gXCJzdHJpbmdcIikge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJPcGVuUm91dGVyIHJldHVybmVkIGFuIHVuZXhwZWN0ZWQgcmVzcG9uc2UuXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiBhbnN3ZXI7XHJcbiAgfVxyXG5cclxuICBhc3luYyBzdW1tYXJpemVDaGF0TWVzc2FnZXMobWVzc2FnZXM6IENoYXRNZXNzYWdlW10pOiBQcm9taXNlPHN0cmluZz4ge1xyXG4gICAgaWYgKCFtZXNzYWdlcy5sZW5ndGgpIHtcclxuICAgICAgcmV0dXJuIFwiXCI7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgdHJhbnNjcmlwdCA9IG1lc3NhZ2VzXHJcbiAgICAgIC5tYXAoKG1zZykgPT4gYCR7bXNnLnJvbGUgPT09IFwidXNlclwiID8gXCJVc2VyXCIgOiBcIkFzc2lzdGFudFwifTogJHttc2cuY29udGVudH1gKVxyXG4gICAgICAuam9pbihcIlxcblxcblwiKTtcclxuXHJcbiAgICBjb25zdCBzdW1tYXJ5ID0gYXdhaXQgdGhpcy5xdWVyeU9wZW5Sb3V0ZXJXaXRoTWVzc2FnZXMoXHJcbiAgICAgIFwiU3VtbWFyaXplIHRoZSBjb252ZXJzYXRpb24gaW50byBjb21wYWN0IGZhY3R1YWwgbWVtb3J5IGJ1bGxldHMuIEtlZXAgY3JpdGljYWwgY29uc3RyYWludHMgYW5kIGRlY2lzaW9ucy5cIixcclxuICAgICAgW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IHRyYW5zY3JpcHQgfV1cclxuICAgICk7XHJcblxyXG4gICAgcmV0dXJuIHN1bW1hcnkudHJpbSgpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhc3luYyBzdHJlYW1PcGVuUm91dGVyV2l0aE1lc3NhZ2VzKFxyXG4gICAgc3lzdGVtUHJvbXB0OiBzdHJpbmcsXHJcbiAgICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSxcclxuICAgIGhhbmRsZXJzOiBTdHJlYW1IYW5kbGVycyA9IHt9XHJcbiAgKTogUHJvbWlzZTx7IHJhd0Fuc3dlcjogc3RyaW5nOyB0aGlua2luZzogc3RyaW5nIH0+IHtcclxuICAgIGNvbnN0IGFwaUtleSA9IHRoaXMuZ2V0QXBpS2V5T3JUaHJvdygpO1xyXG5cclxuICAgIGNvbnN0IGJvZHkgPSB7XHJcbiAgICAgIG1vZGVsOiB0aGlzLnNldHRpbmdzLm1vZGVsLFxyXG4gICAgICBtZXNzYWdlczogW1xyXG4gICAgICAgIHsgcm9sZTogXCJzeXN0ZW1cIiwgY29udGVudDogc3lzdGVtUHJvbXB0IH0sXHJcbiAgICAgICAgLi4ubWVzc2FnZXMubWFwKChtc2cpID0+ICh7IHJvbGU6IG1zZy5yb2xlLCBjb250ZW50OiBtc2cuY29udGVudCB9KSlcclxuICAgICAgXSxcclxuICAgICAgdGVtcGVyYXR1cmU6IDAuMixcclxuICAgICAgc3RyZWFtOiB0cnVlLFxyXG4gICAgICBpbmNsdWRlX3JlYXNvbmluZzogdHJ1ZVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MS9jaGF0L2NvbXBsZXRpb25zXCIsIHtcclxuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcclxuICAgICAgaGVhZGVyczoge1xyXG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthcGlLZXl9YCxcclxuICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcclxuICAgICAgICBcIkhUVFAtUmVmZXJlclwiOiBcImh0dHBzOi8vb2JzaWRpYW4ubWRcIixcclxuICAgICAgICBcIlgtVGl0bGVcIjogXCJPYnNpZGlhbiBSQUcgT3BlblJvdXRlciBQbHVnaW5cIlxyXG4gICAgICB9LFxyXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KVxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xyXG4gICAgICBsZXQgZGV0YWlscyA9IFwiXCI7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgZGV0YWlscyA9IChhd2FpdCByZXNwb25zZS50ZXh0KCkpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIGRldGFpbHMgPSBcIlwiO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDEpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJPcGVuUm91dGVyIGF1dGhlbnRpY2F0aW9uIGZhaWxlZCAoNDAxKS4gVmVyaWZ5IEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzLlwiKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgIGBPcGVuUm91dGVyIHJlcXVlc3QgZmFpbGVkICgke3Jlc3BvbnNlLnN0YXR1c30ke3Jlc3BvbnNlLnN0YXR1c1RleHQgPyBgICR7cmVzcG9uc2Uuc3RhdHVzVGV4dH1gIDogXCJcIn0pJHtkZXRhaWxzID8gYDogJHtkZXRhaWxzfWAgOiBcIlwifWBcclxuICAgICAgKTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIXJlc3BvbnNlLmJvZHkpIHtcclxuICAgICAgY29uc3QgZmFsbGJhY2tBbnN3ZXIgPSBhd2FpdCB0aGlzLnF1ZXJ5T3BlblJvdXRlcldpdGhNZXNzYWdlcyhzeXN0ZW1Qcm9tcHQsIG1lc3NhZ2VzKTtcclxuICAgICAgaGFuZGxlcnMub25BbnN3ZXJEZWx0YT8uKGZhbGxiYWNrQW5zd2VyKTtcclxuICAgICAgcmV0dXJuIHsgcmF3QW5zd2VyOiBmYWxsYmFja0Fuc3dlciwgdGhpbmtpbmc6IFwiXCIgfTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlcmVkID0gXCJcIjtcclxuICAgIGxldCByYXdBbnN3ZXIgPSBcIlwiO1xyXG4gICAgbGV0IHRoaW5raW5nID0gXCJcIjtcclxuXHJcbiAgICB3aGlsZSAodHJ1ZSkge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkge1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBidWZmZXJlZCArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IGxpbmVzID0gYnVmZmVyZWQuc3BsaXQoXCJcXG5cIik7XHJcbiAgICAgIGJ1ZmZlcmVkID0gbGluZXMucG9wKCkgPz8gXCJcIjtcclxuXHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xyXG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcclxuICAgICAgICBpZiAoIXRyaW1tZWQuc3RhcnRzV2l0aChcImRhdGE6XCIpKSB7XHJcbiAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHBheWxvYWRUZXh0ID0gdHJpbW1lZC5zbGljZSg1KS50cmltKCk7XHJcbiAgICAgICAgaWYgKCFwYXlsb2FkVGV4dCB8fCBwYXlsb2FkVGV4dCA9PT0gXCJbRE9ORV1cIikge1xyXG4gICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgcGF5bG9hZCA9IEpTT04ucGFyc2UocGF5bG9hZFRleHQpIGFzIHtcclxuICAgICAgICAgICAgY2hvaWNlcz86IEFycmF5PHtcclxuICAgICAgICAgICAgICBkZWx0YT86IHtcclxuICAgICAgICAgICAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICByZWFzb25pbmc/OiBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICByZWFzb25pbmdfY29udGVudD86IHN0cmluZztcclxuICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICB9PjtcclxuICAgICAgICAgIH07XHJcblxyXG4gICAgICAgICAgY29uc3QgZGVsdGEgPSBwYXlsb2FkLmNob2ljZXM/LlswXT8uZGVsdGE7XHJcbiAgICAgICAgICBjb25zdCBjb250ZW50RGVsdGEgPSB0eXBlb2YgZGVsdGE/LmNvbnRlbnQgPT09IFwic3RyaW5nXCIgPyBkZWx0YS5jb250ZW50IDogXCJcIjtcclxuICAgICAgICAgIGNvbnN0IHJlYXNvbmluZ0RlbHRhID1cclxuICAgICAgICAgICAgdHlwZW9mIGRlbHRhPy5yZWFzb25pbmcgPT09IFwic3RyaW5nXCJcclxuICAgICAgICAgICAgICA/IGRlbHRhLnJlYXNvbmluZ1xyXG4gICAgICAgICAgICAgIDogdHlwZW9mIGRlbHRhPy5yZWFzb25pbmdfY29udGVudCA9PT0gXCJzdHJpbmdcIlxyXG4gICAgICAgICAgICAgICAgPyBkZWx0YS5yZWFzb25pbmdfY29udGVudFxyXG4gICAgICAgICAgICAgICAgOiBcIlwiO1xyXG5cclxuICAgICAgICAgIGlmIChjb250ZW50RGVsdGEpIHtcclxuICAgICAgICAgICAgcmF3QW5zd2VyICs9IGNvbnRlbnREZWx0YTtcclxuICAgICAgICAgICAgaGFuZGxlcnMub25BbnN3ZXJEZWx0YT8uKGNvbnRlbnREZWx0YSk7XHJcbiAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgaWYgKHJlYXNvbmluZ0RlbHRhKSB7XHJcbiAgICAgICAgICAgIHRoaW5raW5nICs9IHJlYXNvbmluZ0RlbHRhO1xyXG4gICAgICAgICAgICBoYW5kbGVycy5vblRoaW5raW5nRGVsdGE/LihyZWFzb25pbmdEZWx0YSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4geyByYXdBbnN3ZXIsIHRoaW5raW5nIH07XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIHF1ZXJ5T3BlblJvdXRlcihxdWVzdGlvbjogc3RyaW5nLCBjb250ZXh0Q2h1bmtzOiBOb3RlQ2h1bmtbXSk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IGNvbnRleHRDaHVua3NcclxuICAgICAgLm1hcCgoY2h1bmssIGluZGV4KSA9PiB7XHJcbiAgICAgICAgcmV0dXJuIGBTb3VyY2UgJHtpbmRleCArIDF9ICgke2NodW5rLmZpbGVQYXRofSk6XFxuJHtjaHVuay5jaHVua1RleHR9YDtcclxuICAgICAgfSlcclxuICAgICAgLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIik7XHJcblxyXG4gICAgY29uc3Qgc3lzdGVtUHJvbXB0ID1cclxuICAgICAgXCJZb3UgYXJlIGEgbm90ZSBhc3Npc3RhbnQuIEFuc3dlciB0aGUgcXVlc3Rpb24gdXNpbmcgdGhlIHByb3ZpZGVkIG5vdGUgY29udGV4dCB3aGVuIHJlbGV2YW50LiBJZiBjb250ZXh0IGlzIGluc3VmZmljaWVudCwgc2F5IHdoYXQgaXMgbWlzc2luZy5cIjtcclxuXHJcbiAgICBjb25zdCB1c2VyUHJvbXB0ID0gW1xyXG4gICAgICBcIlF1ZXN0aW9uOlwiLFxyXG4gICAgICBxdWVzdGlvbixcclxuICAgICAgXCJcIixcclxuICAgICAgXCJSZXRyaWV2ZWQgTm90ZSBDb250ZXh0OlwiLFxyXG4gICAgICBjb250ZXh0VGV4dCB8fCBcIk5vIGNvbnRleHQgcmV0cmlldmVkLlwiLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBcIlJlcXVpcmVtZW50czpcIixcclxuICAgICAgXCItIEJlIGNvbmNpc2UgYW5kIGZhY3R1YWwuXCIsXHJcbiAgICAgIFwiLSBDaXRlIHNvdXJjZSBudW1iZXJzIGxpa2UgWzFdLCBbMl0gd2hlbiB1c2luZyBjb250ZXh0LlwiLFxyXG4gICAgICBcIi0gSWYgeW91IGFyZSB1bmNlcnRhaW4sIGNsZWFybHkgc2F5IHNvLlwiXHJcbiAgICBdLmpvaW4oXCJcXG5cIik7XHJcblxyXG4gICAgcmV0dXJuIHRoaXMucXVlcnlPcGVuUm91dGVyV2l0aE1lc3NhZ2VzKHN5c3RlbVByb21wdCwgW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IHVzZXJQcm9tcHQgfV0pO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgY2hhdFdpdGhOb3RlKFxyXG4gICAgbm90ZUZpbGVQYXRoOiBzdHJpbmcsXHJcbiAgICBxdWVzdGlvbjogc3RyaW5nLFxyXG4gICAgaGlzdG9yeTogQ2hhdE1lc3NhZ2VbXVxyXG4gICk6IFByb21pc2U8eyBhbnN3ZXI6IHN0cmluZzsgY2h1bmtzOiBOb3RlQ2h1bmtbXSB9PiB7XHJcbiAgICBpZiAoIXF1ZXN0aW9uLnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTZXQgeW91ciBPcGVuUm91dGVyIEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzIGZpcnN0LlwiKTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIXRoaXMubm90ZUluZGV4Lmxlbmd0aCkge1xyXG4gICAgICBhd2FpdCB0aGlzLnJlYnVpbGRJbmRleCgpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHRvcENodW5rcyA9IHRoaXMucmV0cmlldmVSZWxldmFudENodW5rc0ZvckZpbGUocXVlc3Rpb24sIG5vdGVGaWxlUGF0aCk7XHJcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IHRvcENodW5rc1xyXG4gICAgICAubWFwKChjaHVuaywgaW5kZXgpID0+IGBTb3VyY2UgJHtpbmRleCArIDF9ICgke2NodW5rLmZpbGVQYXRofSk6XFxuJHtjaHVuay5jaHVua1RleHR9YClcclxuICAgICAgLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIik7XHJcblxyXG4gICAgY29uc3Qgc3lzdGVtUHJvbXB0ID1cclxuICAgICAgXCJZb3UgYXJlIGEgbm90ZSBhc3Npc3RhbnQuIEtlZXAgcmVzcG9uc2VzIGdyb3VuZGVkIGluIHRoZSBwcm92aWRlZCBub3RlIGNvbnRleHQgYW5kIGNvbnZlcnNhdGlvbiBoaXN0b3J5LiBJZiBjb250ZXh0IGlzIG1pc3NpbmcsIHNheSB3aGF0IGlzIG1pc3NpbmcuXCI7XHJcblxyXG4gICAgY29uc3QgdXNlclByb21wdCA9IFtcclxuICAgICAgYEN1cnJlbnQgbm90ZTogJHtub3RlRmlsZVBhdGh9YCxcclxuICAgICAgXCJcIixcclxuICAgICAgXCJRdWVzdGlvbjpcIixcclxuICAgICAgcXVlc3Rpb24sXHJcbiAgICAgIFwiXCIsXHJcbiAgICAgIFwiUmV0cmlldmVkIE5vdGUgQ29udGV4dDpcIixcclxuICAgICAgY29udGV4dFRleHQgfHwgXCJObyBjb250ZXh0IHJldHJpZXZlZCBmcm9tIHRoaXMgbm90ZS5cIixcclxuICAgICAgXCJcIixcclxuICAgICAgXCJSZXF1aXJlbWVudHM6XCIsXHJcbiAgICAgIFwiLSBCZSBjb25jaXNlIGFuZCBmYWN0dWFsLlwiLFxyXG4gICAgICBcIi0gQ2l0ZSBzb3VyY2UgbnVtYmVycyBsaWtlIFsxXSwgWzJdIHdoZW4gdXNpbmcgY29udGV4dC5cIixcclxuICAgICAgXCItIElmIHVuY2VydGFpbiwgY2xlYXJseSBzYXkgc28uXCJcclxuICAgIF0uam9pbihcIlxcblwiKTtcclxuXHJcbiAgICBjb25zdCBib3VuZGVkSGlzdG9yeSA9IGhpc3Rvcnkuc2xpY2UoLTgpO1xyXG4gICAgY29uc3QgYW5zd2VyID0gYXdhaXQgdGhpcy5xdWVyeU9wZW5Sb3V0ZXJXaXRoTWVzc2FnZXMoc3lzdGVtUHJvbXB0LCBbXHJcbiAgICAgIC4uLmJvdW5kZWRIaXN0b3J5LFxyXG4gICAgICB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiB1c2VyUHJvbXB0IH1cclxuICAgIF0pO1xyXG5cclxuICAgIHJldHVybiB7IGFuc3dlciwgY2h1bmtzOiB0b3BDaHVua3MgfTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHN0cmVhbUNoYXRXaXRoTm90ZShcclxuICAgIG5vdGVGaWxlUGF0aDogc3RyaW5nLFxyXG4gICAgcXVlc3Rpb246IHN0cmluZyxcclxuICAgIGhpc3Rvcnk6IENoYXRNZXNzYWdlW10sXHJcbiAgICBoYW5kbGVyczogU3RyZWFtSGFuZGxlcnMgPSB7fVxyXG4gICk6IFByb21pc2U8eyBhbnN3ZXI6IHN0cmluZzsgY2h1bmtzOiBOb3RlQ2h1bmtbXTsgdGhpbmtpbmc6IHN0cmluZyB9PiB7XHJcbiAgICBpZiAoIXF1ZXN0aW9uLnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTZXQgeW91ciBPcGVuUm91dGVyIEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzIGZpcnN0LlwiKTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIXRoaXMubm90ZUluZGV4Lmxlbmd0aCkge1xyXG4gICAgICBhd2FpdCB0aGlzLnJlYnVpbGRJbmRleCgpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHRvcENodW5rcyA9IHRoaXMucmV0cmlldmVSZWxldmFudENodW5rc0ZvckZpbGUocXVlc3Rpb24sIG5vdGVGaWxlUGF0aCk7XHJcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IHRvcENodW5rc1xyXG4gICAgICAubWFwKChjaHVuaywgaW5kZXgpID0+IGBTb3VyY2UgJHtpbmRleCArIDF9ICgke2NodW5rLmZpbGVQYXRofSk6XFxuJHtjaHVuay5jaHVua1RleHR9YClcclxuICAgICAgLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIik7XHJcblxyXG4gICAgY29uc3Qgc3lzdGVtUHJvbXB0ID1cclxuICAgICAgXCJZb3UgYXJlIGEgbm90ZSBhc3Npc3RhbnQuIEtlZXAgcmVzcG9uc2VzIGdyb3VuZGVkIGluIHRoZSBwcm92aWRlZCBub3RlIGNvbnRleHQgYW5kIGNvbnZlcnNhdGlvbiBoaXN0b3J5LiBJZiBjb250ZXh0IGlzIG1pc3NpbmcsIHNheSB3aGF0IGlzIG1pc3NpbmcuXCI7XHJcblxyXG4gICAgY29uc3QgdXNlclByb21wdCA9IFtcclxuICAgICAgYEN1cnJlbnQgbm90ZTogJHtub3RlRmlsZVBhdGh9YCxcclxuICAgICAgXCJcIixcclxuICAgICAgXCJRdWVzdGlvbjpcIixcclxuICAgICAgcXVlc3Rpb24sXHJcbiAgICAgIFwiXCIsXHJcbiAgICAgIFwiUmV0cmlldmVkIE5vdGUgQ29udGV4dDpcIixcclxuICAgICAgY29udGV4dFRleHQgfHwgXCJObyBjb250ZXh0IHJldHJpZXZlZCBmcm9tIHRoaXMgbm90ZS5cIixcclxuICAgICAgXCJcIixcclxuICAgICAgXCJSZXF1aXJlbWVudHM6XCIsXHJcbiAgICAgIFwiLSBCZSBjb25jaXNlIGFuZCBmYWN0dWFsLlwiLFxyXG4gICAgICBcIi0gQ2l0ZSBzb3VyY2UgbnVtYmVycyBsaWtlIFsxXSwgWzJdIHdoZW4gdXNpbmcgY29udGV4dC5cIixcclxuICAgICAgXCItIElmIHVuY2VydGFpbiwgY2xlYXJseSBzYXkgc28uXCJcclxuICAgIF0uam9pbihcIlxcblwiKTtcclxuXHJcbiAgICBjb25zdCBib3VuZGVkSGlzdG9yeSA9IGhpc3Rvcnkuc2xpY2UoLTgpO1xyXG4gICAgY29uc3Qgc3RyZWFtZWQgPSBhd2FpdCB0aGlzLnN0cmVhbU9wZW5Sb3V0ZXJXaXRoTWVzc2FnZXMoXHJcbiAgICAgIHN5c3RlbVByb21wdCxcclxuICAgICAgWy4uLmJvdW5kZWRIaXN0b3J5LCB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiB1c2VyUHJvbXB0IH1dLFxyXG4gICAgICBoYW5kbGVyc1xyXG4gICAgKTtcclxuXHJcbiAgICByZXR1cm4geyBhbnN3ZXI6IHN0cmVhbWVkLnJhd0Fuc3dlciwgY2h1bmtzOiB0b3BDaHVua3MsIHRoaW5raW5nOiBzdHJlYW1lZC50aGlua2luZyB9O1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgY2hhdFdpdGhWYXVsdChcclxuICAgIHF1ZXN0aW9uOiBzdHJpbmcsXHJcbiAgICBoaXN0b3J5OiBDaGF0TWVzc2FnZVtdXHJcbiAgKTogUHJvbWlzZTx7IGFuc3dlcjogc3RyaW5nOyBjaHVua3M6IE5vdGVDaHVua1tdOyBwZW5kaW5nQWN0aW9uczogQWdlbnRBY3Rpb25bXSB9PiB7XHJcbiAgICBpZiAoIXF1ZXN0aW9uLnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTZXQgeW91ciBPcGVuUm91dGVyIEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzIGZpcnN0LlwiKTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIXRoaXMubm90ZUluZGV4Lmxlbmd0aCkge1xyXG4gICAgICBhd2FpdCB0aGlzLnJlYnVpbGRJbmRleCgpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHRvcENodW5rcyA9IHRoaXMucmV0cmlldmVSZWxldmFudENodW5rcyhxdWVzdGlvbik7XHJcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IHRvcENodW5rc1xyXG4gICAgICAubWFwKChjaHVuaywgaW5kZXgpID0+IGBTb3VyY2UgJHtpbmRleCArIDF9ICgke2NodW5rLmZpbGVQYXRofSk6XFxuJHtjaHVuay5jaHVua1RleHR9YClcclxuICAgICAgLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIik7XHJcblxyXG4gICAgY29uc3Qgc3lzdGVtUHJvbXB0ID0gW1xyXG4gICAgICBcIllvdSBhcmUgYSB2YXVsdCBhc3Npc3RhbnQuIFVzZSBwcm92aWRlZCBub3RlIGNvbnRleHQgYW5kIGNvbnZlcnNhdGlvbiBoaXN0b3J5LlwiLFxyXG4gICAgICBcIllvdSBtYXkgY3JlYXRlIGZvbGRlcnMvZmlsZXMgd2hlbiBleHBsaWNpdGx5IHVzZWZ1bCB0byB0aGUgdXNlcidzIHJlcXVlc3QuXCIsXHJcbiAgICAgIFwiTmV2ZXIgZGVsZXRlIG9yIHJlbmFtZSBmaWxlcy5cIixcclxuICAgICAgXCJXaGVuIHByb3Bvc2luZyBhY3Rpb25zLCBhcHBlbmQgZXhhY3RseSBvbmUgZmVuY2VkIGNvZGUgYmxvY2sgd2l0aCBsYW5ndWFnZSB0YWcgYWdlbnQtYWN0aW9ucyBhbmQgSlNPTiBwYXlsb2FkOlwiLFxyXG4gICAgICBcIntcXFwiYWN0aW9uc1xcXCI6W3tcXFwidHlwZVxcXCI6XFxcImNyZWF0ZV9mb2xkZXJcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiY3JlYXRlX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIixcXFwib3ZlcndyaXRlXFxcIjpmYWxzZX0se1xcXCJ0eXBlXFxcIjpcXFwiYXBwZW5kX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiaW5zZXJ0X2FmdGVyX2hlYWRpbmdcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJoZWFkaW5nXFxcIjpcXFwiIyMgU2VjdGlvblxcXCIsXFxcImNvbnRlbnRcXFwiOlxcXCIuLi5cXFwifSx7XFxcInR5cGVcXFwiOlxcXCJyZXBsYWNlX2luX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJmaW5kXFxcIjpcXFwib2xkXFxcIixcXFwicmVwbGFjZVxcXCI6XFxcIm5ld1xcXCIsXFxcInJlcGxhY2VBbGxcXFwiOmZhbHNlfSx7XFxcInR5cGVcXFwiOlxcXCJjcmVhdGVfZnJvbV90ZW1wbGF0ZVxcXCIsXFxcInBhdGhcXFwiOlxcXCJGb2xkZXIvcGxhbi5tZFxcXCIsXFxcInRlbXBsYXRlXFxcIjpcXFwicHJvamVjdC1wbGFuXFxcIixcXFwidmFyaWFibGVzXFxcIjp7XFxcInRpdGxlXFxcIjpcXFwiUHJvamVjdFxcXCJ9fV19XCIsXHJcbiAgICAgIFwiVGVtcGxhdGUgbmFtZXMgYXZhaWxhYmxlOiBwcm9qZWN0LXBsYW4sIG1lZXRpbmctbm90ZSwgd29ybGQtbG9yZSwgY2hhcmFjdGVyLXNoZWV0LlwiLFxyXG4gICAgICBcIk9ubHkgdXNlIHJlbGF0aXZlIHZhdWx0IHBhdGhzLlwiXHJcbiAgICBdLmpvaW4oXCIgXCIpO1xyXG5cclxuICAgIGNvbnN0IHVzZXJQcm9tcHQgPSBbXHJcbiAgICAgIFwiUXVlc3Rpb246XCIsXHJcbiAgICAgIHF1ZXN0aW9uLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBcIlJldHJpZXZlZCBWYXVsdCBDb250ZXh0OlwiLFxyXG4gICAgICBjb250ZXh0VGV4dCB8fCBcIk5vIGNvbnRleHQgcmV0cmlldmVkLlwiLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBcIlJlcXVpcmVtZW50czpcIixcclxuICAgICAgXCItIEJlIGNvbmNpc2UgYW5kIGZhY3R1YWwuXCIsXHJcbiAgICAgIFwiLSBDaXRlIHNvdXJjZSBudW1iZXJzIGxpa2UgWzFdLCBbMl0gd2hlbiB1c2luZyBjb250ZXh0LlwiLFxyXG4gICAgICBcIi0gSWYgdW5jZXJ0YWluLCBjbGVhcmx5IHNheSBzby5cIlxyXG4gICAgXS5qb2luKFwiXFxuXCIpO1xyXG5cclxuICAgIGNvbnN0IGJvdW5kZWRIaXN0b3J5ID0gaGlzdG9yeS5zbGljZSgtOCk7XHJcbiAgICBjb25zdCByYXdBbnN3ZXIgPSBhd2FpdCB0aGlzLnF1ZXJ5T3BlblJvdXRlcldpdGhNZXNzYWdlcyhzeXN0ZW1Qcm9tcHQsIFtcclxuICAgICAgLi4uYm91bmRlZEhpc3RvcnksXHJcbiAgICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IHVzZXJQcm9tcHQgfVxyXG4gICAgXSk7XHJcblxyXG4gICAgY29uc3QgeyBhbnN3ZXJUZXh0LCBhY3Rpb25zIH0gPSB0aGlzLmV4dHJhY3RBZ2VudEFjdGlvbnMocmF3QW5zd2VyKTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBhbnN3ZXI6IGFuc3dlclRleHQsXHJcbiAgICAgIGNodW5rczogdG9wQ2h1bmtzLFxyXG4gICAgICBwZW5kaW5nQWN0aW9uczogYWN0aW9uc1xyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHN0cmVhbUNoYXRXaXRoVmF1bHQoXHJcbiAgICBxdWVzdGlvbjogc3RyaW5nLFxyXG4gICAgaGlzdG9yeTogQ2hhdE1lc3NhZ2VbXSxcclxuICAgIGhhbmRsZXJzOiBTdHJlYW1IYW5kbGVycyA9IHt9XHJcbiAgKTogUHJvbWlzZTx7IGFuc3dlcjogc3RyaW5nOyBjaHVua3M6IE5vdGVDaHVua1tdOyBwZW5kaW5nQWN0aW9uczogQWdlbnRBY3Rpb25bXTsgdGhpbmtpbmc6IHN0cmluZyB9PiB7XHJcbiAgICBpZiAoIXF1ZXN0aW9uLnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTZXQgeW91ciBPcGVuUm91dGVyIEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzIGZpcnN0LlwiKTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIXRoaXMubm90ZUluZGV4Lmxlbmd0aCkge1xyXG4gICAgICBhd2FpdCB0aGlzLnJlYnVpbGRJbmRleCgpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHRvcENodW5rcyA9IHRoaXMucmV0cmlldmVSZWxldmFudENodW5rcyhxdWVzdGlvbik7XHJcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IHRvcENodW5rc1xyXG4gICAgICAubWFwKChjaHVuaywgaW5kZXgpID0+IGBTb3VyY2UgJHtpbmRleCArIDF9ICgke2NodW5rLmZpbGVQYXRofSk6XFxuJHtjaHVuay5jaHVua1RleHR9YClcclxuICAgICAgLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIik7XHJcblxyXG4gICAgY29uc3Qgc3lzdGVtUHJvbXB0ID0gW1xyXG4gICAgICBcIllvdSBhcmUgYSB2YXVsdCBhc3Npc3RhbnQuIFVzZSBwcm92aWRlZCBub3RlIGNvbnRleHQgYW5kIGNvbnZlcnNhdGlvbiBoaXN0b3J5LlwiLFxyXG4gICAgICBcIllvdSBtYXkgY3JlYXRlIGZvbGRlcnMvZmlsZXMgd2hlbiBleHBsaWNpdGx5IHVzZWZ1bCB0byB0aGUgdXNlcidzIHJlcXVlc3QuXCIsXHJcbiAgICAgIFwiTmV2ZXIgZGVsZXRlIG9yIHJlbmFtZSBmaWxlcy5cIixcclxuICAgICAgXCJXaGVuIHByb3Bvc2luZyBhY3Rpb25zLCBhcHBlbmQgZXhhY3RseSBvbmUgZmVuY2VkIGNvZGUgYmxvY2sgd2l0aCBsYW5ndWFnZSB0YWcgYWdlbnQtYWN0aW9ucyBhbmQgSlNPTiBwYXlsb2FkOlwiLFxyXG4gICAgICBcIntcXFwiYWN0aW9uc1xcXCI6W3tcXFwidHlwZVxcXCI6XFxcImNyZWF0ZV9mb2xkZXJcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiY3JlYXRlX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIixcXFwib3ZlcndyaXRlXFxcIjpmYWxzZX0se1xcXCJ0eXBlXFxcIjpcXFwiYXBwZW5kX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiaW5zZXJ0X2FmdGVyX2hlYWRpbmdcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJoZWFkaW5nXFxcIjpcXFwiIyMgU2VjdGlvblxcXCIsXFxcImNvbnRlbnRcXFwiOlxcXCIuLi5cXFwifSx7XFxcInR5cGVcXFwiOlxcXCJyZXBsYWNlX2luX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJmaW5kXFxcIjpcXFwib2xkXFxcIixcXFwicmVwbGFjZVxcXCI6XFxcIm5ld1xcXCIsXFxcInJlcGxhY2VBbGxcXFwiOmZhbHNlfSx7XFxcInR5cGVcXFwiOlxcXCJjcmVhdGVfZnJvbV90ZW1wbGF0ZVxcXCIsXFxcInBhdGhcXFwiOlxcXCJGb2xkZXIvcGxhbi5tZFxcXCIsXFxcInRlbXBsYXRlXFxcIjpcXFwicHJvamVjdC1wbGFuXFxcIixcXFwidmFyaWFibGVzXFxcIjp7XFxcInRpdGxlXFxcIjpcXFwiUHJvamVjdFxcXCJ9fV19XCIsXHJcbiAgICAgIFwiVGVtcGxhdGUgbmFtZXMgYXZhaWxhYmxlOiBwcm9qZWN0LXBsYW4sIG1lZXRpbmctbm90ZSwgd29ybGQtbG9yZSwgY2hhcmFjdGVyLXNoZWV0LlwiLFxyXG4gICAgICBcIk9ubHkgdXNlIHJlbGF0aXZlIHZhdWx0IHBhdGhzLlwiXHJcbiAgICBdLmpvaW4oXCIgXCIpO1xyXG5cclxuICAgIGNvbnN0IHVzZXJQcm9tcHQgPSBbXHJcbiAgICAgIFwiUXVlc3Rpb246XCIsXHJcbiAgICAgIHF1ZXN0aW9uLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBcIlJldHJpZXZlZCBWYXVsdCBDb250ZXh0OlwiLFxyXG4gICAgICBjb250ZXh0VGV4dCB8fCBcIk5vIGNvbnRleHQgcmV0cmlldmVkLlwiLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBcIlJlcXVpcmVtZW50czpcIixcclxuICAgICAgXCItIEJlIGNvbmNpc2UgYW5kIGZhY3R1YWwuXCIsXHJcbiAgICAgIFwiLSBDaXRlIHNvdXJjZSBudW1iZXJzIGxpa2UgWzFdLCBbMl0gd2hlbiB1c2luZyBjb250ZXh0LlwiLFxyXG4gICAgICBcIi0gSWYgdW5jZXJ0YWluLCBjbGVhcmx5IHNheSBzby5cIlxyXG4gICAgXS5qb2luKFwiXFxuXCIpO1xyXG5cclxuICAgIGNvbnN0IGJvdW5kZWRIaXN0b3J5ID0gaGlzdG9yeS5zbGljZSgtOCk7XHJcbiAgICBjb25zdCBzdHJlYW1lZCA9IGF3YWl0IHRoaXMuc3RyZWFtT3BlblJvdXRlcldpdGhNZXNzYWdlcyhcclxuICAgICAgc3lzdGVtUHJvbXB0LFxyXG4gICAgICBbLi4uYm91bmRlZEhpc3RvcnksIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IHVzZXJQcm9tcHQgfV0sXHJcbiAgICAgIGhhbmRsZXJzXHJcbiAgICApO1xyXG5cclxuICAgIGNvbnN0IHsgYW5zd2VyVGV4dCwgYWN0aW9ucyB9ID0gdGhpcy5leHRyYWN0QWdlbnRBY3Rpb25zKHN0cmVhbWVkLnJhd0Fuc3dlcik7XHJcblxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgYW5zd2VyOiBhbnN3ZXJUZXh0LFxyXG4gICAgICBjaHVua3M6IHRvcENodW5rcyxcclxuICAgICAgcGVuZGluZ0FjdGlvbnM6IGFjdGlvbnMsXHJcbiAgICAgIHRoaW5raW5nOiBzdHJlYW1lZC50aGlua2luZ1xyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgZXh0cmFjdEFnZW50QWN0aW9ucyhyYXdBbnN3ZXI6IHN0cmluZyk6IHsgYW5zd2VyVGV4dDogc3RyaW5nOyBhY3Rpb25zOiBBZ2VudEFjdGlvbltdIH0ge1xyXG4gICAgY29uc3QgY2FuZGlkYXRlczogQXJyYXk8eyBqc29uVGV4dDogc3RyaW5nOyByZW1vdmVUZXh0OiBzdHJpbmcgfT4gPSBbXTtcclxuXHJcbiAgICBjb25zdCBhZ2VudEFjdGlvbkZlbmNlID0gcmF3QW5zd2VyLm1hdGNoKC9gYGBhZ2VudC1hY3Rpb25zXFxzKihbXFxzXFxTXSo/KWBgYC9pKTtcclxuICAgIGlmIChhZ2VudEFjdGlvbkZlbmNlKSB7XHJcbiAgICAgIGNhbmRpZGF0ZXMucHVzaCh7XHJcbiAgICAgICAganNvblRleHQ6IGFnZW50QWN0aW9uRmVuY2VbMV0udHJpbSgpLFxyXG4gICAgICAgIHJlbW92ZVRleHQ6IGFnZW50QWN0aW9uRmVuY2VbMF1cclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QganNvbkZlbmNlID0gcmF3QW5zd2VyLm1hdGNoKC9gYGBqc29uXFxzKihbXFxzXFxTXSo/KWBgYC9pKTtcclxuICAgIGlmIChqc29uRmVuY2UgJiYgL1wiYWN0aW9uc1wiXFxzKjovLnRlc3QoanNvbkZlbmNlWzFdKSkge1xyXG4gICAgICBjYW5kaWRhdGVzLnB1c2goe1xyXG4gICAgICAgIGpzb25UZXh0OiBqc29uRmVuY2VbMV0udHJpbSgpLFxyXG4gICAgICAgIHJlbW92ZVRleHQ6IGpzb25GZW5jZVswXVxyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCByYXdKc29uT2JqZWN0ID0gdGhpcy5leHRyYWN0Rmlyc3RBY3Rpb25zSlNPTk9iamVjdChyYXdBbnN3ZXIpO1xyXG4gICAgaWYgKHJhd0pzb25PYmplY3QpIHtcclxuICAgICAgY2FuZGlkYXRlcy5wdXNoKHtcclxuICAgICAgICBqc29uVGV4dDogcmF3SnNvbk9iamVjdCxcclxuICAgICAgICByZW1vdmVUZXh0OiByYXdKc29uT2JqZWN0XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIGxldCBwYXJzZWRBY3Rpb25zOiBBZ2VudEFjdGlvbltdID0gW107XHJcbiAgICBsZXQgcmVtb3ZlVGV4dCA9IFwiXCI7XHJcblxyXG4gICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xyXG4gICAgICBjb25zdCBtYXliZSA9IHRoaXMucGFyc2VBY3Rpb25zRnJvbUpzb24oY2FuZGlkYXRlLmpzb25UZXh0KTtcclxuICAgICAgaWYgKG1heWJlLmxlbmd0aCkge1xyXG4gICAgICAgIHBhcnNlZEFjdGlvbnMgPSBtYXliZTtcclxuICAgICAgICByZW1vdmVUZXh0ID0gY2FuZGlkYXRlLnJlbW92ZVRleHQ7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBpZiAoIXBhcnNlZEFjdGlvbnMubGVuZ3RoKSB7XHJcbiAgICAgIHJldHVybiB7IGFuc3dlclRleHQ6IHJhd0Fuc3dlci50cmltKCksIGFjdGlvbnM6IFtdIH07XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgc3RyaXBwZWQgPSByZW1vdmVUZXh0ID8gcmF3QW5zd2VyLnJlcGxhY2UocmVtb3ZlVGV4dCwgXCJcIikudHJpbSgpIDogcmF3QW5zd2VyLnRyaW0oKTtcclxuICAgIGNvbnN0IGFuc3dlclRleHQgPSBzdHJpcHBlZCB8fCBcIlBsYW5uZWQgYWN0aW9ucyBhcmUgcmVhZHkuIFJldmlldyBhbmQgYXBwcm92ZSBiZWxvdy5cIjtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBhbnN3ZXJUZXh0LFxyXG4gICAgICBhY3Rpb25zOiBwYXJzZWRBY3Rpb25zXHJcbiAgICB9O1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBwYXJzZUFjdGlvbnNGcm9tSnNvbihqc29uVGV4dDogc3RyaW5nKTogQWdlbnRBY3Rpb25bXSB7XHJcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShqc29uVGV4dCk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgcmV0dXJuIFtdO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghcGFyc2VkIHx8IHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIpIHtcclxuICAgICAgcmV0dXJuIFtdO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1heWJlQWN0aW9ucyA9IChwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmFjdGlvbnM7XHJcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkobWF5YmVBY3Rpb25zKSkge1xyXG4gICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgYWN0aW9uczogQWdlbnRBY3Rpb25bXSA9IFtdO1xyXG5cclxuICAgIGZvciAoY29uc3QgYWN0aW9uIG9mIG1heWJlQWN0aW9ucykge1xyXG4gICAgICBpZiAoIWFjdGlvbiB8fCB0eXBlb2YgYWN0aW9uICE9PSBcIm9iamVjdFwiKSB7XHJcbiAgICAgICAgY29udGludWU7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnN0IG9iaiA9IGFjdGlvbiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgICAgY29uc3QgdHlwZSA9IHR5cGVvZiBvYmoudHlwZSA9PT0gXCJzdHJpbmdcIiA/IG9iai50eXBlIDogXCJcIjtcclxuICAgICAgY29uc3QgcGF0aCA9IHR5cGVvZiBvYmoucGF0aCA9PT0gXCJzdHJpbmdcIiA/IG9iai5wYXRoIDogXCJcIjtcclxuXHJcbiAgICAgIGlmICh0eXBlID09PSBcImNyZWF0ZV9mb2xkZXJcIiAmJiBwYXRoKSB7XHJcbiAgICAgICAgYWN0aW9ucy5wdXNoKHsgdHlwZTogXCJjcmVhdGVfZm9sZGVyXCIsIHBhdGggfSk7XHJcbiAgICAgICAgY29udGludWU7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmICh0eXBlID09PSBcImNyZWF0ZV9maWxlXCIgJiYgcGF0aCAmJiB0eXBlb2Ygb2JqLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHtcclxuICAgICAgICBhY3Rpb25zLnB1c2goe1xyXG4gICAgICAgICAgdHlwZTogXCJjcmVhdGVfZmlsZVwiLFxyXG4gICAgICAgICAgcGF0aCxcclxuICAgICAgICAgIGNvbnRlbnQ6IG9iai5jb250ZW50LFxyXG4gICAgICAgICAgb3ZlcndyaXRlOiB0eXBlb2Ygb2JqLm92ZXJ3cml0ZSA9PT0gXCJib29sZWFuXCIgPyBvYmoub3ZlcndyaXRlIDogdW5kZWZpbmVkXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29udGludWU7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmICh0eXBlID09PSBcImFwcGVuZF9maWxlXCIgJiYgcGF0aCAmJiB0eXBlb2Ygb2JqLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHtcclxuICAgICAgICBhY3Rpb25zLnB1c2goeyB0eXBlOiBcImFwcGVuZF9maWxlXCIsIHBhdGgsIGNvbnRlbnQ6IG9iai5jb250ZW50IH0pO1xyXG4gICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAoXHJcbiAgICAgICAgdHlwZSA9PT0gXCJpbnNlcnRfYWZ0ZXJfaGVhZGluZ1wiICYmXHJcbiAgICAgICAgcGF0aCAmJlxyXG4gICAgICAgIHR5cGVvZiBvYmouaGVhZGluZyA9PT0gXCJzdHJpbmdcIiAmJlxyXG4gICAgICAgIHR5cGVvZiBvYmouY29udGVudCA9PT0gXCJzdHJpbmdcIlxyXG4gICAgICApIHtcclxuICAgICAgICBhY3Rpb25zLnB1c2goe1xyXG4gICAgICAgICAgdHlwZTogXCJpbnNlcnRfYWZ0ZXJfaGVhZGluZ1wiLFxyXG4gICAgICAgICAgcGF0aCxcclxuICAgICAgICAgIGhlYWRpbmc6IG9iai5oZWFkaW5nLFxyXG4gICAgICAgICAgY29udGVudDogb2JqLmNvbnRlbnQsXHJcbiAgICAgICAgICBjcmVhdGVJZk1pc3Npbmc6IHR5cGVvZiBvYmouY3JlYXRlSWZNaXNzaW5nID09PSBcImJvb2xlYW5cIiA/IG9iai5jcmVhdGVJZk1pc3NpbmcgOiB1bmRlZmluZWRcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKFxyXG4gICAgICAgIHR5cGUgPT09IFwicmVwbGFjZV9pbl9maWxlXCIgJiZcclxuICAgICAgICBwYXRoICYmXHJcbiAgICAgICAgdHlwZW9mIG9iai5maW5kID09PSBcInN0cmluZ1wiICYmXHJcbiAgICAgICAgdHlwZW9mIG9iai5yZXBsYWNlID09PSBcInN0cmluZ1wiXHJcbiAgICAgICkge1xyXG4gICAgICAgIGFjdGlvbnMucHVzaCh7XHJcbiAgICAgICAgICB0eXBlOiBcInJlcGxhY2VfaW5fZmlsZVwiLFxyXG4gICAgICAgICAgcGF0aCxcclxuICAgICAgICAgIGZpbmQ6IG9iai5maW5kLFxyXG4gICAgICAgICAgcmVwbGFjZTogb2JqLnJlcGxhY2UsXHJcbiAgICAgICAgICByZXBsYWNlQWxsOiB0eXBlb2Ygb2JqLnJlcGxhY2VBbGwgPT09IFwiYm9vbGVhblwiID8gb2JqLnJlcGxhY2VBbGwgOiB1bmRlZmluZWRcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKHR5cGUgPT09IFwiY3JlYXRlX2Zyb21fdGVtcGxhdGVcIiAmJiBwYXRoICYmIHR5cGVvZiBvYmoudGVtcGxhdGUgPT09IFwic3RyaW5nXCIpIHtcclxuICAgICAgICBjb25zdCB2YXJpYWJsZXNSYXcgPSBvYmoudmFyaWFibGVzO1xyXG4gICAgICAgIGNvbnN0IHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgICAgIGlmICh2YXJpYWJsZXNSYXcgJiYgdHlwZW9mIHZhcmlhYmxlc1JhdyA9PT0gXCJvYmplY3RcIikge1xyXG4gICAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFyaWFibGVzUmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSB7XHJcbiAgICAgICAgICAgICAgdmFyaWFibGVzW2tleV0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgYWN0aW9ucy5wdXNoKHtcclxuICAgICAgICAgIHR5cGU6IFwiY3JlYXRlX2Zyb21fdGVtcGxhdGVcIixcclxuICAgICAgICAgIHBhdGgsXHJcbiAgICAgICAgICB0ZW1wbGF0ZTogb2JqLnRlbXBsYXRlLFxyXG4gICAgICAgICAgdmFyaWFibGVzLFxyXG4gICAgICAgICAgb3ZlcndyaXRlOiB0eXBlb2Ygb2JqLm92ZXJ3cml0ZSA9PT0gXCJib29sZWFuXCIgPyBvYmoub3ZlcndyaXRlIDogdW5kZWZpbmVkXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gYWN0aW9ucztcclxuICB9XHJcblxyXG4gIHByaXZhdGUgZXh0cmFjdEZpcnN0QWN0aW9uc0pTT05PYmplY3QodGV4dDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICBjb25zdCBhY3Rpb25zS2V5SW5kZXggPSB0ZXh0LnNlYXJjaCgvXCJhY3Rpb25zXCJcXHMqOi8pO1xyXG4gICAgaWYgKGFjdGlvbnNLZXlJbmRleCA8IDApIHtcclxuICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgb2JqZWN0U3RhcnQgPSB0ZXh0Lmxhc3RJbmRleE9mKFwie1wiLCBhY3Rpb25zS2V5SW5kZXgpO1xyXG4gICAgaWYgKG9iamVjdFN0YXJ0IDwgMCkge1xyXG4gICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBsZXQgZGVwdGggPSAwO1xyXG4gICAgbGV0IGluU3RyaW5nID0gZmFsc2U7XHJcbiAgICBsZXQgZXNjYXBlZCA9IGZhbHNlO1xyXG5cclxuICAgIGZvciAobGV0IGkgPSBvYmplY3RTdGFydDsgaSA8IHRleHQubGVuZ3RoOyBpICs9IDEpIHtcclxuICAgICAgY29uc3QgY2ggPSB0ZXh0W2ldO1xyXG5cclxuICAgICAgaWYgKGluU3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKGVzY2FwZWQpIHtcclxuICAgICAgICAgIGVzY2FwZWQgPSBmYWxzZTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGNoID09PSBcIlxcXFxcIikge1xyXG4gICAgICAgICAgZXNjYXBlZCA9IHRydWU7XHJcbiAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmIChjaCA9PT0gJ1wiJykge1xyXG4gICAgICAgICAgaW5TdHJpbmcgPSBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29udGludWU7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmIChjaCA9PT0gJ1wiJykge1xyXG4gICAgICAgIGluU3RyaW5nID0gdHJ1ZTtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKGNoID09PSBcIntcIikge1xyXG4gICAgICAgIGRlcHRoICs9IDE7XHJcbiAgICAgICAgY29udGludWU7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmIChjaCA9PT0gXCJ9XCIpIHtcclxuICAgICAgICBkZXB0aCAtPSAxO1xyXG4gICAgICAgIGlmIChkZXB0aCA9PT0gMCkge1xyXG4gICAgICAgICAgcmV0dXJuIHRleHQuc2xpY2Uob2JqZWN0U3RhcnQsIGkgKyAxKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgc2FuaXRpemVWYXVsdFBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICBjb25zdCB0cmltbWVkID0gcGF0aC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCBcIi9cIik7XHJcbiAgICBpZiAoIXRyaW1tZWQpIHtcclxuICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKC9eW2EtekEtWl06Ly50ZXN0KHRyaW1tZWQpIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIi9cIikpIHtcclxuICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgodHJpbW1lZCk7XHJcbiAgICBpZiAoIW5vcm1hbGl6ZWQgfHwgbm9ybWFsaXplZCA9PT0gXCIuXCIpIHtcclxuICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgc2VnbWVudHMgPSBub3JtYWxpemVkLnNwbGl0KFwiL1wiKTtcclxuICAgIGlmIChzZWdtZW50cy5zb21lKChzZWdtZW50KSA9PiAhc2VnbWVudCB8fCBzZWdtZW50ID09PSBcIi4uXCIpKSB7XHJcbiAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiBub3JtYWxpemVkO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhc3luYyBlbnN1cmVGb2xkZXJFeGlzdHMoZm9sZGVyUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIWZvbGRlclBhdGgpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHNlZ21lbnRzID0gZm9sZGVyUGF0aC5zcGxpdChcIi9cIik7XHJcbiAgICBsZXQgY3VycmVudCA9IFwiXCI7XHJcblxyXG4gICAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XHJcbiAgICAgIGN1cnJlbnQgPSBjdXJyZW50ID8gYCR7Y3VycmVudH0vJHtzZWdtZW50fWAgOiBzZWdtZW50O1xyXG4gICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChjdXJyZW50KTtcclxuICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nIGluc3RhbmNlb2YgVEZpbGUpIHtcclxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGNyZWF0ZSBmb2xkZXIgJHtjdXJyZW50fTogYSBmaWxlIGV4aXN0cyBhdCB0aGlzIHBhdGguYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGVGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBhc3luYyBhcHBseUFnZW50QWN0aW9ucyhhY3Rpb25zOiBBZ2VudEFjdGlvbltdKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICAgIGxldCBjcmVhdGVkRm9sZGVycyA9IDA7XHJcbiAgICBsZXQgY3JlYXRlZEZpbGVzID0gMDtcclxuICAgIGxldCB1cGRhdGVkRmlsZXMgPSAwO1xyXG4gICAgbGV0IHNraXBwZWQgPSAwO1xyXG4gICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xyXG5cclxuICAgIGZvciAoY29uc3QgYWN0aW9uIG9mIGFjdGlvbnMpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBzYWZlUGF0aCA9IHRoaXMuc2FuaXRpemVWYXVsdFBhdGgoYWN0aW9uLnBhdGgpO1xyXG4gICAgICAgIGlmICghc2FmZVBhdGgpIHtcclxuICAgICAgICAgIHNraXBwZWQgKz0gMTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcImNyZWF0ZV9mb2xkZXJcIikge1xyXG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoc2FmZVBhdGgpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgIHNraXBwZWQgKz0gMTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVGb2xkZXJFeGlzdHMoc2FmZVBhdGgpO1xyXG4gICAgICAgICAgY3JlYXRlZEZvbGRlcnMgKz0gMTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcImNyZWF0ZV9mcm9tX3RlbXBsYXRlXCIpIHtcclxuICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSB0aGlzLnJlbmRlclRlbXBsYXRlKGFjdGlvbi50ZW1wbGF0ZSwgYWN0aW9uLnZhcmlhYmxlcyA/PyB7fSk7XHJcbiAgICAgICAgICBjb25zdCBmb2xkZXJQYXRoID0gc2FmZVBhdGguaW5jbHVkZXMoXCIvXCIpID8gc2FmZVBhdGguc2xpY2UoMCwgc2FmZVBhdGgubGFzdEluZGV4T2YoXCIvXCIpKSA6IFwiXCI7XHJcbiAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZUZvbGRlckV4aXN0cyhmb2xkZXJQYXRoKTtcclxuXHJcbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RpbmcpIHtcclxuICAgICAgICAgICAgaWYgKCEoZXhpc3RpbmcgaW5zdGFuY2VvZiBURmlsZSkpIHtcclxuICAgICAgICAgICAgICBlcnJvcnMucHVzaChgQ2Fubm90IGNyZWF0ZSBmaWxlICR7c2FmZVBhdGh9OiBhIGZvbGRlciBleGlzdHMgYXQgdGhpcyBwYXRoLmApO1xyXG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoIWFjdGlvbi5vdmVyd3JpdGUpIHtcclxuICAgICAgICAgICAgICBza2lwcGVkICs9IDE7XHJcbiAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeShleGlzdGluZywgY29udGVudCk7XHJcbiAgICAgICAgICAgIHVwZGF0ZWRGaWxlcyArPSAxO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGUoc2FmZVBhdGgsIGNvbnRlbnQpO1xyXG4gICAgICAgICAgY3JlYXRlZEZpbGVzICs9IDE7XHJcbiAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJhcHBlbmRfZmlsZVwiKSB7XHJcbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XHJcbiAgICAgICAgICBpZiAoIShleGlzdGluZyBpbnN0YW5jZW9mIFRGaWxlKSkge1xyXG4gICAgICAgICAgICBlcnJvcnMucHVzaChgQ2Fubm90IGFwcGVuZCB0byAke3NhZmVQYXRofTogZmlsZSBub3QgZm91bmQuYCk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgfVxyXG5cclxuICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5jYWNoZWRSZWFkKGV4aXN0aW5nKTtcclxuICAgICAgICAgIGNvbnN0IHNlcGFyYXRvciA9IGN1cnJlbnQuZW5kc1dpdGgoXCJcXG5cIikgfHwgYWN0aW9uLmNvbnRlbnQuc3RhcnRzV2l0aChcIlxcblwiKSA/IFwiXCIgOiBcIlxcblxcblwiO1xyXG4gICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KGV4aXN0aW5nLCBgJHtjdXJyZW50fSR7c2VwYXJhdG9yfSR7YWN0aW9uLmNvbnRlbnR9YCk7XHJcbiAgICAgICAgICB1cGRhdGVkRmlsZXMgKz0gMTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcImluc2VydF9hZnRlcl9oZWFkaW5nXCIpIHtcclxuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHNhZmVQYXRoKTtcclxuICAgICAgICAgIGlmICghKGV4aXN0aW5nIGluc3RhbmNlb2YgVEZpbGUpKSB7XHJcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKGBDYW5ub3QgaW5zZXJ0IGluICR7c2FmZVBhdGh9OiBmaWxlIG5vdCBmb3VuZC5gKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNhY2hlZFJlYWQoZXhpc3RpbmcpO1xyXG4gICAgICAgICAgY29uc3QgZXNjYXBlZEhlYWRpbmcgPSBhY3Rpb24uaGVhZGluZy5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XHJcbiAgICAgICAgICBjb25zdCBoZWFkaW5nUmVnZXggPSBuZXcgUmVnRXhwKGBeJHtlc2NhcGVkSGVhZGluZ31cXFxccyokYCwgXCJtXCIpO1xyXG4gICAgICAgICAgY29uc3QgaGVhZGluZ01hdGNoID0gaGVhZGluZ1JlZ2V4LmV4ZWMoY3VycmVudCk7XHJcblxyXG4gICAgICAgICAgaWYgKCFoZWFkaW5nTWF0Y2gpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGlvbi5jcmVhdGVJZk1pc3NpbmcpIHtcclxuICAgICAgICAgICAgICBjb25zdCBhcHBlbmRlZCA9IGAke2N1cnJlbnR9JHtjdXJyZW50LmVuZHNXaXRoKFwiXFxuXCIpID8gXCJcIiA6IFwiXFxuXFxuXCJ9JHthY3Rpb24uaGVhZGluZ31cXG4ke2FjdGlvbi5jb250ZW50fWA7XHJcbiAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KGV4aXN0aW5nLCBhcHBlbmRlZCk7XHJcbiAgICAgICAgICAgICAgdXBkYXRlZEZpbGVzICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgc2tpcHBlZCArPSAxO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgfVxyXG5cclxuICAgICAgICAgIGNvbnN0IGluc2VydEluZGV4ID0gaGVhZGluZ01hdGNoLmluZGV4ICsgaGVhZGluZ01hdGNoWzBdLmxlbmd0aDtcclxuICAgICAgICAgIGNvbnN0IHVwZGF0ZWQgPSBgJHtjdXJyZW50LnNsaWNlKDAsIGluc2VydEluZGV4KX1cXG4ke2FjdGlvbi5jb250ZW50fSR7Y3VycmVudC5zbGljZShpbnNlcnRJbmRleCl9YDtcclxuICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeShleGlzdGluZywgdXBkYXRlZCk7XHJcbiAgICAgICAgICB1cGRhdGVkRmlsZXMgKz0gMTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcInJlcGxhY2VfaW5fZmlsZVwiKSB7XHJcbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XHJcbiAgICAgICAgICBpZiAoIShleGlzdGluZyBpbnN0YW5jZW9mIFRGaWxlKSkge1xyXG4gICAgICAgICAgICBlcnJvcnMucHVzaChgQ2Fubm90IHJlcGxhY2UgaW4gJHtzYWZlUGF0aH06IGZpbGUgbm90IGZvdW5kLmApO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQuY2FjaGVkUmVhZChleGlzdGluZyk7XHJcbiAgICAgICAgICBpZiAoIWN1cnJlbnQuaW5jbHVkZXMoYWN0aW9uLmZpbmQpKSB7XHJcbiAgICAgICAgICAgIHNraXBwZWQgKz0gMTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgY29uc3QgdXBkYXRlZCA9IGFjdGlvbi5yZXBsYWNlQWxsXHJcbiAgICAgICAgICAgID8gY3VycmVudC5zcGxpdChhY3Rpb24uZmluZCkuam9pbihhY3Rpb24ucmVwbGFjZSlcclxuICAgICAgICAgICAgOiBjdXJyZW50LnJlcGxhY2UoYWN0aW9uLmZpbmQsIGFjdGlvbi5yZXBsYWNlKTtcclxuICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeShleGlzdGluZywgdXBkYXRlZCk7XHJcbiAgICAgICAgICB1cGRhdGVkRmlsZXMgKz0gMTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgZm9sZGVyUGF0aCA9IHNhZmVQYXRoLmluY2x1ZGVzKFwiL1wiKSA/IHNhZmVQYXRoLnNsaWNlKDAsIHNhZmVQYXRoLmxhc3RJbmRleE9mKFwiL1wiKSkgOiBcIlwiO1xyXG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlRm9sZGVyRXhpc3RzKGZvbGRlclBhdGgpO1xyXG5cclxuICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICBpZiAoIShleGlzdGluZyBpbnN0YW5jZW9mIFRGaWxlKSkge1xyXG4gICAgICAgICAgICBlcnJvcnMucHVzaChgQ2Fubm90IGNyZWF0ZSBmaWxlICR7c2FmZVBhdGh9OiBhIGZvbGRlciBleGlzdHMgYXQgdGhpcyBwYXRoLmApO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICBpZiAoIWFjdGlvbi5vdmVyd3JpdGUpIHtcclxuICAgICAgICAgICAgc2tpcHBlZCArPSAxO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkoZXhpc3RpbmcsIGFjdGlvbi5jb250ZW50KTtcclxuICAgICAgICAgIHVwZGF0ZWRGaWxlcyArPSAxO1xyXG4gICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGUoc2FmZVBhdGgsIGFjdGlvbi5jb250ZW50KTtcclxuICAgICAgICBjcmVhdGVkRmlsZXMgKz0gMTtcclxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBlcnJvcnMucHVzaChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgcGFydHMgPSBbXHJcbiAgICAgIGBBY3Rpb25zIGV4ZWN1dGVkOiBmb2xkZXJzIGNyZWF0ZWQgJHtjcmVhdGVkRm9sZGVyc30sIGZpbGVzIGNyZWF0ZWQgJHtjcmVhdGVkRmlsZXN9LCBmaWxlcyB1cGRhdGVkICR7dXBkYXRlZEZpbGVzfSwgc2tpcHBlZCAke3NraXBwZWR9YFxyXG4gICAgXTtcclxuICAgIGlmIChlcnJvcnMubGVuZ3RoKSB7XHJcbiAgICAgIHBhcnRzLnB1c2goYEVycm9yczogJHtlcnJvcnMuam9pbihcIiB8IFwiKX1gKTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gcGFydHMuam9pbihcIi4gXCIpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSByZW5kZXJUZW1wbGF0ZSh0ZW1wbGF0ZTogc3RyaW5nLCB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBzdHJpbmcge1xyXG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xyXG4gICAgY29uc3QgdGVtcGxhdGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xyXG4gICAgICBcInByb2plY3QtcGxhblwiOiBbXHJcbiAgICAgICAgXCIjIHt7dGl0bGV9fVwiLFxyXG4gICAgICAgIFwiXCIsXHJcbiAgICAgICAgXCJDcmVhdGVkOiB7e2NyZWF0ZWR9fVwiLFxyXG4gICAgICAgIFwiXCIsXHJcbiAgICAgICAgXCIjIyBHb2FsXCIsXHJcbiAgICAgICAgXCJ7e2dvYWx9fVwiLFxyXG4gICAgICAgIFwiXCIsXHJcbiAgICAgICAgXCIjIyBNaWxlc3RvbmVzXCIsXHJcbiAgICAgICAgXCItIHt7bWlsZXN0b25lMX19XCIsXHJcbiAgICAgICAgXCItIHt7bWlsZXN0b25lMn19XCIsXHJcbiAgICAgICAgXCJcIixcclxuICAgICAgICBcIiMjIFJpc2tzXCIsXHJcbiAgICAgICAgXCItIHt7cmlzazF9fVwiXHJcbiAgICAgIF0uam9pbihcIlxcblwiKSxcclxuICAgICAgXCJtZWV0aW5nLW5vdGVcIjogW1xyXG4gICAgICAgIFwiIyBNZWV0aW5nOiB7e3RpdGxlfX1cIixcclxuICAgICAgICBcIlwiLFxyXG4gICAgICAgIFwiRGF0ZToge3tkYXRlfX1cIixcclxuICAgICAgICBcIkF0dGVuZGVlczoge3thdHRlbmRlZXN9fVwiLFxyXG4gICAgICAgIFwiXCIsXHJcbiAgICAgICAgXCIjIyBBZ2VuZGFcIixcclxuICAgICAgICBcIi0gXCIsXHJcbiAgICAgICAgXCJcIixcclxuICAgICAgICBcIiMjIE5vdGVzXCIsXHJcbiAgICAgICAgXCJcIixcclxuICAgICAgICBcIiMjIEFjdGlvbiBJdGVtc1wiLFxyXG4gICAgICAgIFwiLSBbIF0gXCJcclxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxyXG4gICAgICBcIndvcmxkLWxvcmVcIjogW1xyXG4gICAgICAgIFwiIyBMb3JlOiB7e3RpdGxlfX1cIixcclxuICAgICAgICBcIlwiLFxyXG4gICAgICAgIFwiIyMgU3VtbWFyeVwiLFxyXG4gICAgICAgIFwie3tzdW1tYXJ5fX1cIixcclxuICAgICAgICBcIlwiLFxyXG4gICAgICAgIFwiIyMgRmFjdGlvbnNcIixcclxuICAgICAgICBcIi0gXCIsXHJcbiAgICAgICAgXCJcIixcclxuICAgICAgICBcIiMjIFRpbWVsaW5lXCIsXHJcbiAgICAgICAgXCItIFwiXHJcbiAgICAgIF0uam9pbihcIlxcblwiKSxcclxuICAgICAgXCJjaGFyYWN0ZXItc2hlZXRcIjogW1xyXG4gICAgICAgIFwiIyBDaGFyYWN0ZXI6IHt7bmFtZX19XCIsXHJcbiAgICAgICAgXCJcIixcclxuICAgICAgICBcIiMjIFJvbGVcIixcclxuICAgICAgICBcInt7cm9sZX19XCIsXHJcbiAgICAgICAgXCJcIixcclxuICAgICAgICBcIiMjIFRyYWl0c1wiLFxyXG4gICAgICAgIFwiLSBcIixcclxuICAgICAgICBcIlwiLFxyXG4gICAgICAgIFwiIyMgR29hbHNcIixcclxuICAgICAgICBcIi0gXCJcclxuICAgICAgXS5qb2luKFwiXFxuXCIpXHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGRlZmF1bHRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xyXG4gICAgICB0aXRsZTogXCJVbnRpdGxlZFwiLFxyXG4gICAgICBnb2FsOiBcIlwiLFxyXG4gICAgICBtaWxlc3RvbmUxOiBcIlwiLFxyXG4gICAgICBtaWxlc3RvbmUyOiBcIlwiLFxyXG4gICAgICByaXNrMTogXCJcIixcclxuICAgICAgY3JlYXRlZDogbm93LFxyXG4gICAgICBkYXRlOiBub3cuc2xpY2UoMCwgMTApLFxyXG4gICAgICBhdHRlbmRlZXM6IFwiXCIsXHJcbiAgICAgIHN1bW1hcnk6IFwiXCIsXHJcbiAgICAgIG5hbWU6IFwiVW5uYW1lZFwiLFxyXG4gICAgICByb2xlOiBcIlwiXHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHNvdXJjZSA9IHRlbXBsYXRlc1t0ZW1wbGF0ZV0gPz8gdGVtcGxhdGVzW1wicHJvamVjdC1wbGFuXCJdO1xyXG4gICAgcmV0dXJuIHNvdXJjZS5yZXBsYWNlKC97e1xccyooW2EtekEtWjAtOV9dKylcXHMqfX0vZywgKF9mdWxsLCBrZXk6IHN0cmluZykgPT4ge1xyXG4gICAgICByZXR1cm4gdmFyaWFibGVzW2tleV0gPz8gZGVmYXVsdHNba2V5XSA/PyBcIlwiO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIHdyaXRlQW5zd2VyTm90ZShcclxuICAgIHF1ZXN0aW9uOiBzdHJpbmcsXHJcbiAgICBhbnN3ZXI6IHN0cmluZyxcclxuICAgIGNodW5rczogTm90ZUNodW5rW11cclxuICApOiBQcm9taXNlPFRGaWxlPiB7XHJcbiAgICBjb25zdCBmb2xkZXIgPSB0aGlzLnNldHRpbmdzLmFuc3dlckZvbGRlci50cmltKCk7XHJcbiAgICBpZiAoZm9sZGVyICYmICF0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoZm9sZGVyKSkge1xyXG4gICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGVGb2xkZXIoZm9sZGVyKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzouXS9nLCBcIi1cIik7XHJcbiAgICBjb25zdCBiYXNlTmFtZSA9IGBSQUcgQW5zd2VyICR7dGltZXN0YW1wfS5tZGA7XHJcbiAgICBjb25zdCBmaWxlUGF0aCA9IGZvbGRlciA/IGAke2ZvbGRlcn0vJHtiYXNlTmFtZX1gIDogYmFzZU5hbWU7XHJcblxyXG4gICAgY29uc3Qgc291cmNlTGlzdCA9IGNodW5rcy5sZW5ndGhcclxuICAgICAgPyBjaHVua3MubWFwKChjaHVuaywgaWR4KSA9PiBgLSBbJHtpZHggKyAxfV0gJHtjaHVuay5maWxlUGF0aH1gKS5qb2luKFwiXFxuXCIpXHJcbiAgICAgIDogXCItIE5vIHJlbGV2YW50IHNvdXJjZXMgZm91bmQuXCI7XHJcblxyXG4gICAgY29uc3Qgbm90ZSA9IFtcclxuICAgICAgYCMgUkFHIEFuc3dlcmAsXHJcbiAgICAgIFwiXCIsXHJcbiAgICAgIGAjIyBRdWVzdGlvbmAsXHJcbiAgICAgIHF1ZXN0aW9uLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBgIyMgQW5zd2VyYCxcclxuICAgICAgYW5zd2VyLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBgIyMgU291cmNlc2AsXHJcbiAgICAgIHNvdXJjZUxpc3RcclxuICAgIF0uam9pbihcIlxcblwiKTtcclxuXHJcbiAgICByZXR1cm4gdGhpcy5hcHAudmF1bHQuY3JlYXRlKGZpbGVQYXRoLCBub3RlKTtcclxuICB9XHJcblxyXG4gIGdldFJlZmVyZW5jZWRGaWxlcyhhbnN3ZXI6IHN0cmluZywgY2h1bmtzOiBOb3RlQ2h1bmtbXSk6IFRGaWxlW10ge1xyXG4gICAgY29uc3QgcmVmZXJlbmNlZFBhdGhzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcblxyXG4gICAgZm9yIChjb25zdCBjaHVuayBvZiBjaHVua3MpIHtcclxuICAgICAgcmVmZXJlbmNlZFBhdGhzLmFkZChjaHVuay5maWxlUGF0aCk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbWRQYXRoUmVnZXggPSAvKF58W1xccyhcXFtcIiddKSgoPzpbXlxccylcXF1cIiddK1xcLykqW15cXHMpXFxdXCInXStcXC5tZCkoJHxbXFxzKVxcXVwiJy4sOzohP10pL2dpO1xyXG4gICAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xyXG4gICAgd2hpbGUgKChtYXRjaCA9IG1kUGF0aFJlZ2V4LmV4ZWMoYW5zd2VyKSkgIT09IG51bGwpIHtcclxuICAgICAgY29uc3QgY2FuZGlkYXRlID0gbWF0Y2hbMl0ucmVwbGFjZSgvXlxcLysvLCBcIlwiKTtcclxuICAgICAgaWYgKGNhbmRpZGF0ZSkge1xyXG4gICAgICAgIHJlZmVyZW5jZWRQYXRocy5hZGQoY2FuZGlkYXRlKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGZpbGVzOiBURmlsZVtdID0gW107XHJcbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcmVmZXJlbmNlZFBhdGhzKSB7XHJcbiAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XHJcbiAgICAgIGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHtcclxuICAgICAgICBmaWxlcy5wdXNoKGZpbGUpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgZmlsZXMuc29ydCgoYSwgYikgPT4gYS5wYXRoLmxvY2FsZUNvbXBhcmUoYi5wYXRoKSk7XHJcbiAgICByZXR1cm4gZmlsZXM7XHJcbiAgfVxyXG5cclxuICBnZXRDaXRhdGlvbkxpbmtzKGFuc3dlcjogc3RyaW5nLCBjaHVua3M6IE5vdGVDaHVua1tdKTogQ2l0YXRpb25MaW5rW10ge1xyXG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8bnVtYmVyPigpO1xyXG4gICAgY29uc3QgY2l0YXRpb25zOiBDaXRhdGlvbkxpbmtbXSA9IFtdO1xyXG4gICAgY29uc3QgY2l0YXRpb25SZWdleCA9IC9cXFsoXFxkKylcXF0vZztcclxuICAgIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcclxuXHJcbiAgICB3aGlsZSAoKG1hdGNoID0gY2l0YXRpb25SZWdleC5leGVjKGFuc3dlcikpICE9PSBudWxsKSB7XHJcbiAgICAgIGNvbnN0IG51bWJlciA9IE51bWJlci5wYXJzZUludChtYXRjaFsxXSwgMTApO1xyXG4gICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShudW1iZXIpIHx8IG51bWJlciA8IDEgfHwgc2Vlbi5oYXMobnVtYmVyKSkge1xyXG4gICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBjb25zdCBjaHVuayA9IGNodW5rc1tudW1iZXIgLSAxXTtcclxuICAgICAgaWYgKCFjaHVuaykge1xyXG4gICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBjb25zdCBmaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGNodW5rLmZpbGVQYXRoKTtcclxuICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkge1xyXG4gICAgICAgIHNlZW4uYWRkKG51bWJlcik7XHJcbiAgICAgICAgY2l0YXRpb25zLnB1c2goeyBudW1iZXIsIGZpbGUgfSk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gY2l0YXRpb25zO1xyXG4gIH1cclxuXHJcbiAgcmVzb2x2ZU9ic2lkaWFuVXJpVG9QYXRoKHVyaVRleHQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3QgdHJpbW1lZCA9IHVyaVRleHQudHJpbSgpO1xyXG4gICAgaWYgKCF0cmltbWVkLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChcIm9ic2lkaWFuOi8vb3Blbj9cIikpIHtcclxuICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IHBhcnNlZDogVVJMO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gbmV3IFVSTCh0cmltbWVkKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCB2YXVsdE5hbWUgPSBwYXJzZWQuc2VhcmNoUGFyYW1zLmdldChcInZhdWx0XCIpID8/IFwiXCI7XHJcbiAgICBjb25zdCBjdXJyZW50VmF1bHQgPSB0aGlzLmFwcC52YXVsdC5nZXROYW1lKCk7XHJcbiAgICBpZiAodmF1bHROYW1lICYmIHZhdWx0TmFtZSAhPT0gY3VycmVudFZhdWx0KSB7XHJcbiAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGZpbGVQYXJhbSA9IHBhcnNlZC5zZWFyY2hQYXJhbXMuZ2V0KFwiZmlsZVwiKTtcclxuICAgIGlmICghZmlsZVBhcmFtKSB7XHJcbiAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGRlY29kZWQgPSBkZWNvZGVVUklDb21wb25lbnQoZmlsZVBhcmFtKS5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKS50cmltKCk7XHJcbiAgICBjb25zdCBzYWZlID0gdGhpcy5zYW5pdGl6ZVZhdWx0UGF0aChkZWNvZGVkKTtcclxuICAgIHJldHVybiBzYWZlO1xyXG4gIH1cclxuXHJcbiAgcmVzb2x2ZU9ic2lkaWFuVXJpVG9GaWxlKHVyaVRleHQ6IHN0cmluZyk6IFRGaWxlIHwgbnVsbCB7XHJcbiAgICBjb25zdCBzYWZlUGF0aCA9IHRoaXMucmVzb2x2ZU9ic2lkaWFuVXJpVG9QYXRoKHVyaVRleHQpO1xyXG4gICAgaWYgKCFzYWZlUGF0aCkge1xyXG4gICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBmaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHNhZmVQYXRoKTtcclxuICAgIHJldHVybiBmaWxlIGluc3RhbmNlb2YgVEZpbGUgPyBmaWxlIDogbnVsbDtcclxuICB9XHJcblxyXG4gIGFzeW5jIHNhdmVDaGF0QXNOb3RlKGNoYXRUaXRsZTogc3RyaW5nLCBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSk6IFByb21pc2U8VEZpbGU+IHtcclxuICAgIGlmICghbWVzc2FnZXMubGVuZ3RoKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIGNoYXQgbWVzc2FnZXMgdG8gc2F2ZSB5ZXQuXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHJvb3RGb2xkZXIgPSB0aGlzLnNldHRpbmdzLmFuc3dlckZvbGRlci50cmltKCk7XHJcbiAgICBjb25zdCBjaGF0Rm9sZGVyID0gcm9vdEZvbGRlciA/IGAke3Jvb3RGb2xkZXJ9L1JBRyBDaGF0c2AgOiBcIlJBRyBDaGF0c1wiO1xyXG4gICAgYXdhaXQgdGhpcy5lbnN1cmVGb2xkZXJFeGlzdHMoY2hhdEZvbGRlcik7XHJcblxyXG4gICAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpO1xyXG4gICAgY29uc3Qgc2FmZVRpdGxlID0gKGNoYXRUaXRsZSB8fCBcIlZhdWx0IENoYXRcIilcclxuICAgICAgLnJlcGxhY2UoL1tcXFxcLzoqP1wiPD58XS9nLCBcIi1cIilcclxuICAgICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXHJcbiAgICAgIC50cmltKCk7XHJcbiAgICBjb25zdCBmaWxlTmFtZSA9IGAke3NhZmVUaXRsZX0gJHt0aW1lc3RhbXB9Lm1kYDtcclxuICAgIGNvbnN0IGZpbGVQYXRoID0gYCR7Y2hhdEZvbGRlcn0vJHtmaWxlTmFtZX1gO1xyXG5cclxuICAgIGNvbnN0IHRyYW5zY3JpcHQgPSBtZXNzYWdlc1xyXG4gICAgICAubWFwKChtc2csIGluZGV4KSA9PiB7XHJcbiAgICAgICAgY29uc3Qgcm9sZSA9IG1zZy5yb2xlID09PSBcInVzZXJcIiA/IFwiVXNlclwiIDogXCJBc3Npc3RhbnRcIjtcclxuICAgICAgICByZXR1cm4gW2AjIyMgJHtpbmRleCArIDF9LiAke3JvbGV9YCwgXCJcIiwgbXNnLmNvbnRlbnQudHJpbSgpXS5qb2luKFwiXFxuXCIpO1xyXG4gICAgICB9KVxyXG4gICAgICAuam9pbihcIlxcblxcblwiKTtcclxuXHJcbiAgICBjb25zdCBjb250ZW50ID0gW1xyXG4gICAgICBgIyAke3NhZmVUaXRsZX1gLFxyXG4gICAgICBcIlwiLFxyXG4gICAgICBgQ3JlYXRlZDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCxcclxuICAgICAgXCJcIixcclxuICAgICAgXCIjIyBUcmFuc2NyaXB0XCIsXHJcbiAgICAgIFwiXCIsXHJcbiAgICAgIHRyYW5zY3JpcHRcclxuICAgIF0uam9pbihcIlxcblwiKTtcclxuXHJcbiAgICByZXR1cm4gdGhpcy5hcHAudmF1bHQuY3JlYXRlKGZpbGVQYXRoLCBjb250ZW50KTtcclxuICB9XHJcbn1cclxuXHJcbmNsYXNzIFJhZ0NoYXRTaWRlYmFyVmlldyBleHRlbmRzIEl0ZW1WaWV3IHtcclxuICBwcml2YXRlIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbjtcclxuICBwcml2YXRlIG1vZGU6IFwidmF1bHRcIiB8IFwibm90ZVwiID0gXCJ2YXVsdFwiO1xyXG4gIHByaXZhdGUgbm90ZVBhdGggPSBcIlwiO1xyXG4gIHByaXZhdGUgbWVzc2FnZXM6IENoYXRNZXNzYWdlW10gPSBbXTtcclxuICBwcml2YXRlIHBpbm5lZE1lc3NhZ2VzOiBDaGF0TWVzc2FnZVtdID0gW107XHJcbiAgcHJpdmF0ZSBrZWVwVHVybnMgPSA4O1xyXG4gIHByaXZhdGUgc3VtbWFyaXplT2xkVHVybnMgPSB0cnVlO1xyXG4gIHByaXZhdGUgY29udmVyc2F0aW9uU3VtbWFyeSA9IFwiXCI7XHJcbiAgcHJpdmF0ZSBwZW5kaW5nQWN0aW9uczogQWdlbnRBY3Rpb25bXSA9IFtdO1xyXG4gIHByaXZhdGUgdHJhbnNjcmlwdEVsITogSFRNTEVsZW1lbnQ7XHJcbiAgcHJpdmF0ZSBpbnB1dEVsITogSFRNTFRleHRBcmVhRWxlbWVudDtcclxuICBwcml2YXRlIHNlbmRCdXR0b25FbCE6IEhUTUxCdXR0b25FbGVtZW50O1xyXG4gIHByaXZhdGUgc2F2ZUJ1dHRvbkVsITogSFRNTEJ1dHRvbkVsZW1lbnQ7XHJcbiAgcHJpdmF0ZSBpc0RyYWdnaW5nVXJpID0gZmFsc2U7XHJcblxyXG4gIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbikge1xyXG4gICAgc3VwZXIobGVhZik7XHJcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcclxuICB9XHJcblxyXG4gIGdldFZpZXdUeXBlKCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gUkFHX0NIQVRfVklFV19UWVBFO1xyXG4gIH1cclxuXHJcbiAgZ2V0RGlzcGxheVRleHQoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBcIlJBRyBDaGF0XCI7XHJcbiAgfVxyXG5cclxuICBnZXRJY29uKCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gXCJtZXNzYWdlLXNxdWFyZVwiO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgb25PcGVuKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhdGUgPSB0aGlzLmxlYWYuZ2V0Vmlld1N0YXRlKCkuc3RhdGUgYXMgeyBtb2RlPzogXCJ2YXVsdFwiIHwgXCJub3RlXCI7IG5vdGVQYXRoPzogc3RyaW5nIH07XHJcbiAgICB0aGlzLm1vZGUgPSBzdGF0ZT8ubW9kZSA9PT0gXCJub3RlXCIgPyBcIm5vdGVcIiA6IFwidmF1bHRcIjtcclxuICAgIHRoaXMubm90ZVBhdGggPSB0eXBlb2Ygc3RhdGU/Lm5vdGVQYXRoID09PSBcInN0cmluZ1wiID8gc3RhdGUubm90ZVBhdGggOiBcIlwiO1xyXG4gICAgdGhpcy5yZW5kZXIoKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIG9uQ2xvc2UoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0aGlzLmNvbnRlbnRFbC5lbXB0eSgpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSByZW5kZXIoKTogdm9pZCB7XHJcbiAgICBjb25zdCB7IGNvbnRlbnRFbCB9ID0gdGhpcztcclxuICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xyXG4gICAgY29udGVudEVsLmFkZENsYXNzKFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyXCIpO1xyXG5cclxuICAgIGNvbnN0IGhlYWRlciA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLWhlYWRlclwiIH0pO1xyXG4gICAgaGVhZGVyLmNyZWF0ZUVsKFwiaDNcIiwgeyB0ZXh0OiB0aGlzLm1vZGUgPT09IFwidmF1bHRcIiA/IFwiVmF1bHQgQWdlbnQgQ2hhdFwiIDogXCJOb3RlIENoYXRcIiB9KTtcclxuXHJcbiAgICBjb25zdCBtb2RlQWN0aW9ucyA9IGhlYWRlci5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLW1vZGUtYWN0aW9uc1wiIH0pO1xyXG4gICAgY29uc3QgdmF1bHRCdXR0b24gPSBtb2RlQWN0aW9ucy5jcmVhdGVFbChcImJ1dHRvblwiLCB7IHRleHQ6IFwiVmF1bHRcIiB9KTtcclxuICAgIGNvbnN0IG5vdGVCdXR0b24gPSBtb2RlQWN0aW9ucy5jcmVhdGVFbChcImJ1dHRvblwiLCB7IHRleHQ6IFwiQ3VycmVudCBub3RlXCIgfSk7XHJcblxyXG4gICAgaWYgKHRoaXMubW9kZSA9PT0gXCJ2YXVsdFwiKSB7XHJcbiAgICAgIHZhdWx0QnV0dG9uLmFkZENsYXNzKFwibW9kLWN0YVwiKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIG5vdGVCdXR0b24uYWRkQ2xhc3MoXCJtb2QtY3RhXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhdWx0QnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHRoaXMuc3dpdGNoTW9kZShcInZhdWx0XCIpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgbm90ZUJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcclxuICAgICAgaWYgKCFhY3RpdmVGaWxlIHx8IGFjdGl2ZUZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIpIHtcclxuICAgICAgICBuZXcgTm90aWNlKFwiT3BlbiBhIG1hcmtkb3duIG5vdGUgZmlyc3QuXCIpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgYXdhaXQgdGhpcy5zd2l0Y2hNb2RlKFwibm90ZVwiLCBhY3RpdmVGaWxlLnBhdGgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc2NvcGVUZXh0ID1cclxuICAgICAgdGhpcy5tb2RlID09PSBcInZhdWx0XCJcclxuICAgICAgICA/IFwiU2NvcGU6IEVudGlyZSB2YXVsdC5cIlxyXG4gICAgICAgIDogdGhpcy5ub3RlUGF0aFxyXG4gICAgICAgICAgPyBgU2NvcGU6ICR7dGhpcy5ub3RlUGF0aH1gXHJcbiAgICAgICAgICA6IFwiU2NvcGU6IEN1cnJlbnQgbWFya2Rvd24gbm90ZS5cIjtcclxuXHJcbiAgICBjb250ZW50RWwuY3JlYXRlRGl2KHtcclxuICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1ub3RlLXBhdGhcIixcclxuICAgICAgdGV4dDogc2NvcGVUZXh0XHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBtZW1vcnlDb250cm9scyA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLW1lbW9yeS1jb250cm9sc1wiIH0pO1xyXG4gICAgbWVtb3J5Q29udHJvbHMuY3JlYXRlRGl2KHsgdGV4dDogXCJLZWVwIHR1cm5zXCIgfSk7XHJcbiAgICBjb25zdCBrZWVwVHVybnNJbnB1dCA9IG1lbW9yeUNvbnRyb2xzLmNyZWF0ZUVsKFwiaW5wdXRcIiwge1xyXG4gICAgICB0eXBlOiBcIm51bWJlclwiLFxyXG4gICAgICB2YWx1ZTogU3RyaW5nKHRoaXMua2VlcFR1cm5zKVxyXG4gICAgfSk7XHJcbiAgICBrZWVwVHVybnNJbnB1dC5taW4gPSBcIjJcIjtcclxuICAgIGtlZXBUdXJuc0lucHV0Lm1heCA9IFwiMzBcIjtcclxuICAgIGtlZXBUdXJuc0lucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xyXG4gICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIucGFyc2VJbnQoa2VlcFR1cm5zSW5wdXQudmFsdWUsIDEwKTtcclxuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShwYXJzZWQpKSB7XHJcbiAgICAgICAgdGhpcy5rZWVwVHVybnMgPSBNYXRoLm1heCgyLCBNYXRoLm1pbigzMCwgcGFyc2VkKSk7XHJcbiAgICAgIH1cclxuICAgICAga2VlcFR1cm5zSW5wdXQudmFsdWUgPSBTdHJpbmcodGhpcy5rZWVwVHVybnMpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc3VtbWFyaXplVG9nZ2xlV3JhcCA9IG1lbW9yeUNvbnRyb2xzLmNyZWF0ZUVsKFwibGFiZWxcIiwge1xyXG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLW1lbW9yeS10b2dnbGVcIlxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzdW1tYXJpemVUb2dnbGUgPSBzdW1tYXJpemVUb2dnbGVXcmFwLmNyZWF0ZUVsKFwiaW5wdXRcIiwgeyB0eXBlOiBcImNoZWNrYm94XCIgfSk7XHJcbiAgICBzdW1tYXJpemVUb2dnbGUuY2hlY2tlZCA9IHRoaXMuc3VtbWFyaXplT2xkVHVybnM7XHJcbiAgICBzdW1tYXJpemVUb2dnbGVXcmFwLmFwcGVuZFRleHQoXCJzdW1tYXJpemUgb2xkXCIpO1xyXG4gICAgc3VtbWFyaXplVG9nZ2xlLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xyXG4gICAgICB0aGlzLnN1bW1hcml6ZU9sZFR1cm5zID0gc3VtbWFyaXplVG9nZ2xlLmNoZWNrZWQ7XHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBwaW5MYXN0QnV0dG9uID0gbWVtb3J5Q29udHJvbHMuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIlBpbiBsYXN0XCIgfSk7XHJcbiAgICBwaW5MYXN0QnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XHJcbiAgICAgIHRoaXMucGluTGFzdE1lc3NhZ2UoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IGNsZWFyUGluc0J1dHRvbiA9IG1lbW9yeUNvbnRyb2xzLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHsgdGV4dDogXCJDbGVhciBwaW5zXCIgfSk7XHJcbiAgICBjbGVhclBpbnNCdXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcclxuICAgICAgdGhpcy5waW5uZWRNZXNzYWdlcyA9IFtdO1xyXG4gICAgICBuZXcgTm90aWNlKFwiUGlubmVkIG1lc3NhZ2VzIGNsZWFyZWQuXCIpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgbWVtb3J5Q29udHJvbHMuY3JlYXRlRGl2KHtcclxuICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLWNoYXQtc2lkZWJhci1tZW1vcnktY291bnRcIixcclxuICAgICAgdGV4dDogYFBpbnM6ICR7dGhpcy5waW5uZWRNZXNzYWdlcy5sZW5ndGh9YFxyXG4gICAgfSk7XHJcblxyXG4gICAgdGhpcy50cmFuc2NyaXB0RWwgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC10cmFuc2NyaXB0XCIgfSk7XHJcblxyXG4gICAgY29uc3QgaW5wdXRXcmFwID0gY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtaW5wdXQtd3JhcFwiIH0pO1xyXG4gICAgdGhpcy5pbnB1dEVsID0gaW5wdXRXcmFwLmNyZWF0ZUVsKFwidGV4dGFyZWFcIiwge1xyXG4gICAgICBhdHRyOiB7XHJcbiAgICAgICAgcGxhY2Vob2xkZXI6XHJcbiAgICAgICAgICB0aGlzLm1vZGUgPT09IFwidmF1bHRcIlxyXG4gICAgICAgICAgICA/IFwiQXNrIGFib3V0IHlvdXIgdmF1bHQgb3IgcmVxdWVzdCBmaWxlL2ZvbGRlciBjcmVhdGlvbi4uLlwiXHJcbiAgICAgICAgICAgIDogXCJBc2sgYWJvdXQgdGhpcyBub3RlLi4uXCJcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgdGhpcy5zZW5kQnV0dG9uRWwgPSBpbnB1dFdyYXAuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIlNlbmRcIiB9KTtcclxuICAgIHRoaXMuc2F2ZUJ1dHRvbkVsID0gaW5wdXRXcmFwLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHsgdGV4dDogXCJTYXZlIENoYXRcIiB9KTtcclxuXHJcbiAgICB0aGlzLnNlbmRCdXR0b25FbC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCB0aGlzLnNlbmRNZXNzYWdlKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLnNhdmVCdXR0b25FbC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCB0aGlzLnNhdmVDaGF0KCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLmlucHV0RWwuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmIChldmVudC5rZXkgPT09IFwiRW50ZXJcIiAmJiAhZXZlbnQuc2hpZnRLZXkpIHtcclxuICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIGF3YWl0IHRoaXMuc2VuZE1lc3NhZ2UoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgdGhpcy5pbnB1dEVsLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnb3ZlclwiLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFldmVudC5kYXRhVHJhbnNmZXIpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnN0IGhhc1RleHQgPSBBcnJheS5mcm9tKGV2ZW50LmRhdGFUcmFuc2Zlci50eXBlcykuc29tZSgodHlwZSkgPT5cclxuICAgICAgICB0eXBlID09PSBcInRleHQvcGxhaW5cIiB8fCB0eXBlID09PSBcInRleHQvdXJpLWxpc3RcIlxyXG4gICAgICApO1xyXG4gICAgICBpZiAoIWhhc1RleHQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIGV2ZW50LmRhdGFUcmFuc2Zlci5kcm9wRWZmZWN0ID0gXCJjb3B5XCI7XHJcbiAgICAgIGlmICghdGhpcy5pc0RyYWdnaW5nVXJpKSB7XHJcbiAgICAgICAgdGhpcy5pc0RyYWdnaW5nVXJpID0gdHJ1ZTtcclxuICAgICAgICB0aGlzLmlucHV0RWwuYWRkQ2xhc3MoXCJpcy1kcmFnLW92ZXJcIik7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHRoaXMuaW5wdXRFbC5hZGRFdmVudExpc3RlbmVyKFwiZHJhZ2xlYXZlXCIsICgpID0+IHtcclxuICAgICAgdGhpcy5pc0RyYWdnaW5nVXJpID0gZmFsc2U7XHJcbiAgICAgIHRoaXMuaW5wdXRFbC5yZW1vdmVDbGFzcyhcImlzLWRyYWctb3ZlclwiKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHRoaXMuaW5wdXRFbC5hZGRFdmVudExpc3RlbmVyKFwiZHJvcFwiLCAoZXZlbnQpID0+IHtcclxuICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgdGhpcy5pc0RyYWdnaW5nVXJpID0gZmFsc2U7XHJcbiAgICAgIHRoaXMuaW5wdXRFbC5yZW1vdmVDbGFzcyhcImlzLWRyYWctb3ZlclwiKTtcclxuXHJcbiAgICAgIGNvbnN0IGR0ID0gZXZlbnQuZGF0YVRyYW5zZmVyO1xyXG4gICAgICBpZiAoIWR0KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBjb25zdCB1cmlMaXN0ID0gZHQuZ2V0RGF0YShcInRleHQvdXJpLWxpc3RcIikgfHwgXCJcIjtcclxuICAgICAgY29uc3QgcGxhaW5UZXh0ID0gZHQuZ2V0RGF0YShcInRleHQvcGxhaW5cIikgfHwgXCJcIjtcclxuICAgICAgY29uc3QgbWVyZ2VkID0gYCR7dXJpTGlzdH1cXG4ke3BsYWluVGV4dH1gLnRyaW0oKTtcclxuICAgICAgaWYgKCFtZXJnZWQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnN0IGxpbmVzID0gbWVyZ2VkXHJcbiAgICAgICAgLnNwbGl0KC9cXHI/XFxuLylcclxuICAgICAgICAubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcclxuICAgICAgICAuZmlsdGVyKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xyXG5cclxuICAgICAgY29uc3QgcmVmZXJlbmNlczogc3RyaW5nW10gPSBbXTtcclxuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XHJcbiAgICAgICAgY29uc3QgZmlsZSA9IHRoaXMucGx1Z2luLnJlc29sdmVPYnNpZGlhblVyaVRvRmlsZShsaW5lKTtcclxuICAgICAgICBpZiAoZmlsZSkge1xyXG4gICAgICAgICAgcmVmZXJlbmNlcy5wdXNoKGBbWyR7ZmlsZS5wYXRofV1dYCk7XHJcbiAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHNhZmVQYXRoID0gdGhpcy5wbHVnaW4ucmVzb2x2ZU9ic2lkaWFuVXJpVG9QYXRoKGxpbmUpO1xyXG4gICAgICAgIGlmIChzYWZlUGF0aCkge1xyXG4gICAgICAgICAgcmVmZXJlbmNlcy5wdXNoKGBbWyR7c2FmZVBhdGh9XV1gKTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGxpbmUudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChcIi5tZFwiKSkge1xyXG4gICAgICAgICAgcmVmZXJlbmNlcy5wdXNoKGBbWyR7bGluZX1dXWApO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKCFyZWZlcmVuY2VzLmxlbmd0aCkge1xyXG4gICAgICAgIG5ldyBOb3RpY2UoXCJEcm9wcGVkIGl0ZW0gZGlkIG5vdCBjb250YWluIGEgc3VwcG9ydGVkIE9ic2lkaWFuIG5vdGUgbGluay5cIik7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBjb25zdCBwcmVmaXggPSB0aGlzLmlucHV0RWwudmFsdWUudHJpbSgpID8gXCJcXG5cIiA6IFwiXCI7XHJcbiAgICAgIHRoaXMuaW5wdXRFbC52YWx1ZSA9IGAke3RoaXMuaW5wdXRFbC52YWx1ZX0ke3ByZWZpeH0ke3JlZmVyZW5jZXMuam9pbihcIlxcblwiKX1gO1xyXG4gICAgICB0aGlzLmlucHV0RWwuZm9jdXMoKTtcclxuICAgICAgbmV3IE5vdGljZShgQWRkZWQgJHtyZWZlcmVuY2VzLmxlbmd0aH0gbm90ZSByZWZlcmVuY2UocykgZnJvbSBkcm9wLmApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgdGhpcy5pbnB1dEVsLmZvY3VzKCk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIHN3aXRjaE1vZGUobW9kZTogXCJ2YXVsdFwiIHwgXCJub3RlXCIsIG5vdGVQYXRoID0gXCJcIik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdGhpcy5tb2RlID0gbW9kZTtcclxuICAgIHRoaXMubm90ZVBhdGggPSBub3RlUGF0aDtcclxuICAgIHRoaXMubWVzc2FnZXMgPSBbXTtcclxuICAgIHRoaXMucGVuZGluZ0FjdGlvbnMgPSBbXTtcclxuXHJcbiAgICBjb25zdCBjdXJyZW50U3RhdGUgPSB0aGlzLmxlYWYuZ2V0Vmlld1N0YXRlKCk7XHJcbiAgICBhd2FpdCB0aGlzLmxlYWYuc2V0Vmlld1N0YXRlKHtcclxuICAgICAgLi4uY3VycmVudFN0YXRlLFxyXG4gICAgICBzdGF0ZToge1xyXG4gICAgICAgIG1vZGU6IHRoaXMubW9kZSxcclxuICAgICAgICBub3RlUGF0aDogdGhpcy5ub3RlUGF0aFxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLnJlbmRlcigpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBwaW5MYXN0TWVzc2FnZSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IGxhc3QgPSBbLi4udGhpcy5tZXNzYWdlc10ucmV2ZXJzZSgpLmZpbmQoKG1zZykgPT4gbXNnLnJvbGUgPT09IFwidXNlclwiIHx8IG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiKTtcclxuICAgIGlmICghbGFzdCkge1xyXG4gICAgICBuZXcgTm90aWNlKFwiTm8gbWVzc2FnZSB0byBwaW4geWV0LlwiKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHRoaXMucGlubmVkTWVzc2FnZXMucHVzaCh7IHJvbGU6IGxhc3Qucm9sZSwgY29udGVudDogbGFzdC5jb250ZW50IH0pO1xyXG4gICAgbmV3IE5vdGljZShcIlBpbm5lZCBsYXN0IG1lc3NhZ2UgZm9yIG1lbW9yeS5cIik7XHJcbiAgICB0aGlzLnJlbmRlcigpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBnZXRIaXN0b3J5Rm9yTW9kZWwoaGlzdG9yeUJlZm9yZVR1cm46IENoYXRNZXNzYWdlW10pOiBDaGF0TWVzc2FnZVtdIHtcclxuICAgIGNvbnN0IGtlZXBDb3VudCA9IE1hdGgubWF4KDIsIHRoaXMua2VlcFR1cm5zKSAqIDI7XHJcbiAgICBpZiAoIXRoaXMuc3VtbWFyaXplT2xkVHVybnMgfHwgaGlzdG9yeUJlZm9yZVR1cm4ubGVuZ3RoIDw9IGtlZXBDb3VudCkge1xyXG4gICAgICByZXR1cm4gWy4uLnRoaXMucGlubmVkTWVzc2FnZXMsIC4uLmhpc3RvcnlCZWZvcmVUdXJuLnNsaWNlKC1rZWVwQ291bnQpXTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gWy4uLnRoaXMucGlubmVkTWVzc2FnZXMsIC4uLmhpc3RvcnlCZWZvcmVUdXJuLnNsaWNlKC1rZWVwQ291bnQpXTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbWF5YmVTdW1tYXJpemVIaXN0b3J5KGhpc3RvcnlCZWZvcmVUdXJuOiBDaGF0TWVzc2FnZVtdKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBrZWVwQ291bnQgPSBNYXRoLm1heCgyLCB0aGlzLmtlZXBUdXJucykgKiAyO1xyXG4gICAgaWYgKCF0aGlzLnN1bW1hcml6ZU9sZFR1cm5zIHx8IGhpc3RvcnlCZWZvcmVUdXJuLmxlbmd0aCA8PSBrZWVwQ291bnQpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG9sZGVyID0gaGlzdG9yeUJlZm9yZVR1cm4uc2xpY2UoMCwgLWtlZXBDb3VudCk7XHJcbiAgICBpZiAoIW9sZGVyLmxlbmd0aCkge1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgc3VtbWFyeSA9IGF3YWl0IHRoaXMucGx1Z2luLnN1bW1hcml6ZUNoYXRNZXNzYWdlcyhvbGRlcik7XHJcbiAgICBpZiAoIXN1bW1hcnkpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHRoaXMuY29udmVyc2F0aW9uU3VtbWFyeSA9IHRoaXMuY29udmVyc2F0aW9uU3VtbWFyeVxyXG4gICAgICA/IGAke3RoaXMuY29udmVyc2F0aW9uU3VtbWFyeX1cXG4tICR7c3VtbWFyeX1gXHJcbiAgICAgIDogc3VtbWFyeTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgcmVuZGVyQ2l0YXRpb25MaW5rcyhwYXJlbnQ6IEhUTUxFbGVtZW50LCBhbnN3ZXI6IHN0cmluZywgY2h1bmtzOiBOb3RlQ2h1bmtbXSk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLmNpdGF0aW9uU3R5bGUgIT09IFwiZm9vdGVyXCIpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGNpdGF0aW9ucyA9IHRoaXMucGx1Z2luLmdldENpdGF0aW9uTGlua3MoYW5zd2VyLCBjaHVua3MpO1xyXG4gICAgaWYgKCFjaXRhdGlvbnMubGVuZ3RoKSB7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCB3cmFwID0gcGFyZW50LmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rc1wiIH0pO1xyXG4gICAgd3JhcC5jcmVhdGVEaXYoe1xyXG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtbGlua3MtdGl0bGVcIixcclxuICAgICAgdGV4dDogXCJDaXRhdGlvbnNcIlxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBsaXN0ID0gd3JhcC5jcmVhdGVFbChcInVsXCIsIHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLWxpbmtzLWxpc3RcIiB9KTtcclxuICAgIGZvciAoY29uc3QgY2l0YXRpb24gb2YgY2l0YXRpb25zKSB7XHJcbiAgICAgIGNvbnN0IGxpID0gbGlzdC5jcmVhdGVFbChcImxpXCIpO1xyXG4gICAgICBjb25zdCBsaW5rID0gbGkuY3JlYXRlRWwoXCJhXCIsIHsgdGV4dDogYFske2NpdGF0aW9uLm51bWJlcn1dICR7Y2l0YXRpb24uZmlsZS5wYXRofWAsIGhyZWY6IFwiI1wiIH0pO1xyXG4gICAgICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWFmKHRydWUpLm9wZW5GaWxlKGNpdGF0aW9uLmZpbGUpO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIHByaXZhdGUgcmVuZGVyUmVmZXJlbmNlZEZpbGVzKHBhcmVudDogSFRNTEVsZW1lbnQsIGFuc3dlcjogc3RyaW5nLCBjaHVua3M6IE5vdGVDaHVua1tdKTogdm9pZCB7XHJcbiAgICBjb25zdCByZWZlcmVuY2VkRmlsZXMgPSB0aGlzLnBsdWdpbi5nZXRSZWZlcmVuY2VkRmlsZXMoYW5zd2VyLCBjaHVua3MpO1xyXG4gICAgaWYgKCFyZWZlcmVuY2VkRmlsZXMubGVuZ3RoKSB7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCByZWZzV3JhcCA9IHBhcmVudC5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtbGlua3NcIiB9KTtcclxuICAgIHJlZnNXcmFwLmNyZWF0ZURpdih7XHJcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy10aXRsZVwiLFxyXG4gICAgICB0ZXh0OiBcIlJlZmVyZW5jZWQgZmlsZXNcIlxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3QgcmVmc0xpc3QgPSByZWZzV3JhcC5jcmVhdGVFbChcInVsXCIsIHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLWxpbmtzLWxpc3RcIiB9KTtcclxuICAgIGZvciAoY29uc3QgZmlsZSBvZiByZWZlcmVuY2VkRmlsZXMpIHtcclxuICAgICAgY29uc3QgbGkgPSByZWZzTGlzdC5jcmVhdGVFbChcImxpXCIpO1xyXG4gICAgICBjb25zdCBsaW5rID0gbGkuY3JlYXRlRWwoXCJhXCIsIHsgdGV4dDogZmlsZS5wYXRoLCBocmVmOiBcIiNcIiB9KTtcclxuICAgICAgbGluay5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICBhd2FpdCB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZih0cnVlKS5vcGVuRmlsZShmaWxlKTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHJlbmRlclBlbmRpbmdBY3Rpb25zKHBhcmVudDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICAgIGlmICghdGhpcy5wZW5kaW5nQWN0aW9ucy5sZW5ndGgpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHBhbmVsID0gcGFyZW50LmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1hY3Rpb24tYXBwcm92YWxcIiB9KTtcclxuICAgIHBhbmVsLmNyZWF0ZURpdih7XHJcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy10aXRsZVwiLFxyXG4gICAgICB0ZXh0OiBgUGxhbm5lZCBhY3Rpb25zICgke3RoaXMucGVuZGluZ0FjdGlvbnMubGVuZ3RofSlgXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBsaXN0ID0gcGFuZWwuY3JlYXRlRWwoXCJ1bFwiLCB7IGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy1saXN0XCIgfSk7XHJcbiAgICBmb3IgKGNvbnN0IGFjdGlvbiBvZiB0aGlzLnBlbmRpbmdBY3Rpb25zKSB7XHJcbiAgICAgIGNvbnN0IGxpID0gbGlzdC5jcmVhdGVFbChcImxpXCIpO1xyXG4gICAgICBsaS5zZXRUZXh0KHRoaXMuZGVzY3JpYmVBY3Rpb24oYWN0aW9uKSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgYnV0dG9ucyA9IHBhbmVsLmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1hY3Rpb24tYXBwcm92YWwtYnV0dG9uc1wiIH0pO1xyXG4gICAgY29uc3QgYXBwcm92ZUJ1dHRvbiA9IGJ1dHRvbnMuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIkFwcHJvdmUgYWN0aW9uc1wiIH0pO1xyXG4gICAgY29uc3QgZGlzY2FyZEJ1dHRvbiA9IGJ1dHRvbnMuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIkRpc2NhcmRcIiB9KTtcclxuXHJcbiAgICBhcHByb3ZlQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXBwcm92ZUJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICAgICAgZGlzY2FyZEJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICAgICAgY29uc3Qgc3VtbWFyeSA9IGF3YWl0IHRoaXMucGx1Z2luLmFwcGx5QWdlbnRBY3Rpb25zKHRoaXMucGVuZGluZ0FjdGlvbnMpO1xyXG4gICAgICAgIHRoaXMucGVuZGluZ0FjdGlvbnMgPSBbXTtcclxuICAgICAgICBwYW5lbC5yZW1vdmUoKTtcclxuICAgICAgICBuZXcgTm90aWNlKHN1bW1hcnkpO1xyXG4gICAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBcIkFjdGlvbnMgYXBwbGllZC5cIiwgc3VtbWFyeSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgYXBwcm92ZUJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xyXG4gICAgICAgIGRpc2NhcmRCdXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcclxuICAgICAgICBuZXcgTm90aWNlKGBGYWlsZWQgdG8gYXBwbHkgYWN0aW9uczogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGRpc2NhcmRCdXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcclxuICAgICAgdGhpcy5wZW5kaW5nQWN0aW9ucyA9IFtdO1xyXG4gICAgICBuZXcgTm90aWNlKFwiUGVuZGluZyBhY3Rpb25zIGRpc2NhcmRlZC5cIik7XHJcbiAgICAgIHBhbmVsLnJlbW92ZSgpO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHJlcGxhY2VDaXRhdGlvbk1hcmtlcnNXaXRoV2lraUxpbmtzKHRleHQ6IHN0cmluZywgY2h1bmtzOiBOb3RlQ2h1bmtbXSk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gdGV4dC5yZXBsYWNlKC9cXFsoXFxkKylcXF0vZywgKGZ1bGwsIG51bVRleHQ6IHN0cmluZykgPT4ge1xyXG4gICAgICBjb25zdCBpZHggPSBOdW1iZXIucGFyc2VJbnQobnVtVGV4dCwgMTApO1xyXG4gICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpIHx8IGlkeCA8IDEgfHwgaWR4ID4gY2h1bmtzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiBmdWxsO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBjb25zdCBwYXRoID0gY2h1bmtzW2lkeCAtIDFdPy5maWxlUGF0aDtcclxuICAgICAgaWYgKCFwYXRoKSB7XHJcbiAgICAgICAgcmV0dXJuIGZ1bGw7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIHJldHVybiBgW1ske3BhdGh9XV1gO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHByZXBhcmVBY3Rpb25zV2l0aENpdGF0aW9uTGlua3MoYWN0aW9uczogQWdlbnRBY3Rpb25bXSwgY2h1bmtzOiBOb3RlQ2h1bmtbXSk6IEFnZW50QWN0aW9uW10ge1xyXG4gICAgcmV0dXJuIGFjdGlvbnMubWFwKChhY3Rpb24pID0+IHtcclxuICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcImNyZWF0ZV9maWxlXCIpIHtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgLi4uYWN0aW9uLFxyXG4gICAgICAgICAgY29udGVudDogdGhpcy5yZXBsYWNlQ2l0YXRpb25NYXJrZXJzV2l0aFdpa2lMaW5rcyhhY3Rpb24uY29udGVudCwgY2h1bmtzKVxyXG4gICAgICAgIH07XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJhcHBlbmRfZmlsZVwiKSB7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgIC4uLmFjdGlvbixcclxuICAgICAgICAgIGNvbnRlbnQ6IHRoaXMucmVwbGFjZUNpdGF0aW9uTWFya2Vyc1dpdGhXaWtpTGlua3MoYWN0aW9uLmNvbnRlbnQsIGNodW5rcylcclxuICAgICAgICB9O1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAoYWN0aW9uLnR5cGUgPT09IFwiaW5zZXJ0X2FmdGVyX2hlYWRpbmdcIikge1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAuLi5hY3Rpb24sXHJcbiAgICAgICAgICBjb250ZW50OiB0aGlzLnJlcGxhY2VDaXRhdGlvbk1hcmtlcnNXaXRoV2lraUxpbmtzKGFjdGlvbi5jb250ZW50LCBjaHVua3MpXHJcbiAgICAgICAgfTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcInJlcGxhY2VfaW5fZmlsZVwiKSB7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgIC4uLmFjdGlvbixcclxuICAgICAgICAgIHJlcGxhY2U6IHRoaXMucmVwbGFjZUNpdGF0aW9uTWFya2Vyc1dpdGhXaWtpTGlua3MoYWN0aW9uLnJlcGxhY2UsIGNodW5rcylcclxuICAgICAgICB9O1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAoYWN0aW9uLnR5cGUgPT09IFwiY3JlYXRlX2Zyb21fdGVtcGxhdGVcIikge1xyXG4gICAgICAgIGNvbnN0IHZhcnMgPSBhY3Rpb24udmFyaWFibGVzID8/IHt9O1xyXG4gICAgICAgIGNvbnN0IHVwZGF0ZWRWYXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFycykpIHtcclxuICAgICAgICAgIHVwZGF0ZWRWYXJzW2tleV0gPSB0aGlzLnJlcGxhY2VDaXRhdGlvbk1hcmtlcnNXaXRoV2lraUxpbmtzKHZhbHVlLCBjaHVua3MpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgIC4uLmFjdGlvbixcclxuICAgICAgICAgIHZhcmlhYmxlczogdXBkYXRlZFZhcnNcclxuICAgICAgICB9O1xyXG4gICAgICB9XHJcblxyXG4gICAgICByZXR1cm4gYWN0aW9uO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGRlc2NyaWJlQWN0aW9uKGFjdGlvbjogQWdlbnRBY3Rpb24pOiBzdHJpbmcge1xyXG4gICAgaWYgKGFjdGlvbi50eXBlID09PSBcImNyZWF0ZV9mb2xkZXJcIikge1xyXG4gICAgICByZXR1cm4gYGNyZWF0ZV9mb2xkZXI6ICR7YWN0aW9uLnBhdGh9YDtcclxuICAgIH1cclxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJjcmVhdGVfZmlsZVwiKSB7XHJcbiAgICAgIHJldHVybiBgY3JlYXRlX2ZpbGU6ICR7YWN0aW9uLnBhdGh9JHthY3Rpb24ub3ZlcndyaXRlID8gXCIgKG92ZXJ3cml0ZSlcIiA6IFwiXCJ9YDtcclxuICAgIH1cclxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJhcHBlbmRfZmlsZVwiKSB7XHJcbiAgICAgIHJldHVybiBgYXBwZW5kX2ZpbGU6ICR7YWN0aW9uLnBhdGh9YDtcclxuICAgIH1cclxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJpbnNlcnRfYWZ0ZXJfaGVhZGluZ1wiKSB7XHJcbiAgICAgIHJldHVybiBgaW5zZXJ0X2FmdGVyX2hlYWRpbmc6ICR7YWN0aW9uLnBhdGh9IGFmdGVyICR7YWN0aW9uLmhlYWRpbmd9YDtcclxuICAgIH1cclxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJyZXBsYWNlX2luX2ZpbGVcIikge1xyXG4gICAgICByZXR1cm4gYHJlcGxhY2VfaW5fZmlsZTogJHthY3Rpb24ucGF0aH0gZmluZCBcXFwiJHthY3Rpb24uZmluZH1cXFwiYDtcclxuICAgIH1cclxuICAgIHJldHVybiBgY3JlYXRlX2Zyb21fdGVtcGxhdGU6ICR7YWN0aW9uLnRlbXBsYXRlfSAtPiAke2FjdGlvbi5wYXRofWA7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIGhhbmRsZVNsYXNoQ29tbWFuZChjb21tYW5kVGV4dDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgICBpZiAoIWNvbW1hbmRUZXh0LnN0YXJ0c1dpdGgoXCIvXCIpKSB7XHJcbiAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBbY29tbWFuZCwgLi4ucmVzdF0gPSBjb21tYW5kVGV4dC5zbGljZSgxKS50cmltKCkuc3BsaXQoL1xccysvKTtcclxuICAgIGNvbnN0IGFyZyA9IHJlc3Quam9pbihcIiBcIikudHJpbSgpO1xyXG5cclxuICAgIHN3aXRjaCAoY29tbWFuZC50b0xvd2VyQ2FzZSgpKSB7XHJcbiAgICAgIGNhc2UgXCJoZWxwXCI6XHJcbiAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFxyXG4gICAgICAgICAgXCJhc3Npc3RhbnRcIixcclxuICAgICAgICAgIFtcclxuICAgICAgICAgICAgXCJTbGFzaCBjb21tYW5kczpcIixcclxuICAgICAgICAgICAgXCIvaGVscFwiLFxyXG4gICAgICAgICAgICBcIi9tb2RlbCA8bW9kZWwtaWQ+XCIsXHJcbiAgICAgICAgICAgIFwiL3JlaW5kZXhcIixcclxuICAgICAgICAgICAgXCIvY2xlYXJcIixcclxuICAgICAgICAgICAgXCIvc2F2ZVwiLFxyXG4gICAgICAgICAgICBcIi9tb2RlIHZhdWx0fG5vdGVcIixcclxuICAgICAgICAgICAgXCIvZmluZCA8cXVlcnk+XCIsXHJcbiAgICAgICAgICAgIFwiL3RhZyA8dGFnPlwiLFxyXG4gICAgICAgICAgICBcIi9vcGVuIDxxdWVyeT5cIixcclxuICAgICAgICAgICAgXCIvcGluIDx0ZXh0PlwiLFxyXG4gICAgICAgICAgICBcIi9waW5zXCJcclxuICAgICAgICAgIF0uam9pbihcIlxcblwiKVxyXG4gICAgICAgICk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgIGNhc2UgXCJtb2RlbFwiOlxyXG4gICAgICAgIGlmICghYXJnKSB7XHJcbiAgICAgICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgYEN1cnJlbnQgbW9kZWw6ICR7dGhpcy5wbHVnaW4uc2V0dGluZ3MubW9kZWx9YCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsID0gYXJnO1xyXG4gICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgYE1vZGVsIHNldCB0bzogJHthcmd9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICBjYXNlIFwicmVpbmRleFwiOlxyXG4gICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnJlYnVpbGRJbmRleCgpO1xyXG4gICAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBcIlZhdWx0IGluZGV4IHJlYnVpbHQuXCIpO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICBjYXNlIFwiY2xlYXJcIjpcclxuICAgICAgICB0aGlzLm1lc3NhZ2VzID0gW107XHJcbiAgICAgICAgdGhpcy5wZW5kaW5nQWN0aW9ucyA9IFtdO1xyXG4gICAgICAgIHRoaXMuY29udmVyc2F0aW9uU3VtbWFyeSA9IFwiXCI7XHJcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0RWwuZW1wdHkoKTtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgY2FzZSBcInNhdmVcIjpcclxuICAgICAgICBhd2FpdCB0aGlzLnNhdmVDaGF0KCk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgIGNhc2UgXCJtb2RlXCI6XHJcbiAgICAgICAgaWYgKGFyZyA9PT0gXCJ2YXVsdFwiKSB7XHJcbiAgICAgICAgICBhd2FpdCB0aGlzLnN3aXRjaE1vZGUoXCJ2YXVsdFwiKTtcclxuICAgICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gXCJub3RlXCIpIHtcclxuICAgICAgICAgIGNvbnN0IGFjdGl2ZUZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xyXG4gICAgICAgICAgaWYgKCFhY3RpdmVGaWxlIHx8IGFjdGl2ZUZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIpIHtcclxuICAgICAgICAgICAgbmV3IE5vdGljZShcIk9wZW4gYSBtYXJrZG93biBub3RlIGZpcnN0LlwiKTtcclxuICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuc3dpdGNoTW9kZShcIm5vdGVcIiwgYWN0aXZlRmlsZS5wYXRoKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIFwiVXNhZ2U6IC9tb2RlIHZhdWx0fG5vdGVcIik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICBjYXNlIFwiZmluZFwiOlxyXG4gICAgICAgIGlmICghYXJnKSB7XHJcbiAgICAgICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgXCJVc2FnZTogL2ZpbmQgPHF1ZXJ5PlwiKTtcclxuICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aGlzLmhhbmRsZUZpbmQoYXJnKTtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgY2FzZSBcInRhZ1wiOlxyXG4gICAgICAgIGlmICghYXJnKSB7XHJcbiAgICAgICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgXCJVc2FnZTogL3RhZyA8dGFnPlwiKTtcclxuICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCB0aGlzLmhhbmRsZVRhZyhhcmcucmVwbGFjZSgvXiMvLCBcIlwiKSk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgIGNhc2UgXCJvcGVuXCI6XHJcbiAgICAgICAgaWYgKCFhcmcpIHtcclxuICAgICAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBcIlVzYWdlOiAvb3BlbiA8cGF0aC1mcmFnbWVudD5cIik7XHJcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgdGhpcy5oYW5kbGVPcGVuKGFyZyk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgIGNhc2UgXCJwaW5cIjpcclxuICAgICAgICBpZiAoIWFyZykge1xyXG4gICAgICAgICAgdGhpcy5waW5MYXN0TWVzc2FnZSgpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICB0aGlzLnBpbm5lZE1lc3NhZ2VzLnB1c2goeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogYXJnIH0pO1xyXG4gICAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIGBQaW5uZWQ6ICR7YXJnfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgY2FzZSBcInBpbnNcIjpcclxuICAgICAgICB0aGlzLmFkZE1lc3NhZ2UoXHJcbiAgICAgICAgICBcImFzc2lzdGFudFwiLFxyXG4gICAgICAgICAgdGhpcy5waW5uZWRNZXNzYWdlcy5sZW5ndGhcclxuICAgICAgICAgICAgPyB0aGlzLnBpbm5lZE1lc3NhZ2VzLm1hcCgobXNnLCBpZHgpID0+IGAke2lkeCArIDF9LiAke21zZy5yb2xlfTogJHttc2cuY29udGVudH1gKS5qb2luKFwiXFxuXCIpXHJcbiAgICAgICAgICAgIDogXCJObyBwaW5uZWQgbWVzc2FnZXMuXCJcclxuICAgICAgICApO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICBkZWZhdWx0OlxyXG4gICAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBgVW5rbm93biBjb21tYW5kOiAvJHtjb21tYW5kfS4gVXNlIC9oZWxwLmApO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBoYW5kbGVGaW5kKHF1ZXJ5OiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIGNvbnN0IHEgPSBxdWVyeS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgY29uc3QgZmlsZXMgPSB0aGlzLmFwcC52YXVsdFxyXG4gICAgICAuZ2V0TWFya2Rvd25GaWxlcygpXHJcbiAgICAgIC5maWx0ZXIoKGZpbGUpID0+IGZpbGUucGF0aC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKVxyXG4gICAgICAuc2xpY2UoMCwgMjApO1xyXG5cclxuICAgIGlmICghZmlsZXMubGVuZ3RoKSB7XHJcbiAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBgTm8gbm90ZXMgZm91bmQgZm9yOiAke3F1ZXJ5fWApO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIGZpbGVzLm1hcCgoZmlsZSkgPT4gYC0gJHtmaWxlLnBhdGh9YCkuam9pbihcIlxcblwiKSk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIGhhbmRsZVRhZyh0YWc6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgZmlsZXMgPSB0aGlzLmFwcC52YXVsdC5nZXRNYXJrZG93bkZpbGVzKCk7XHJcbiAgICBjb25zdCBtYXRjaGVzOiBzdHJpbmdbXSA9IFtdO1xyXG5cclxuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xyXG4gICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQuY2FjaGVkUmVhZChmaWxlKTtcclxuICAgICAgY29uc3QgaGFzSW5saW5lVGFnID0gbmV3IFJlZ0V4cChgKF58XFxcXHMpIyR7dGFnfShcXFxcYnxcXFxcc3wkKWAsIFwiaVwiKS50ZXN0KHRleHQpO1xyXG4gICAgICBjb25zdCBoYXNGcm9udG1hdHRlclRhZyA9IG5ldyBSZWdFeHAoYChefFxcXFxuKXRhZ3M6XFxcXHMqKC4qJHt0YWd9LiopJGAsIFwiaW1cIikudGVzdCh0ZXh0KTtcclxuICAgICAgaWYgKGhhc0lubGluZVRhZyB8fCBoYXNGcm9udG1hdHRlclRhZykge1xyXG4gICAgICAgIG1hdGNoZXMucHVzaChmaWxlLnBhdGgpO1xyXG4gICAgICB9XHJcbiAgICAgIGlmIChtYXRjaGVzLmxlbmd0aCA+PSAyMCkge1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgdGhpcy5hZGRNZXNzYWdlKFxyXG4gICAgICBcImFzc2lzdGFudFwiLFxyXG4gICAgICBtYXRjaGVzLmxlbmd0aCA/IG1hdGNoZXMubWFwKChwYXRoKSA9PiBgLSAke3BhdGh9YCkuam9pbihcIlxcblwiKSA6IGBObyBub3RlcyBmb3VuZCBmb3IgdGFnICMke3RhZ31gXHJcbiAgICApO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhc3luYyBoYW5kbGVPcGVuKHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHEgPSBxdWVyeS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLnZhdWx0XHJcbiAgICAgIC5nZXRNYXJrZG93bkZpbGVzKClcclxuICAgICAgLmZpbmQoKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLnBhdGgudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSk7XHJcblxyXG4gICAgaWYgKCFmaWxlKSB7XHJcbiAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBgTm8gbWF0Y2hpbmcgbm90ZSB0byBvcGVuIGZvcjogJHtxdWVyeX1gKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGF3YWl0IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWFmKHRydWUpLm9wZW5GaWxlKGZpbGUpO1xyXG4gICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIGBPcGVuZWQ6ICR7ZmlsZS5wYXRofWApO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhZGRNZXNzYWdlKFxyXG4gICAgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLFxyXG4gICAgdGV4dDogc3RyaW5nLFxyXG4gICAgbWV0YVRleHQ/OiBzdHJpbmcsXHJcbiAgICByZWZlcmVuY2VkRmlsZXM6IFRGaWxlW10gPSBbXSxcclxuICAgIHRoaW5raW5nVGV4dD86IHN0cmluZ1xyXG4gICk6IHZvaWQge1xyXG4gICAgY29uc3QgYnViYmxlID0gdGhpcy50cmFuc2NyaXB0RWwuY3JlYXRlRGl2KHtcclxuICAgICAgY2xzOiBgcmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UgcmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtJHtyb2xlfWBcclxuICAgIH0pO1xyXG5cclxuICAgIGJ1YmJsZS5jcmVhdGVEaXYoe1xyXG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2Utcm9sZVwiLFxyXG4gICAgICB0ZXh0OiByb2xlID09PSBcInVzZXJcIiA/IFwiWW91XCIgOiBcIkFzc2lzdGFudFwiXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBjb250ZW50RWwgPSBidWJibGUuY3JlYXRlRGl2KHtcclxuICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLWNvbnRlbnRcIixcclxuICAgICAgdGV4dFxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKHJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcclxuICAgICAgdm9pZCB0aGlzLnJlbmRlckFzc2lzdGFudE1hcmtkb3duKGNvbnRlbnRFbCwgdGV4dCk7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKHJvbGUgPT09IFwiYXNzaXN0YW50XCIgJiYgdGhpbmtpbmdUZXh0KSB7XHJcbiAgICAgIGJ1YmJsZS5jcmVhdGVEaXYoe1xyXG4gICAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS10aGlua2luZ1wiLFxyXG4gICAgICAgIHRleHQ6IHRoaW5raW5nVGV4dFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAobWV0YVRleHQpIHtcclxuICAgICAgYnViYmxlLmNyZWF0ZURpdih7XHJcbiAgICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLW1ldGFcIixcclxuICAgICAgICB0ZXh0OiBtZXRhVGV4dFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAocm9sZSA9PT0gXCJhc3Npc3RhbnRcIiAmJiByZWZlcmVuY2VkRmlsZXMubGVuZ3RoKSB7XHJcbiAgICAgIGNvbnN0IHJlZnNXcmFwID0gYnViYmxlLmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rc1wiIH0pO1xyXG4gICAgICByZWZzV3JhcC5jcmVhdGVEaXYoe1xyXG4gICAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy10aXRsZVwiLFxyXG4gICAgICAgIHRleHQ6IFwiUmVmZXJlbmNlZCBmaWxlc1wiXHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgY29uc3QgcmVmc0xpc3QgPSByZWZzV3JhcC5jcmVhdGVFbChcInVsXCIsIHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLWxpbmtzLWxpc3RcIiB9KTtcclxuICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHJlZmVyZW5jZWRGaWxlcykge1xyXG4gICAgICAgIGNvbnN0IGxpID0gcmVmc0xpc3QuY3JlYXRlRWwoXCJsaVwiKTtcclxuICAgICAgICBjb25zdCBsaW5rID0gbGkuY3JlYXRlRWwoXCJhXCIsIHsgdGV4dDogZmlsZS5wYXRoLCBocmVmOiBcIiNcIiB9KTtcclxuICAgICAgICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICBhd2FpdCB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZih0cnVlKS5vcGVuRmlsZShmaWxlKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHRoaXMudHJhbnNjcmlwdEVsLnNjcm9sbFRvcCA9IHRoaXMudHJhbnNjcmlwdEVsLnNjcm9sbEhlaWdodDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgc2VuZE1lc3NhZ2UoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBxdWVzdGlvbiA9IHRoaXMuaW5wdXRFbC52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXF1ZXN0aW9uKSB7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoYXdhaXQgdGhpcy5oYW5kbGVTbGFzaENvbW1hbmQocXVlc3Rpb24pKSB7XHJcbiAgICAgIHRoaXMuaW5wdXRFbC52YWx1ZSA9IFwiXCI7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBpZiAodGhpcy5tb2RlID09PSBcIm5vdGVcIiAmJiAhdGhpcy5ub3RlUGF0aCkge1xyXG4gICAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcclxuICAgICAgaWYgKCFhY3RpdmVGaWxlIHx8IGFjdGl2ZUZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIpIHtcclxuICAgICAgICBuZXcgTm90aWNlKFwiT3BlbiBhIG1hcmtkb3duIG5vdGUgZmlyc3QuXCIpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICB0aGlzLm5vdGVQYXRoID0gYWN0aXZlRmlsZS5wYXRoO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGhpc3RvcnlCZWZvcmVUdXJuID0gWy4uLnRoaXMubWVzc2FnZXNdO1xyXG4gICAgYXdhaXQgdGhpcy5tYXliZVN1bW1hcml6ZUhpc3RvcnkoaGlzdG9yeUJlZm9yZVR1cm4pO1xyXG4gICAgY29uc3QgbW9kZWxIaXN0b3J5ID0gdGhpcy5nZXRIaXN0b3J5Rm9yTW9kZWwoaGlzdG9yeUJlZm9yZVR1cm4pO1xyXG5cclxuICAgIGlmICh0aGlzLmNvbnZlcnNhdGlvblN1bW1hcnkpIHtcclxuICAgICAgbW9kZWxIaXN0b3J5LnVuc2hpZnQoe1xyXG4gICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXHJcbiAgICAgICAgY29udGVudDogYENvbnZlcnNhdGlvbiBzdW1tYXJ5IG1lbW9yeTpcXG4ke3RoaXMuY29udmVyc2F0aW9uU3VtbWFyeX1gXHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBxdWVzdGlvbiB9KTtcclxuICAgIHRoaXMuYWRkTWVzc2FnZShcInVzZXJcIiwgcXVlc3Rpb24pO1xyXG4gICAgdGhpcy5pbnB1dEVsLnZhbHVlID0gXCJcIjtcclxuICAgIHRoaXMuc2VuZEJ1dHRvbkVsLmRpc2FibGVkID0gdHJ1ZTtcclxuICAgIHRoaXMuc2F2ZUJ1dHRvbkVsLmRpc2FibGVkID0gdHJ1ZTtcclxuXHJcbiAgICBjb25zdCBhc3Npc3RhbnRCdWJibGUgPSB0aGlzLnRyYW5zY3JpcHRFbC5jcmVhdGVEaXYoe1xyXG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UgcmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtYXNzaXN0YW50XCJcclxuICAgIH0pO1xyXG4gICAgYXNzaXN0YW50QnViYmxlLmNyZWF0ZURpdih7XHJcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1yb2xlXCIsXHJcbiAgICAgIHRleHQ6IFwiQXNzaXN0YW50XCJcclxuICAgIH0pO1xyXG4gICAgY29uc3QgYXNzaXN0YW50Q29udGVudEVsID0gYXNzaXN0YW50QnViYmxlLmNyZWF0ZURpdih7XHJcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1jb250ZW50XCIsXHJcbiAgICAgIHRleHQ6IFwiXCJcclxuICAgIH0pO1xyXG4gICAgY29uc3QgYXNzaXN0YW50VGhpbmtpbmdXcmFwID0gYXNzaXN0YW50QnViYmxlLmNyZWF0ZURpdih7XHJcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci10aGlua2luZy13cmFwXCJcclxuICAgIH0pO1xyXG4gICAgY29uc3QgYXNzaXN0YW50VGhpbmtpbmdUb2dnbGVFbCA9IGFzc2lzdGFudFRoaW5raW5nV3JhcC5jcmVhdGVFbChcImJ1dHRvblwiLCB7XHJcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci10aGlua2luZy10b2dnbGVcIixcclxuICAgICAgdGV4dDogXCJUaGlua2luZyAoc3RyZWFtaW5nKVwiXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IGFzc2lzdGFudFRoaW5raW5nRWwgPSBhc3Npc3RhbnRUaGlua2luZ1dyYXAuY3JlYXRlRGl2KHtcclxuICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLXRoaW5raW5nXCIsXHJcbiAgICAgIHRleHQ6IFwiXCJcclxuICAgIH0pO1xyXG4gICAgY29uc3QgYXNzaXN0YW50TWV0YUVsID0gYXNzaXN0YW50QnViYmxlLmNyZWF0ZURpdih7XHJcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1tZXRhXCIsXHJcbiAgICAgIHRleHQ6IFwiU3RyZWFtaW5nLi4uXCJcclxuICAgIH0pO1xyXG4gICAgY29uc3QgdGhpbmtpbmdWaWV3ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MudGhpbmtpbmdWaWV3O1xyXG5cclxuICAgIGxldCBzdHJlYW1lZEFuc3dlciA9IFwiXCI7XHJcbiAgICBsZXQgc3RyZWFtZWRUaGlua2luZyA9IFwiXCI7XHJcbiAgICBsZXQgdGhpbmtpbmdFeHBhbmRlZCA9IHRydWU7XHJcblxyXG4gICAgY29uc3Qgc2V0VGhpbmtpbmdFeHBhbmRlZCA9IChleHBhbmRlZDogYm9vbGVhbiwgc3RyZWFtaW5nOiBib29sZWFuKTogdm9pZCA9PiB7XHJcbiAgICAgIHRoaW5raW5nRXhwYW5kZWQgPSBleHBhbmRlZDtcclxuICAgICAgYXNzaXN0YW50VGhpbmtpbmdXcmFwLnRvZ2dsZUNsYXNzKFwiaXMtY29sbGFwc2VkXCIsICF0aGlua2luZ0V4cGFuZGVkKTtcclxuICAgICAgaWYgKHN0cmVhbWVkVGhpbmtpbmcpIHtcclxuICAgICAgICBpZiAoc3RyZWFtaW5nKSB7XHJcbiAgICAgICAgICBhc3Npc3RhbnRUaGlua2luZ1RvZ2dsZUVsLnNldFRleHQoXHJcbiAgICAgICAgICAgIHRoaW5raW5nRXhwYW5kZWQgPyBcIlRoaW5raW5nIChzdHJlYW1pbmcpXCIgOiBcIlRoaW5raW5nIChzdHJlYW1pbmcsIGNvbGxhcHNlZClcIlxyXG4gICAgICAgICAgKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgYXNzaXN0YW50VGhpbmtpbmdUb2dnbGVFbC5zZXRUZXh0KHRoaW5raW5nRXhwYW5kZWQgPyBcIlRoaW5raW5nXCIgOiBcIlRoaW5raW5nIChjb2xsYXBzZWQpXCIpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBhc3Npc3RhbnRUaGlua2luZ1RvZ2dsZUVsLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XHJcbiAgICAgIHNldFRoaW5raW5nRXhwYW5kZWQoIXRoaW5raW5nRXhwYW5kZWQsIGZhbHNlKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgIGlmICh0aGlzLm1vZGUgPT09IFwibm90ZVwiKSB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5wbHVnaW4uc3RyZWFtQ2hhdFdpdGhOb3RlKHRoaXMubm90ZVBhdGgsIHF1ZXN0aW9uLCBtb2RlbEhpc3RvcnksIHtcclxuICAgICAgICAgIG9uQW5zd2VyRGVsdGE6IChkZWx0YSkgPT4ge1xyXG4gICAgICAgICAgICBzdHJlYW1lZEFuc3dlciArPSBkZWx0YTtcclxuICAgICAgICAgICAgYXNzaXN0YW50Q29udGVudEVsLnNldFRleHQoc3RyZWFtZWRBbnN3ZXIpO1xyXG4gICAgICAgICAgICB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxUb3AgPSB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxIZWlnaHQ7XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgb25UaGlua2luZ0RlbHRhOiAoZGVsdGEpID0+IHtcclxuICAgICAgICAgICAgaWYgKHRoaW5raW5nVmlldyA9PT0gXCJoaWRkZW5cIikge1xyXG4gICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgc3RyZWFtZWRUaGlua2luZyArPSBkZWx0YTtcclxuICAgICAgICAgICAgYXNzaXN0YW50VGhpbmtpbmdFbC5zZXRUZXh0KHN0cmVhbWVkVGhpbmtpbmcpO1xyXG4gICAgICAgICAgICBzZXRUaGlua2luZ0V4cGFuZGVkKHRydWUsIHRydWUpO1xyXG4gICAgICAgICAgICB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxUb3AgPSB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxIZWlnaHQ7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IHJlc3VsdC5hbnN3ZXIgfSk7XHJcbiAgICAgICAgY29uc3Qgc291cmNlTWV0YSA9XHJcbiAgICAgICAgICByZXN1bHQuY2h1bmtzLmxlbmd0aCA+IDBcclxuICAgICAgICAgICAgPyBgU291cmNlcyBmcm9tIHRoaXMgbm90ZTogJHtyZXN1bHQuY2h1bmtzLmxlbmd0aH1gXHJcbiAgICAgICAgICAgIDogXCJObyBtYXRjaGluZyBjaHVua3MgZm91bmQgaW4gdGhpcyBub3RlLlwiO1xyXG5cclxuICAgICAgICBhd2FpdCB0aGlzLnJlbmRlckFzc2lzdGFudE1hcmtkb3duKGFzc2lzdGFudENvbnRlbnRFbCwgcmVzdWx0LmFuc3dlciwgcmVzdWx0LmNodW5rcyk7XHJcbiAgICAgICAgYXNzaXN0YW50TWV0YUVsLnNldFRleHQoc291cmNlTWV0YSk7XHJcbiAgICAgICAgdGhpcy5yZW5kZXJDaXRhdGlvbkxpbmtzKGFzc2lzdGFudEJ1YmJsZSwgcmVzdWx0LmFuc3dlciwgcmVzdWx0LmNodW5rcyk7XHJcbiAgICAgICAgdGhpcy5yZW5kZXJSZWZlcmVuY2VkRmlsZXMoYXNzaXN0YW50QnViYmxlLCByZXN1bHQuYW5zd2VyLCByZXN1bHQuY2h1bmtzKTtcclxuICAgICAgfSBlbHNlIHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnBsdWdpbi5zdHJlYW1DaGF0V2l0aFZhdWx0KHF1ZXN0aW9uLCBtb2RlbEhpc3RvcnksIHtcclxuICAgICAgICAgIG9uQW5zd2VyRGVsdGE6IChkZWx0YSkgPT4ge1xyXG4gICAgICAgICAgICBzdHJlYW1lZEFuc3dlciArPSBkZWx0YTtcclxuICAgICAgICAgICAgYXNzaXN0YW50Q29udGVudEVsLnNldFRleHQoc3RyZWFtZWRBbnN3ZXIpO1xyXG4gICAgICAgICAgICB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxUb3AgPSB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxIZWlnaHQ7XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgb25UaGlua2luZ0RlbHRhOiAoZGVsdGEpID0+IHtcclxuICAgICAgICAgICAgaWYgKHRoaW5raW5nVmlldyA9PT0gXCJoaWRkZW5cIikge1xyXG4gICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgc3RyZWFtZWRUaGlua2luZyArPSBkZWx0YTtcclxuICAgICAgICAgICAgYXNzaXN0YW50VGhpbmtpbmdFbC5zZXRUZXh0KHN0cmVhbWVkVGhpbmtpbmcpO1xyXG4gICAgICAgICAgICBzZXRUaGlua2luZ0V4cGFuZGVkKHRydWUsIHRydWUpO1xyXG4gICAgICAgICAgICB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxUb3AgPSB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxIZWlnaHQ7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IHJlc3VsdC5hbnN3ZXIgfSk7XHJcbiAgICAgICAgY29uc3QgbWV0YVBhcnRzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgICAgIG1ldGFQYXJ0cy5wdXNoKFxyXG4gICAgICAgICAgcmVzdWx0LmNodW5rcy5sZW5ndGggPiAwXHJcbiAgICAgICAgICAgID8gYFZhdWx0IHNvdXJjZXMgdXNlZDogJHtyZXN1bHQuY2h1bmtzLmxlbmd0aH1gXHJcbiAgICAgICAgICAgIDogXCJObyBtYXRjaGluZyB2YXVsdCBjaHVua3MgZm91bmQuXCJcclxuICAgICAgICApO1xyXG5cclxuICAgICAgICBhd2FpdCB0aGlzLnJlbmRlckFzc2lzdGFudE1hcmtkb3duKGFzc2lzdGFudENvbnRlbnRFbCwgcmVzdWx0LmFuc3dlciwgcmVzdWx0LmNodW5rcyk7XHJcbiAgICAgICAgYXNzaXN0YW50TWV0YUVsLnNldFRleHQobWV0YVBhcnRzLmpvaW4oXCIgfCBcIikpO1xyXG5cclxuICAgICAgICB0aGlzLnBlbmRpbmdBY3Rpb25zID0gdGhpcy5wcmVwYXJlQWN0aW9uc1dpdGhDaXRhdGlvbkxpbmtzKHJlc3VsdC5wZW5kaW5nQWN0aW9ucywgcmVzdWx0LmNodW5rcyk7XHJcblxyXG4gICAgICAgIHRoaXMucmVuZGVyQ2l0YXRpb25MaW5rcyhhc3Npc3RhbnRCdWJibGUsIHJlc3VsdC5hbnN3ZXIsIHJlc3VsdC5jaHVua3MpO1xyXG4gICAgICAgIHRoaXMucmVuZGVyUmVmZXJlbmNlZEZpbGVzKGFzc2lzdGFudEJ1YmJsZSwgcmVzdWx0LmFuc3dlciwgcmVzdWx0LmNodW5rcyk7XHJcbiAgICAgICAgdGhpcy5yZW5kZXJQZW5kaW5nQWN0aW9ucyhhc3Npc3RhbnRCdWJibGUpO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAodGhpbmtpbmdWaWV3ID09PSBcImhpZGRlblwiIHx8ICFzdHJlYW1lZFRoaW5raW5nKSB7XHJcbiAgICAgICAgYXNzaXN0YW50VGhpbmtpbmdXcmFwLnJlbW92ZSgpO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHNldFRoaW5raW5nRXhwYW5kZWQodGhpbmtpbmdWaWV3ID09PSBcImV4cGFuZGVkXCIsIGZhbHNlKTtcclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgYXNzaXN0YW50TWV0YUVsLnNldFRleHQoXCJGYWlsZWRcIik7XHJcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJTaWRlYmFyIGNoYXQgZmFpbGVkXCIsIGVycm9yKTtcclxuICAgICAgbmV3IE5vdGljZShgQ2hhdCBmYWlsZWQ6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgdGhpcy5zZW5kQnV0dG9uRWwuZGlzYWJsZWQgPSBmYWxzZTtcclxuICAgICAgdGhpcy5zYXZlQnV0dG9uRWwuZGlzYWJsZWQgPSBmYWxzZTtcclxuICAgICAgdGhpcy5pbnB1dEVsLmZvY3VzKCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIHNhdmVDaGF0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdGl0bGUgPSB0aGlzLm1vZGUgPT09IFwibm90ZVwiID8gXCJTaWRlYmFyIE5vdGUgQ2hhdFwiIDogXCJTaWRlYmFyIFZhdWx0IEFnZW50IENoYXRcIjtcclxuICAgICAgY29uc3QgZmlsZSA9IGF3YWl0IHRoaXMucGx1Z2luLnNhdmVDaGF0QXNOb3RlKHRpdGxlLCB0aGlzLm1lc3NhZ2VzKTtcclxuICAgICAgbmV3IE5vdGljZShgQ2hhdCBzYXZlZDogJHtmaWxlLnBhdGh9YCk7XHJcbiAgICAgIGF3YWl0IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWFmKHRydWUpLm9wZW5GaWxlKGZpbGUpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgbmV3IE5vdGljZShgRmFpbGVkIHRvIHNhdmUgY2hhdDogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIG5vcm1hbGl6ZUFzc2lzdGFudE1hcmtkb3duKHRleHQ6IHN0cmluZywgY2h1bmtzOiBOb3RlQ2h1bmtbXSA9IFtdKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IHZhdWx0TmFtZSA9IHRoaXMuYXBwLnZhdWx0LmdldE5hbWUoKTtcclxuICAgIGxldCBvdXRwdXQgPSB0ZXh0O1xyXG4gICAgY29uc3Qgc3R5bGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5jaXRhdGlvblN0eWxlO1xyXG5cclxuICAgIC8vIE5vcm1hbGl6ZSBtb2RlbC1zcGVjaWZpYyBjaXRhdGlvbiB0b2tlbnMgbGlrZSBbNFx1MjAyMEwxMy1MMTZdIC0+IFs0XVxyXG4gICAgb3V0cHV0ID0gb3V0cHV0LnJlcGxhY2UoL1xcWyhcXGQrKVxccypcdTIwMjBbXlxcXV0qXFxdL2csIFwiWyQxXVwiKTtcclxuXHJcbiAgICBjb25zdCBjaXRhdGlvblVyaSA9IChudW1UZXh0OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+IHtcclxuICAgICAgY29uc3QgaWR4ID0gTnVtYmVyLnBhcnNlSW50KG51bVRleHQsIDEwKTtcclxuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSB8fCBpZHggPCAxIHx8IGlkeCA+IGNodW5rcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgfVxyXG5cclxuICAgICAgY29uc3QgcGF0aCA9IGNodW5rc1tpZHggLSAxXT8uZmlsZVBhdGg7XHJcbiAgICAgIGlmICghcGF0aCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICB9XHJcblxyXG4gICAgICByZXR1cm4gYG9ic2lkaWFuOi8vb3Blbj92YXVsdD0ke2VuY29kZVVSSUNvbXBvbmVudCh2YXVsdE5hbWUpfSZmaWxlPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhdGgpfWA7XHJcbiAgICB9O1xyXG5cclxuICAgIGlmIChzdHlsZSA9PT0gXCJwaHJhc2VcIikge1xyXG4gICAgICAvLyBUdXJuIGJvbGQgY2l0ZWQgcGhyYXNlcyBpbnRvIGNsaWNrYWJsZSBwaHJhc2UgbGlua3M6ICoqUmVnaXN0cnkgUmV3cml0ZSoqIFsxXVxyXG4gICAgICBvdXRwdXQgPSBvdXRwdXQucmVwbGFjZShcclxuICAgICAgICAvXFwqXFwqKFteKlxcbl1bXipcXG5dezAsMTIwfT8pXFwqXFwqXFxzKlxcWyhcXGQrKVxcXS9nLFxyXG4gICAgICAgIChmdWxsLCBwaHJhc2U6IHN0cmluZywgbnVtVGV4dDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICBjb25zdCB1cmkgPSBjaXRhdGlvblVyaShudW1UZXh0KTtcclxuICAgICAgICAgIGlmICghdXJpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmdWxsO1xyXG4gICAgICAgICAgfVxyXG5cclxuICAgICAgICAgIHJldHVybiBgKipbJHtwaHJhc2UudHJpbSgpfV0oJHt1cml9KSoqYDtcclxuICAgICAgICB9XHJcbiAgICAgICk7XHJcblxyXG4gICAgICAvLyBUdXJuIHBsYWluIGNpdGVkIHBocmFzZXMgaW50byBjbGlja2FibGUgcGhyYXNlIGxpbmtzOiBSZWdpc3RyeSBSZXdyaXRlIFsxXVxyXG4gICAgICBvdXRwdXQgPSBvdXRwdXQucmVwbGFjZShcclxuICAgICAgICAvKF58W1xccyg+XFwtXHUyMDIyXSkoW0EtWmEtel1bQS1aYS16MC05J1x1MjAxOVxcLV17MSwzMH0oPzpcXHMrW0EtWmEtejAtOSdcdTIwMTlcXC1dezEsMzB9KXswLDV9KVxccypcXFsoXFxkKylcXF0vZ20sXHJcbiAgICAgICAgKGZ1bGwsIHByZWZpeDogc3RyaW5nLCBwaHJhc2U6IHN0cmluZywgbnVtVGV4dDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICBjb25zdCB1cmkgPSBjaXRhdGlvblVyaShudW1UZXh0KTtcclxuICAgICAgICAgIGlmICghdXJpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmdWxsO1xyXG4gICAgICAgICAgfVxyXG5cclxuICAgICAgICAgIHJldHVybiBgJHtwcmVmaXh9WyR7cGhyYXNlLnRyaW0oKX1dKCR7dXJpfSlgO1xyXG4gICAgICAgIH1cclxuICAgICAgKTtcclxuXHJcbiAgICAgIG91dHB1dCA9IG91dHB1dC5yZXBsYWNlKC9cXFsoXFxkKylcXF0vZywgKGZ1bGwsIG51bVRleHQ6IHN0cmluZykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHVyaSA9IGNpdGF0aW9uVXJpKG51bVRleHQpO1xyXG4gICAgICAgIGlmICghdXJpKSB7XHJcbiAgICAgICAgICByZXR1cm4gZnVsbDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiBgW3NvdXJjZSAke251bVRleHR9XSgke3VyaX0pYDtcclxuICAgICAgfSk7XHJcbiAgICAgIHJldHVybiBvdXRwdXQ7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKHN0eWxlID09PSBcInNvdXJjZVwiKSB7XHJcbiAgICAgIG91dHB1dCA9IG91dHB1dC5yZXBsYWNlKC9cXFsoXFxkKylcXF0vZywgKGZ1bGwsIG51bVRleHQ6IHN0cmluZykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHVyaSA9IGNpdGF0aW9uVXJpKG51bVRleHQpO1xyXG4gICAgICAgIGlmICghdXJpKSB7XHJcbiAgICAgICAgICByZXR1cm4gZnVsbDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiBgW3NvdXJjZSAke251bVRleHR9XSgke3VyaX0pYDtcclxuICAgICAgfSk7XHJcbiAgICAgIHJldHVybiBvdXRwdXQ7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gZm9vdGVyIG1vZGU6IHJlbW92ZSBpbmxpbmUgY2l0YXRpb24gbWFya2VycyBhbmQgcmVseSBvbiBmb290ZXIgY2l0YXRpb25zIGxpc3QuXHJcbiAgICBvdXRwdXQgPSBvdXRwdXQucmVwbGFjZSgvXFxbKFxcZCspXFxdL2csIFwiXCIpO1xyXG4gICAgb3V0cHV0ID0gb3V0cHV0LnJlcGxhY2UoL1xcc3syLH0vZywgXCIgXCIpO1xyXG4gICAgb3V0cHV0ID0gb3V0cHV0LnJlcGxhY2UoL1xccysoWy4sOzohP10pL2csIFwiJDFcIik7XHJcblxyXG4gICAgcmV0dXJuIG91dHB1dDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgcmVuZGVyQXNzaXN0YW50TWFya2Rvd24oXHJcbiAgICB0YXJnZXQ6IEhUTUxFbGVtZW50LFxyXG4gICAgdGV4dDogc3RyaW5nLFxyXG4gICAgY2h1bmtzOiBOb3RlQ2h1bmtbXSA9IFtdXHJcbiAgKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0YXJnZXQuZW1wdHkoKTtcclxuICAgIGNvbnN0IG1hcmtkb3duID0gdGhpcy5ub3JtYWxpemVBc3Npc3RhbnRNYXJrZG93bih0ZXh0LCBjaHVua3MpO1xyXG4gICAgYXdhaXQgTWFya2Rvd25SZW5kZXJlci5yZW5kZXJNYXJrZG93bihtYXJrZG93biwgdGFyZ2V0LCB0aGlzLm5vdGVQYXRoIHx8IFwiXCIsIHRoaXMpO1xyXG4gIH1cclxufVxyXG5cclxuY2xhc3MgQXNrUXVlc3Rpb25Nb2RhbCBleHRlbmRzIE1vZGFsIHtcclxuICBwcml2YXRlIG9uU3VibWl0OiAocXVlc3Rpb246IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcclxuXHJcbiAgY29uc3RydWN0b3IoYXBwOiBBcHAsIG9uU3VibWl0OiAocXVlc3Rpb246IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPikge1xyXG4gICAgc3VwZXIoYXBwKTtcclxuICAgIHRoaXMub25TdWJtaXQgPSBvblN1Ym1pdDtcclxuICB9XHJcblxyXG4gIG9uT3BlbigpOiB2b2lkIHtcclxuICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xyXG4gICAgY29udGVudEVsLmVtcHR5KCk7XHJcbiAgICBjb250ZW50RWwuYWRkQ2xhc3MoXCJyYWctb3BlbnJvdXRlci1tb2RhbFwiKTtcclxuXHJcbiAgICBjb250ZW50RWwuY3JlYXRlRWwoXCJoMlwiLCB7IHRleHQ6IFwiQXNrIFdpdGggVmF1bHQgQ29udGV4dFwiIH0pO1xyXG5cclxuICAgIGNvbnN0IGlucHV0ID0gY29udGVudEVsLmNyZWF0ZUVsKFwidGV4dGFyZWFcIiwge1xyXG4gICAgICBhdHRyOiB7IHBsYWNlaG9sZGVyOiBcIkFzayBhIHF1ZXN0aW9uIGFib3V0IHlvdXIgbm90ZXMuLi5cIiB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBidXR0b24gPSBjb250ZW50RWwuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIkFza1wiIH0pO1xyXG4gICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgdGhpcy5vblN1Ym1pdChpbnB1dC52YWx1ZSk7XHJcbiAgICAgICAgdGhpcy5jbG9zZSgpO1xyXG4gICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xyXG4gICAgICAgIG5ldyBOb3RpY2UoYFJlcXVlc3QgZmFpbGVkOiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gKTtcclxuICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgaW5wdXQuZm9jdXMoKTtcclxuICB9XHJcblxyXG4gIG9uQ2xvc2UoKTogdm9pZCB7XHJcbiAgICB0aGlzLmNvbnRlbnRFbC5lbXB0eSgpO1xyXG4gIH1cclxufVxyXG5cclxuY2xhc3MgTW9kZWxTZWFyY2hNb2RhbCBleHRlbmRzIE1vZGFsIHtcclxuICBwcml2YXRlIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbjtcclxuICBwcml2YXRlIG9uU2VsZWN0TW9kZWw6IChtb2RlbElkOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XHJcbiAgcHJpdmF0ZSBtb2RlbHM6IE9wZW5Sb3V0ZXJNb2RlbFtdID0gW107XHJcbiAgcHJpdmF0ZSBxdWVyeSA9IFwiXCI7XHJcbiAgcHJpdmF0ZSBzdGF0dXNFbCE6IEhUTUxFbGVtZW50O1xyXG4gIHByaXZhdGUgbGlzdEVsITogSFRNTEVsZW1lbnQ7XHJcblxyXG4gIGNvbnN0cnVjdG9yKFxyXG4gICAgYXBwOiBBcHAsXHJcbiAgICBwbHVnaW46IFJhZ09wZW5Sb3V0ZXJQbHVnaW4sXHJcbiAgICBvblNlbGVjdE1vZGVsOiAobW9kZWxJZDogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+XHJcbiAgKSB7XHJcbiAgICBzdXBlcihhcHApO1xyXG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcbiAgICB0aGlzLm9uU2VsZWN0TW9kZWwgPSBvblNlbGVjdE1vZGVsO1xyXG4gIH1cclxuXHJcbiAgb25PcGVuKCk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XHJcbiAgICBjb250ZW50RWwuZW1wdHkoKTtcclxuICAgIGNvbnRlbnRFbC5hZGRDbGFzcyhcInJhZy1vcGVucm91dGVyLW1vZGVsLXNlYXJjaC1tb2RhbFwiKTtcclxuXHJcbiAgICBjb250ZW50RWwuY3JlYXRlRWwoXCJoMlwiLCB7IHRleHQ6IFwiU2VhcmNoIE9wZW5Sb3V0ZXIgTW9kZWxzXCIgfSk7XHJcblxyXG4gICAgY29uc3QgY29udHJvbHNFbCA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbW9kZWwtc2VhcmNoLWNvbnRyb2xzXCIgfSk7XHJcblxyXG4gICAgY29uc3QgaW5wdXQgPSBjb250cm9sc0VsLmNyZWF0ZUVsKFwiaW5wdXRcIiwge1xyXG4gICAgICB0eXBlOiBcInNlYXJjaFwiLFxyXG4gICAgICBwbGFjZWhvbGRlcjogXCJTZWFyY2ggbW9kZWwgaWQsIGZvciBleGFtcGxlIG52aWRpYS9uZW1vdHJvbi0zLXN1cGVyLTEyMGItYTEyYjpmcmVlXCJcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IHJlZnJlc2hCdXR0b24gPSBjb250cm9sc0VsLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHsgdGV4dDogXCJSZWZyZXNoXCIgfSk7XHJcblxyXG4gICAgdGhpcy5zdGF0dXNFbCA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbW9kZWwtc2VhcmNoLXN0YXR1c1wiIH0pO1xyXG4gICAgdGhpcy5saXN0RWwgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW1vZGVsLXNlYXJjaC1yZXN1bHRzXCIgfSk7XHJcblxyXG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcclxuICAgICAgdGhpcy5xdWVyeSA9IGlucHV0LnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICB0aGlzLnJlbmRlck1vZGVsTGlzdCgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcmVmcmVzaEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCB0aGlzLmxvYWRNb2RlbHModHJ1ZSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB2b2lkIHRoaXMubG9hZE1vZGVscyhmYWxzZSk7XHJcbiAgICBpbnB1dC5mb2N1cygpO1xyXG4gIH1cclxuXHJcbiAgb25DbG9zZSgpOiB2b2lkIHtcclxuICAgIHRoaXMuY29udGVudEVsLmVtcHR5KCk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIGxvYWRNb2RlbHMoZm9yY2VSZWZyZXNoOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0aGlzLnN0YXR1c0VsLnNldFRleHQoXCJMb2FkaW5nIG1vZGVscy4uLlwiKTtcclxuICAgIHRoaXMubGlzdEVsLmVtcHR5KCk7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgdGhpcy5tb2RlbHMgPSBhd2FpdCB0aGlzLnBsdWdpbi5nZXRPcGVuUm91dGVyTW9kZWxzKGZvcmNlUmVmcmVzaCk7XHJcbiAgICAgIHRoaXMucmVuZGVyTW9kZWxMaXN0KCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICBjb25zb2xlLmVycm9yKFwiRmFpbGVkIHRvIGxvYWQgT3BlblJvdXRlciBtb2RlbHNcIiwgZXJyb3IpO1xyXG4gICAgICB0aGlzLnN0YXR1c0VsLnNldFRleHQoXHJcbiAgICAgICAgYEZhaWxlZCB0byBsb2FkIG1vZGVsczogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YFxyXG4gICAgICApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSByZW5kZXJNb2RlbExpc3QoKTogdm9pZCB7XHJcbiAgICB0aGlzLmxpc3RFbC5lbXB0eSgpO1xyXG5cclxuICAgIGNvbnN0IGZpbHRlcmVkTW9kZWxzID0gdGhpcy5tb2RlbHMuZmlsdGVyKChtb2RlbCkgPT4ge1xyXG4gICAgICBjb25zdCBtb2RlbElkID0gbW9kZWwuaWQudG9Mb3dlckNhc2UoKTtcclxuICAgICAgcmV0dXJuICF0aGlzLnF1ZXJ5IHx8IG1vZGVsSWQuaW5jbHVkZXModGhpcy5xdWVyeSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLnN0YXR1c0VsLnNldFRleHQoYFNob3dpbmcgJHtmaWx0ZXJlZE1vZGVscy5sZW5ndGh9IG9mICR7dGhpcy5tb2RlbHMubGVuZ3RofSBtb2RlbHNgKTtcclxuXHJcbiAgICBpZiAoIWZpbHRlcmVkTW9kZWxzLmxlbmd0aCkge1xyXG4gICAgICB0aGlzLmxpc3RFbC5jcmVhdGVEaXYoe1xyXG4gICAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1tb2RlbC1zZWFyY2gtZW1wdHlcIixcclxuICAgICAgICB0ZXh0OiBcIk5vIG1vZGVscyBtYXRjaCB5b3VyIHNlYXJjaC5cIlxyXG4gICAgICB9KTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGZvciAoY29uc3QgbW9kZWwgb2YgZmlsdGVyZWRNb2RlbHMuc2xpY2UoMCwgMjAwKSkge1xyXG4gICAgICBjb25zdCByb3cgPSB0aGlzLmxpc3RFbC5jcmVhdGVFbChcImJ1dHRvblwiLCB7XHJcbiAgICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLW1vZGVsLXJvd1wiXHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgcm93LmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1tb2RlbC1pZFwiLCB0ZXh0OiBtb2RlbC5pZCB9KTtcclxuXHJcbiAgICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBhd2FpdCB0aGlzLm9uU2VsZWN0TW9kZWwobW9kZWwuaWQpO1xyXG4gICAgICAgICAgbmV3IE5vdGljZShgU2VsZWN0ZWQgbW9kZWw6ICR7bW9kZWwuaWR9YCk7XHJcbiAgICAgICAgICB0aGlzLmNsb3NlKCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoXCJGYWlsZWQgdG8gc2V0IG1vZGVsXCIsIGVycm9yKTtcclxuICAgICAgICAgIG5ldyBOb3RpY2UoYEZhaWxlZCB0byBzZXQgbW9kZWw6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG59XHJcblxyXG5jbGFzcyBSYWdPcGVuUm91dGVyU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xyXG4gIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbjtcclxuXHJcbiAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbikge1xyXG4gICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xyXG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcbiAgfVxyXG5cclxuICBkaXNwbGF5KCk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcclxuICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XHJcblxyXG4gICAgY29udGFpbmVyRWwuY3JlYXRlRWwoXCJoMlwiLCB7IHRleHQ6IFwiUkFHIE9wZW5Sb3V0ZXIgTm90ZXMgU2V0dGluZ3NcIiB9KTtcclxuXHJcbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcclxuICAgICAgLnNldE5hbWUoXCJPcGVuUm91dGVyIEFQSSBrZXlcIilcclxuICAgICAgLnNldERlc2MoXCJVc2VkIHRvIGNhbGwgT3BlblJvdXRlciBjaGF0IGNvbXBsZXRpb24gQVBJLlwiKVxyXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT5cclxuICAgICAgICB0ZXh0XHJcbiAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoXCJzay1vci12MS0uLi5cIilcclxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5KVxyXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xyXG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5ID0gdmFsdWUudHJpbSgpO1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcclxuICAgICAgICAgIH0pXHJcbiAgICAgICk7XHJcblxyXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXHJcbiAgICAgIC5zZXROYW1lKFwiTW9kZWxcIilcclxuICAgICAgLnNldERlc2MoXCJPcGVuUm91dGVyIG1vZGVsIHNsdWcsIGZvciBleGFtcGxlIG9wZW5haS9ncHQtNG8tbWluaS5cIilcclxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XHJcbiAgICAgICAgdGV4dFxyXG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKFwib3BlbmFpL2dwdC00by1taW5pXCIpXHJcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MubW9kZWwpXHJcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsID0gdmFsdWUudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MubW9kZWw7XHJcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xyXG4gICAgICAgICAgfSlcclxuICAgICAgKVxyXG4gICAgICAuYWRkQnV0dG9uKChidXR0b24pID0+XHJcbiAgICAgICAgYnV0dG9uLnNldEJ1dHRvblRleHQoXCJTZWFyY2hcIikub25DbGljaygoKSA9PiB7XHJcbiAgICAgICAgICBuZXcgTW9kZWxTZWFyY2hNb2RhbCh0aGlzLmFwcCwgdGhpcy5wbHVnaW4sIGFzeW5jIChtb2RlbElkKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsID0gbW9kZWxJZDtcclxuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheSgpO1xyXG4gICAgICAgICAgfSkub3BlbigpO1xyXG4gICAgICAgIH0pXHJcbiAgICAgICk7XHJcblxyXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXHJcbiAgICAgIC5zZXROYW1lKFwiTWF4IHJldHJpZXZlZCBjaHVua3NcIilcclxuICAgICAgLnNldERlc2MoXCJOdW1iZXIgb2Ygbm90ZSBjaHVua3Mgc2VudCBhcyBjb250ZXh0LlwiKVxyXG4gICAgICAuYWRkU2xpZGVyKChzbGlkZXIpID0+XHJcbiAgICAgICAgc2xpZGVyXHJcbiAgICAgICAgICAuc2V0TGltaXRzKDEsIDEyLCAxKVxyXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLm1heENodW5rcylcclxuICAgICAgICAgIC5zZXREeW5hbWljVG9vbHRpcCgpXHJcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1heENodW5rcyA9IHZhbHVlO1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcclxuICAgICAgICAgIH0pXHJcbiAgICAgICk7XHJcblxyXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXHJcbiAgICAgIC5zZXROYW1lKFwiQ2h1bmsgc2l6ZVwiKVxyXG4gICAgICAuc2V0RGVzYyhcIkFwcHJveGltYXRlIG51bWJlciBvZiBjaGFyYWN0ZXJzIHBlciBpbmRleGVkIGNodW5rLlwiKVxyXG4gICAgICAuYWRkU2xpZGVyKChzbGlkZXIpID0+XHJcbiAgICAgICAgc2xpZGVyXHJcbiAgICAgICAgICAuc2V0TGltaXRzKDMwMCwgMjAwMCwgNTApXHJcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuY2h1bmtTaXplKVxyXG4gICAgICAgICAgLnNldER5bmFtaWNUb29sdGlwKClcclxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcclxuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuY2h1bmtTaXplID0gdmFsdWU7XHJcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xyXG4gICAgICAgICAgfSlcclxuICAgICAgKTtcclxuXHJcbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcclxuICAgICAgLnNldE5hbWUoXCJBbnN3ZXIgZm9sZGVyXCIpXHJcbiAgICAgIC5zZXREZXNjKFwiRm9sZGVyIHdoZXJlIGdlbmVyYXRlZCBhbnN3ZXIgbm90ZXMgYXJlIHN0b3JlZC5cIilcclxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XHJcbiAgICAgICAgdGV4dFxyXG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKFwiUkFHIEFuc3dlcnNcIilcclxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5hbnN3ZXJGb2xkZXIpXHJcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmFuc3dlckZvbGRlciA9IHZhbHVlLnRyaW0oKTtcclxuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgICB9KVxyXG4gICAgICApO1xyXG5cclxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxyXG4gICAgICAuc2V0TmFtZShcIkNpdGF0aW9uIHN0eWxlXCIpXHJcbiAgICAgIC5zZXREZXNjKFwiSG93IGNpdGF0aW9ucyBhcHBlYXIgaW4gYXNzaXN0YW50IGFuc3dlcnMuXCIpXHJcbiAgICAgIC5hZGREcm9wZG93bigoZHJvcGRvd24pID0+XHJcbiAgICAgICAgZHJvcGRvd25cclxuICAgICAgICAgIC5hZGRPcHRpb24oXCJwaHJhc2VcIiwgXCJQaHJhc2UgbGlua3NcIilcclxuICAgICAgICAgIC5hZGRPcHRpb24oXCJzb3VyY2VcIiwgXCJTb3VyY2UgbGlua3NcIilcclxuICAgICAgICAgIC5hZGRPcHRpb24oXCJmb290ZXJcIiwgXCJGb290ZXIgb25seVwiKVxyXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmNpdGF0aW9uU3R5bGUpXHJcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlOiBcInBocmFzZVwiIHwgXCJzb3VyY2VcIiB8IFwiZm9vdGVyXCIpID0+IHtcclxuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuY2l0YXRpb25TdHlsZSA9IHZhbHVlO1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcclxuICAgICAgICAgIH0pXHJcbiAgICAgICk7XHJcblxyXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXHJcbiAgICAgIC5zZXROYW1lKFwiVGhpbmtpbmcgdmlld1wiKVxyXG4gICAgICAuc2V0RGVzYyhcIkhvdyBtb2RlbCB0aGlua2luZyBpcyBkaXNwbGF5ZWQgaW4gY2hhdCBhbnN3ZXJzLlwiKVxyXG4gICAgICAuYWRkRHJvcGRvd24oKGRyb3Bkb3duKSA9PlxyXG4gICAgICAgIGRyb3Bkb3duXHJcbiAgICAgICAgICAuYWRkT3B0aW9uKFwiY29sbGFwc2VkXCIsIFwiQ29sbGFwc2VkXCIpXHJcbiAgICAgICAgICAuYWRkT3B0aW9uKFwiZXhwYW5kZWRcIiwgXCJFeHBhbmRlZFwiKVxyXG4gICAgICAgICAgLmFkZE9wdGlvbihcImhpZGRlblwiLCBcIkhpZGRlblwiKVxyXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnRoaW5raW5nVmlldylcclxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWU6IFwiY29sbGFwc2VkXCIgfCBcImV4cGFuZGVkXCIgfCBcImhpZGRlblwiKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRoaW5raW5nVmlldyA9IHZhbHVlO1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcclxuICAgICAgICAgIH0pXHJcbiAgICAgICk7XHJcblxyXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXHJcbiAgICAgIC5zZXROYW1lKFwiUmUtaW5kZXggbm90ZXNcIilcclxuICAgICAgLnNldERlc2MoXCJSdW4gaW5kZXhpbmcgYWZ0ZXIgY2hhbmdpbmcgY2h1bmsgc2V0dGluZ3Mgb3Igbm90ZSBjb250ZW50LlwiKVxyXG4gICAgICAuYWRkQnV0dG9uKChidXR0b24pID0+XHJcbiAgICAgICAgYnV0dG9uLnNldEJ1dHRvblRleHQoXCJSZWJ1aWxkIGluZGV4XCIpLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4ucmVidWlsZEluZGV4KCk7XHJcbiAgICAgICAgfSlcclxuICAgICAgKTtcclxuICB9XHJcbn1cclxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxzQkFhTztBQThFUCxJQUFNLG1CQUEwQztBQUFBLEVBQzlDLGtCQUFrQjtBQUFBLEVBQ2xCLE9BQU87QUFBQSxFQUNQLFdBQVc7QUFBQSxFQUNYLFdBQVc7QUFBQSxFQUNYLGNBQWM7QUFBQSxFQUNkLGVBQWU7QUFBQSxFQUNmLGNBQWM7QUFDaEI7QUFFQSxJQUFNLHFCQUFxQjtBQUUzQixJQUFxQixzQkFBckIsY0FBaUQsdUJBQU87QUFBQSxFQUF4RDtBQUFBO0FBRUUscUJBQXlCLENBQUM7QUFDMUIsU0FBUSxhQUFnQyxDQUFDO0FBQ3pDLFNBQVEsc0JBQXNCO0FBQUE7QUFBQSxFQUU5QixNQUFNLFNBQXdCO0FBQzVCLFVBQU0sS0FBSyxhQUFhO0FBRXhCLFNBQUs7QUFBQSxNQUNIO0FBQUEsTUFDQSxDQUFDLFNBQVMsSUFBSSxtQkFBbUIsTUFBTSxJQUFJO0FBQUEsSUFDN0M7QUFFQSxTQUFLLGNBQWMsSUFBSSx3QkFBd0IsS0FBSyxLQUFLLElBQUksQ0FBQztBQUU5RCxTQUFLLFdBQVc7QUFBQSxNQUNkLElBQUk7QUFBQSxNQUNKLE1BQU07QUFBQSxNQUNOLFVBQVUsWUFBWTtBQUNwQixjQUFNLEtBQUssYUFBYTtBQUFBLE1BQzFCO0FBQUEsSUFDRixDQUFDO0FBRUQsU0FBSyxXQUFXO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixVQUFVLE1BQU07QUFDZCxZQUFJLGlCQUFpQixLQUFLLEtBQUssT0FBTyxhQUFhO0FBQ2pELGdCQUFNLEtBQUssZUFBZSxRQUFRO0FBQUEsUUFDcEMsQ0FBQyxFQUFFLEtBQUs7QUFBQSxNQUNWO0FBQUEsSUFDRixDQUFDO0FBRUQsU0FBSyxXQUFXO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixVQUFVLFlBQVk7QUFDcEIsY0FBTSxhQUFhLEtBQUssSUFBSSxVQUFVLGNBQWM7QUFDcEQsWUFBSSxDQUFDLGNBQWMsV0FBVyxjQUFjLE1BQU07QUFDaEQsY0FBSSx1QkFBTyw2QkFBNkI7QUFDeEM7QUFBQSxRQUNGO0FBRUEsY0FBTSxLQUFLLGdCQUFnQixRQUFRLFdBQVcsSUFBSTtBQUFBLE1BQ3BEO0FBQUEsSUFDRixDQUFDO0FBRUQsU0FBSyxXQUFXO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixVQUFVLFlBQVk7QUFDcEIsY0FBTSxLQUFLLGdCQUFnQixPQUFPO0FBQUEsTUFDcEM7QUFBQSxJQUNGLENBQUM7QUFFRCxVQUFNLEtBQUssYUFBYTtBQUFBLEVBQzFCO0FBQUEsRUFFQSxNQUFNLGVBQThCO0FBQ2xDLFNBQUssV0FBVyxPQUFPLE9BQU8sQ0FBQyxHQUFHLGtCQUFrQixNQUFNLEtBQUssU0FBUyxDQUFDO0FBQ3pFLFNBQUssU0FBUyxtQkFBbUIsS0FBSyxTQUFTLGlCQUFpQixLQUFLO0FBQ3JFLFNBQUssU0FBUyxRQUFRLEtBQUssU0FBUyxNQUFNLEtBQUssS0FBSyxpQkFBaUI7QUFBQSxFQUN2RTtBQUFBLEVBRUEsTUFBTSxlQUE4QjtBQUNsQyxVQUFNLEtBQUssU0FBUyxLQUFLLFFBQVE7QUFBQSxFQUNuQztBQUFBLEVBRUEsV0FBaUI7QUFDZixTQUFLLFlBQVksQ0FBQztBQUNsQixTQUFLLElBQUksVUFDTixnQkFBZ0Isa0JBQWtCLEVBQ2xDLFFBQVEsQ0FBQyxTQUFTLEtBQUssT0FBTyxDQUFDO0FBQUEsRUFDcEM7QUFBQSxFQUVBLE1BQWMsZ0JBQWdCLE1BQXdCLFVBQWtDO0FBQ3RGLFVBQU0sT0FBTyxLQUFLLElBQUksVUFBVSxhQUFhLEtBQUssS0FBSyxLQUFLLElBQUksVUFBVSxhQUFhLElBQUk7QUFDM0YsUUFBSSxDQUFDLE1BQU07QUFDVCxVQUFJLHVCQUFPLDhCQUE4QjtBQUN6QztBQUFBLElBQ0Y7QUFFQSxVQUFNLEtBQUssYUFBYTtBQUFBLE1BQ3RCLE1BQU07QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSLE9BQU87QUFBQSxRQUNMO0FBQUEsUUFDQSxVQUFVLFlBQVk7QUFBQSxNQUN4QjtBQUFBLElBQ0YsQ0FBQztBQUNELFNBQUssSUFBSSxVQUFVLFdBQVcsSUFBSTtBQUFBLEVBQ3BDO0FBQUEsRUFFUSxtQkFBMkI7QUFDakMsVUFBTSxNQUFNLEtBQUssU0FBUyxpQkFBaUIsS0FBSztBQUNoRCxRQUFJLENBQUMsS0FBSztBQUNSLFlBQU0sSUFBSSxNQUFNLHVEQUF1RDtBQUFBLElBQ3pFO0FBRUEsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLE1BQU0sb0JBQW9CLGVBQWUsT0FBbUM7QUFDMUUsVUFBTSxlQUNKLEtBQUssV0FBVyxTQUFTLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxzQkFBc0IsS0FBSyxLQUFLO0FBRWxGLFFBQUksQ0FBQyxnQkFBZ0IsY0FBYztBQUNqQyxhQUFPLEtBQUs7QUFBQSxJQUNkO0FBRUEsVUFBTSxVQUFrQztBQUFBLE1BQ3RDLGdCQUFnQjtBQUFBLE1BQ2hCLGdCQUFnQjtBQUFBLE1BQ2hCLFdBQVc7QUFBQSxJQUNiO0FBRUEsUUFBSSxLQUFLLFNBQVMsaUJBQWlCLEtBQUssR0FBRztBQUN6QyxjQUFRLGdCQUFnQixVQUFVLEtBQUssU0FBUyxpQkFBaUIsS0FBSyxDQUFDO0FBQUEsSUFDekU7QUFFQSxVQUFNLFdBQVcsVUFBTSw0QkFBVztBQUFBLE1BQ2hDLEtBQUs7QUFBQSxNQUNMLFFBQVE7QUFBQSxNQUNSO0FBQUEsSUFDRixDQUFDO0FBRUQsVUFBTSxZQUFZLE1BQU0sUUFBUSxTQUFTLE1BQU0sSUFBSSxJQUFJLFNBQVMsS0FBSyxPQUFPLENBQUM7QUFDN0UsVUFBTSxTQUFTLFVBQ1osSUFBSSxDQUFDLFNBQTBDO0FBQzlDLFVBQUksQ0FBQyxRQUFRLE9BQU8sU0FBUyxVQUFVO0FBQ3JDLGVBQU87QUFBQSxNQUNUO0FBRUEsWUFBTSxNQUFNO0FBQ1osWUFBTSxLQUFLLE9BQU8sSUFBSSxPQUFPLFdBQVcsSUFBSSxLQUFLO0FBQ2pELFVBQUksQ0FBQyxJQUFJO0FBQ1AsZUFBTztBQUFBLE1BQ1Q7QUFFQSxhQUFPO0FBQUEsUUFDTDtBQUFBLFFBQ0EsTUFBTSxPQUFPLElBQUksU0FBUyxXQUFXLElBQUksT0FBTztBQUFBLFFBQ2hELGFBQWEsT0FBTyxJQUFJLGdCQUFnQixXQUFXLElBQUksY0FBYztBQUFBLFFBQ3JFLGVBQ0UsT0FBTyxJQUFJLG1CQUFtQixXQUFXLElBQUksaUJBQWlCO0FBQUEsTUFDbEU7QUFBQSxJQUNGLENBQUMsRUFDQSxPQUFPLENBQUMsVUFBNEQsUUFBUSxLQUFLLENBQUMsRUFDbEYsS0FBSyxDQUFDLEdBQW9CLE1BQXVCLEVBQUUsR0FBRyxjQUFjLEVBQUUsRUFBRSxDQUFDO0FBRTVFLFNBQUssYUFBYTtBQUNsQixTQUFLLHNCQUFzQixLQUFLLElBQUk7QUFDcEMsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLE1BQWMsZUFBZSxVQUFpQztBQUM1RCxRQUFJLENBQUMsU0FBUyxLQUFLLEdBQUc7QUFDcEIsVUFBSSx1QkFBTywyQkFBMkI7QUFDdEM7QUFBQSxJQUNGO0FBRUEsUUFBSSxDQUFDLEtBQUssU0FBUyxpQkFBaUIsS0FBSyxHQUFHO0FBQzFDLFVBQUksdUJBQU8sdURBQXVEO0FBQ2xFO0FBQUEsSUFDRjtBQUVBLFFBQUksQ0FBQyxLQUFLLFVBQVUsUUFBUTtBQUMxQixZQUFNLEtBQUssYUFBYTtBQUFBLElBQzFCO0FBRUEsVUFBTSxZQUFZLEtBQUssdUJBQXVCLFFBQVE7QUFDdEQsVUFBTSxTQUFTLE1BQU0sS0FBSyxnQkFBZ0IsVUFBVSxTQUFTO0FBQzdELFVBQU0sY0FBYyxNQUFNLEtBQUssZ0JBQWdCLFVBQVUsUUFBUSxTQUFTO0FBRTFFLFVBQU0sS0FBSyxJQUFJLFVBQVUsUUFBUSxJQUFJLEVBQUUsU0FBUyxXQUFXO0FBQzNELFFBQUksdUJBQU8sbUJBQW1CLFlBQVksSUFBSSxFQUFFO0FBQUEsRUFDbEQ7QUFBQSxFQUVRLFNBQVMsT0FBeUI7QUFDeEMsV0FBTyxNQUNKLFlBQVksRUFDWixRQUFRLGdCQUFnQixHQUFHLEVBQzNCLE1BQU0sS0FBSyxFQUNYLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0FBQUEsRUFDL0I7QUFBQSxFQUVRLGdCQUFnQixNQUFjLFdBQTZCO0FBQ2pFLFVBQU0sU0FBbUIsQ0FBQztBQUMxQixVQUFNLGFBQWEsS0FDaEIsTUFBTSxRQUFRLEVBQ2QsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFDbkIsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUM7QUFFN0IsUUFBSSxVQUFVO0FBRWQsZUFBVyxhQUFhLFlBQVk7QUFDbEMsVUFBSSxRQUFRLFNBQVMsVUFBVSxTQUFTLEtBQUssV0FBVztBQUN0RCxrQkFBVSxVQUFVLEdBQUcsT0FBTztBQUFBO0FBQUEsRUFBTyxTQUFTLEtBQUs7QUFDbkQ7QUFBQSxNQUNGO0FBRUEsVUFBSSxTQUFTO0FBQ1gsZUFBTyxLQUFLLE9BQU87QUFBQSxNQUNyQjtBQUVBLFVBQUksVUFBVSxVQUFVLFdBQVc7QUFDakMsa0JBQVU7QUFBQSxNQUNaLE9BQU87QUFDTCxjQUFNLFlBQVksS0FBSyxVQUFVLFdBQVcsU0FBUztBQUNyRCxlQUFPLEtBQUssR0FBRyxVQUFVLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFDckMsa0JBQVUsVUFBVSxVQUFVLFNBQVMsQ0FBQztBQUFBLE1BQzFDO0FBQUEsSUFDRjtBQUVBLFFBQUksU0FBUztBQUNYLGFBQU8sS0FBSyxPQUFPO0FBQUEsSUFDckI7QUFFQSxXQUFPO0FBQUEsRUFDVDtBQUFBLEVBRVEsVUFBVSxNQUFjLFdBQTZCO0FBQzNELFVBQU0sU0FBbUIsQ0FBQztBQUMxQixRQUFJLFFBQVE7QUFFWixXQUFPLFFBQVEsS0FBSyxRQUFRO0FBQzFCLGFBQU8sS0FBSyxLQUFLLE1BQU0sT0FBTyxRQUFRLFNBQVMsQ0FBQztBQUNoRCxlQUFTO0FBQUEsSUFDWDtBQUVBLFdBQU87QUFBQSxFQUNUO0FBQUEsRUFFQSxNQUFNLGVBQThCO0FBQ2xDLFVBQU0sUUFBUSxLQUFLLElBQUksTUFBTSxpQkFBaUI7QUFDOUMsVUFBTSxTQUFzQixDQUFDO0FBRTdCLGVBQVcsUUFBUSxPQUFPO0FBQ3hCLFVBQUk7QUFDRixjQUFNLFVBQVUsTUFBTSxLQUFLLElBQUksTUFBTSxXQUFXLElBQUk7QUFDcEQsY0FBTSxRQUFRLEtBQUssZ0JBQWdCLFNBQVMsS0FBSyxTQUFTLFNBQVM7QUFFbkUsbUJBQVcsYUFBYSxPQUFPO0FBQzdCLGdCQUFNLFNBQVMsS0FBSyxTQUFTLFNBQVM7QUFDdEMsY0FBSSxDQUFDLE9BQU8sUUFBUTtBQUNsQjtBQUFBLFVBQ0Y7QUFFQSxpQkFBTyxLQUFLO0FBQUEsWUFDVixVQUFVLEtBQUs7QUFBQSxZQUNmO0FBQUEsWUFDQTtBQUFBLFVBQ0YsQ0FBQztBQUFBLFFBQ0g7QUFBQSxNQUNGLFNBQVMsT0FBTztBQUNkLGdCQUFRLE1BQU0sbUJBQW1CLEtBQUssSUFBSSxJQUFJLEtBQUs7QUFBQSxNQUNyRDtBQUFBLElBQ0Y7QUFFQSxTQUFLLFlBQVk7QUFDakIsUUFBSSx1QkFBTyxXQUFXLE1BQU0sTUFBTSxlQUFlLE9BQU8sTUFBTSxVQUFVO0FBQUEsRUFDMUU7QUFBQSxFQUVRLHVCQUF1QixVQUErQjtBQUM1RCxVQUFNLGNBQWMsS0FBSyxTQUFTLFFBQVE7QUFDMUMsUUFBSSxDQUFDLFlBQVksUUFBUTtBQUN2QixhQUFPLENBQUM7QUFBQSxJQUNWO0FBRUEsVUFBTSxTQUFTLEtBQUssVUFDakIsSUFBSSxDQUFDLFVBQVU7QUFDZCxZQUFNLFdBQVcsSUFBSSxJQUFJLE1BQU0sTUFBTTtBQUNyQyxVQUFJLFFBQVE7QUFFWixpQkFBVyxTQUFTLGFBQWE7QUFDL0IsWUFBSSxTQUFTLElBQUksS0FBSyxHQUFHO0FBQ3ZCLG1CQUFTO0FBQUEsUUFDWDtBQUFBLE1BQ0Y7QUFHQSxZQUFNLGtCQUFrQixRQUFRLEtBQUssS0FBSyxNQUFNLE9BQU8sTUFBTTtBQUM3RCxhQUFPLEVBQUUsT0FBTyxPQUFPLGdCQUFnQjtBQUFBLElBQ3pDLENBQUMsRUFDQSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxFQUN6QixLQUFLLENBQUMsR0FBRyxNQUFNLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFDaEMsTUFBTSxHQUFHLEtBQUssU0FBUyxTQUFTLEVBQ2hDLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSztBQUVyQixXQUFPO0FBQUEsRUFDVDtBQUFBLEVBRVEsOEJBQThCLFVBQWtCLFVBQStCO0FBQ3JGLFVBQU0sY0FBYyxLQUFLLFNBQVMsUUFBUTtBQUMxQyxRQUFJLENBQUMsWUFBWSxRQUFRO0FBQ3ZCLGFBQU8sQ0FBQztBQUFBLElBQ1Y7QUFFQSxVQUFNLFNBQVMsS0FBSyxVQUNqQixPQUFPLENBQUMsVUFBVSxNQUFNLGFBQWEsUUFBUSxFQUM3QyxJQUFJLENBQUMsVUFBVTtBQUNkLFlBQU0sV0FBVyxJQUFJLElBQUksTUFBTSxNQUFNO0FBQ3JDLFVBQUksUUFBUTtBQUVaLGlCQUFXLFNBQVMsYUFBYTtBQUMvQixZQUFJLFNBQVMsSUFBSSxLQUFLLEdBQUc7QUFDdkIsbUJBQVM7QUFBQSxRQUNYO0FBQUEsTUFDRjtBQUVBLFlBQU0sa0JBQWtCLFFBQVEsS0FBSyxLQUFLLE1BQU0sT0FBTyxNQUFNO0FBQzdELGFBQU8sRUFBRSxPQUFPLE9BQU8sZ0JBQWdCO0FBQUEsSUFDekMsQ0FBQyxFQUNBLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxDQUFDLEVBQ3pCLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUNoQyxNQUFNLEdBQUcsS0FBSyxTQUFTLFNBQVMsRUFDaEMsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLO0FBRXJCLFdBQU87QUFBQSxFQUNUO0FBQUEsRUFFQSxNQUFjLDRCQUNaLGNBQ0EsVUFDaUI7QUFDakIsVUFBTSxTQUFTLEtBQUssaUJBQWlCO0FBRXJDLFVBQU0sV0FBVyxVQUFNLDRCQUFXO0FBQUEsTUFDaEMsS0FBSztBQUFBLE1BQ0wsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLFFBQ1AsZUFBZSxVQUFVLE1BQU07QUFBQSxRQUMvQixnQkFBZ0I7QUFBQSxRQUNoQixnQkFBZ0I7QUFBQSxRQUNoQixXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0EsTUFBTSxLQUFLLFVBQVU7QUFBQSxRQUNuQixPQUFPLEtBQUssU0FBUztBQUFBLFFBQ3JCLFVBQVU7QUFBQSxVQUNSLEVBQUUsTUFBTSxVQUFVLFNBQVMsYUFBYTtBQUFBLFVBQ3hDLEdBQUcsU0FBUyxJQUFJLENBQUMsU0FBUyxFQUFFLE1BQU0sSUFBSSxNQUFNLFNBQVMsSUFBSSxRQUFRLEVBQUU7QUFBQSxRQUNyRTtBQUFBLFFBQ0EsYUFBYTtBQUFBLE1BQ2YsQ0FBQztBQUFBLElBQ0gsQ0FBQztBQUVELFVBQU0sU0FBUyxTQUFTLE1BQU0sVUFBVSxDQUFDLEdBQUcsU0FBUztBQUNyRCxRQUFJLENBQUMsVUFBVSxPQUFPLFdBQVcsVUFBVTtBQUN6QyxZQUFNLElBQUksTUFBTSw2Q0FBNkM7QUFBQSxJQUMvRDtBQUVBLFdBQU87QUFBQSxFQUNUO0FBQUEsRUFFQSxNQUFNLHNCQUFzQixVQUEwQztBQUNwRSxRQUFJLENBQUMsU0FBUyxRQUFRO0FBQ3BCLGFBQU87QUFBQSxJQUNUO0FBRUEsVUFBTSxhQUFhLFNBQ2hCLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxTQUFTLFNBQVMsU0FBUyxXQUFXLEtBQUssSUFBSSxPQUFPLEVBQUUsRUFDNUUsS0FBSyxNQUFNO0FBRWQsVUFBTSxVQUFVLE1BQU0sS0FBSztBQUFBLE1BQ3pCO0FBQUEsTUFDQSxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsV0FBVyxDQUFDO0FBQUEsSUFDeEM7QUFFQSxXQUFPLFFBQVEsS0FBSztBQUFBLEVBQ3RCO0FBQUEsRUFFQSxNQUFjLDZCQUNaLGNBQ0EsVUFDQSxXQUEyQixDQUFDLEdBQ3NCO0FBQ2xELFVBQU0sU0FBUyxLQUFLLGlCQUFpQjtBQUVyQyxVQUFNLE9BQU87QUFBQSxNQUNYLE9BQU8sS0FBSyxTQUFTO0FBQUEsTUFDckIsVUFBVTtBQUFBLFFBQ1IsRUFBRSxNQUFNLFVBQVUsU0FBUyxhQUFhO0FBQUEsUUFDeEMsR0FBRyxTQUFTLElBQUksQ0FBQyxTQUFTLEVBQUUsTUFBTSxJQUFJLE1BQU0sU0FBUyxJQUFJLFFBQVEsRUFBRTtBQUFBLE1BQ3JFO0FBQUEsTUFDQSxhQUFhO0FBQUEsTUFDYixRQUFRO0FBQUEsTUFDUixtQkFBbUI7QUFBQSxJQUNyQjtBQUVBLFVBQU0sV0FBVyxNQUFNLE1BQU0saURBQWlEO0FBQUEsTUFDNUUsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLFFBQ1AsZUFBZSxVQUFVLE1BQU07QUFBQSxRQUMvQixnQkFBZ0I7QUFBQSxRQUNoQixnQkFBZ0I7QUFBQSxRQUNoQixXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0EsTUFBTSxLQUFLLFVBQVUsSUFBSTtBQUFBLElBQzNCLENBQUM7QUFFRCxRQUFJLENBQUMsU0FBUyxJQUFJO0FBQ2hCLFVBQUksVUFBVTtBQUNkLFVBQUk7QUFDRixtQkFBVyxNQUFNLFNBQVMsS0FBSyxHQUFHLE1BQU0sR0FBRyxHQUFHO0FBQUEsTUFDaEQsUUFBUTtBQUNOLGtCQUFVO0FBQUEsTUFDWjtBQUVBLFVBQUksU0FBUyxXQUFXLEtBQUs7QUFDM0IsY0FBTSxJQUFJLE1BQU0sNEVBQTRFO0FBQUEsTUFDOUY7QUFFQSxZQUFNLElBQUk7QUFBQSxRQUNSLDhCQUE4QixTQUFTLE1BQU0sR0FBRyxTQUFTLGFBQWEsSUFBSSxTQUFTLFVBQVUsS0FBSyxFQUFFLElBQUksVUFBVSxLQUFLLE9BQU8sS0FBSyxFQUFFO0FBQUEsTUFDdkk7QUFBQSxJQUNGO0FBRUEsUUFBSSxDQUFDLFNBQVMsTUFBTTtBQUNsQixZQUFNLGlCQUFpQixNQUFNLEtBQUssNEJBQTRCLGNBQWMsUUFBUTtBQUNwRixlQUFTLGdCQUFnQixjQUFjO0FBQ3ZDLGFBQU8sRUFBRSxXQUFXLGdCQUFnQixVQUFVLEdBQUc7QUFBQSxJQUNuRDtBQUVBLFVBQU0sU0FBUyxTQUFTLEtBQUssVUFBVTtBQUN2QyxVQUFNLFVBQVUsSUFBSSxZQUFZO0FBQ2hDLFFBQUksV0FBVztBQUNmLFFBQUksWUFBWTtBQUNoQixRQUFJLFdBQVc7QUFFZixXQUFPLE1BQU07QUFDWCxZQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUs7QUFDMUMsVUFBSSxNQUFNO0FBQ1I7QUFBQSxNQUNGO0FBRUEsa0JBQVksUUFBUSxPQUFPLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUNsRCxZQUFNLFFBQVEsU0FBUyxNQUFNLElBQUk7QUFDakMsaUJBQVcsTUFBTSxJQUFJLEtBQUs7QUFFMUIsaUJBQVcsUUFBUSxPQUFPO0FBQ3hCLGNBQU0sVUFBVSxLQUFLLEtBQUs7QUFDMUIsWUFBSSxDQUFDLFFBQVEsV0FBVyxPQUFPLEdBQUc7QUFDaEM7QUFBQSxRQUNGO0FBRUEsY0FBTSxjQUFjLFFBQVEsTUFBTSxDQUFDLEVBQUUsS0FBSztBQUMxQyxZQUFJLENBQUMsZUFBZSxnQkFBZ0IsVUFBVTtBQUM1QztBQUFBLFFBQ0Y7QUFFQSxZQUFJO0FBQ0YsZ0JBQU0sVUFBVSxLQUFLLE1BQU0sV0FBVztBQVV0QyxnQkFBTSxRQUFRLFFBQVEsVUFBVSxDQUFDLEdBQUc7QUFDcEMsZ0JBQU0sZUFBZSxPQUFPLE9BQU8sWUFBWSxXQUFXLE1BQU0sVUFBVTtBQUMxRSxnQkFBTSxpQkFDSixPQUFPLE9BQU8sY0FBYyxXQUN4QixNQUFNLFlBQ04sT0FBTyxPQUFPLHNCQUFzQixXQUNsQyxNQUFNLG9CQUNOO0FBRVIsY0FBSSxjQUFjO0FBQ2hCLHlCQUFhO0FBQ2IscUJBQVMsZ0JBQWdCLFlBQVk7QUFBQSxVQUN2QztBQUVBLGNBQUksZ0JBQWdCO0FBQ2xCLHdCQUFZO0FBQ1oscUJBQVMsa0JBQWtCLGNBQWM7QUFBQSxVQUMzQztBQUFBLFFBQ0YsUUFBUTtBQUNOO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsV0FBTyxFQUFFLFdBQVcsU0FBUztBQUFBLEVBQy9CO0FBQUEsRUFFQSxNQUFjLGdCQUFnQixVQUFrQixlQUE2QztBQUMzRixVQUFNLGNBQWMsY0FDakIsSUFBSSxDQUFDLE9BQU8sVUFBVTtBQUNyQixhQUFPLFVBQVUsUUFBUSxDQUFDLEtBQUssTUFBTSxRQUFRO0FBQUEsRUFBTyxNQUFNLFNBQVM7QUFBQSxJQUNyRSxDQUFDLEVBQ0EsS0FBSyxhQUFhO0FBRXJCLFVBQU0sZUFDSjtBQUVGLFVBQU0sYUFBYTtBQUFBLE1BQ2pCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxlQUFlO0FBQUEsTUFDZjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBRVgsV0FBTyxLQUFLLDRCQUE0QixjQUFjLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxXQUFXLENBQUMsQ0FBQztBQUFBLEVBQy9GO0FBQUEsRUFFQSxNQUFNLGFBQ0osY0FDQSxVQUNBLFNBQ2tEO0FBQ2xELFFBQUksQ0FBQyxTQUFTLEtBQUssR0FBRztBQUNwQixZQUFNLElBQUksTUFBTSwyQkFBMkI7QUFBQSxJQUM3QztBQUVBLFFBQUksQ0FBQyxLQUFLLFNBQVMsaUJBQWlCLEtBQUssR0FBRztBQUMxQyxZQUFNLElBQUksTUFBTSx1REFBdUQ7QUFBQSxJQUN6RTtBQUVBLFFBQUksQ0FBQyxLQUFLLFVBQVUsUUFBUTtBQUMxQixZQUFNLEtBQUssYUFBYTtBQUFBLElBQzFCO0FBRUEsVUFBTSxZQUFZLEtBQUssOEJBQThCLFVBQVUsWUFBWTtBQUMzRSxVQUFNLGNBQWMsVUFDakIsSUFBSSxDQUFDLE9BQU8sVUFBVSxVQUFVLFFBQVEsQ0FBQyxLQUFLLE1BQU0sUUFBUTtBQUFBLEVBQU8sTUFBTSxTQUFTLEVBQUUsRUFDcEYsS0FBSyxhQUFhO0FBRXJCLFVBQU0sZUFDSjtBQUVGLFVBQU0sYUFBYTtBQUFBLE1BQ2pCLGlCQUFpQixZQUFZO0FBQUEsTUFDN0I7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxlQUFlO0FBQUEsTUFDZjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBRVgsVUFBTSxpQkFBaUIsUUFBUSxNQUFNLEVBQUU7QUFDdkMsVUFBTSxTQUFTLE1BQU0sS0FBSyw0QkFBNEIsY0FBYztBQUFBLE1BQ2xFLEdBQUc7QUFBQSxNQUNILEVBQUUsTUFBTSxRQUFRLFNBQVMsV0FBVztBQUFBLElBQ3RDLENBQUM7QUFFRCxXQUFPLEVBQUUsUUFBUSxRQUFRLFVBQVU7QUFBQSxFQUNyQztBQUFBLEVBRUEsTUFBTSxtQkFDSixjQUNBLFVBQ0EsU0FDQSxXQUEyQixDQUFDLEdBQ3dDO0FBQ3BFLFFBQUksQ0FBQyxTQUFTLEtBQUssR0FBRztBQUNwQixZQUFNLElBQUksTUFBTSwyQkFBMkI7QUFBQSxJQUM3QztBQUVBLFFBQUksQ0FBQyxLQUFLLFNBQVMsaUJBQWlCLEtBQUssR0FBRztBQUMxQyxZQUFNLElBQUksTUFBTSx1REFBdUQ7QUFBQSxJQUN6RTtBQUVBLFFBQUksQ0FBQyxLQUFLLFVBQVUsUUFBUTtBQUMxQixZQUFNLEtBQUssYUFBYTtBQUFBLElBQzFCO0FBRUEsVUFBTSxZQUFZLEtBQUssOEJBQThCLFVBQVUsWUFBWTtBQUMzRSxVQUFNLGNBQWMsVUFDakIsSUFBSSxDQUFDLE9BQU8sVUFBVSxVQUFVLFFBQVEsQ0FBQyxLQUFLLE1BQU0sUUFBUTtBQUFBLEVBQU8sTUFBTSxTQUFTLEVBQUUsRUFDcEYsS0FBSyxhQUFhO0FBRXJCLFVBQU0sZUFDSjtBQUVGLFVBQU0sYUFBYTtBQUFBLE1BQ2pCLGlCQUFpQixZQUFZO0FBQUEsTUFDN0I7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxlQUFlO0FBQUEsTUFDZjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBRVgsVUFBTSxpQkFBaUIsUUFBUSxNQUFNLEVBQUU7QUFDdkMsVUFBTSxXQUFXLE1BQU0sS0FBSztBQUFBLE1BQzFCO0FBQUEsTUFDQSxDQUFDLEdBQUcsZ0JBQWdCLEVBQUUsTUFBTSxRQUFRLFNBQVMsV0FBVyxDQUFDO0FBQUEsTUFDekQ7QUFBQSxJQUNGO0FBRUEsV0FBTyxFQUFFLFFBQVEsU0FBUyxXQUFXLFFBQVEsV0FBVyxVQUFVLFNBQVMsU0FBUztBQUFBLEVBQ3RGO0FBQUEsRUFFQSxNQUFNLGNBQ0osVUFDQSxTQUNpRjtBQUNqRixRQUFJLENBQUMsU0FBUyxLQUFLLEdBQUc7QUFDcEIsWUFBTSxJQUFJLE1BQU0sMkJBQTJCO0FBQUEsSUFDN0M7QUFFQSxRQUFJLENBQUMsS0FBSyxTQUFTLGlCQUFpQixLQUFLLEdBQUc7QUFDMUMsWUFBTSxJQUFJLE1BQU0sdURBQXVEO0FBQUEsSUFDekU7QUFFQSxRQUFJLENBQUMsS0FBSyxVQUFVLFFBQVE7QUFDMUIsWUFBTSxLQUFLLGFBQWE7QUFBQSxJQUMxQjtBQUVBLFVBQU0sWUFBWSxLQUFLLHVCQUF1QixRQUFRO0FBQ3RELFVBQU0sY0FBYyxVQUNqQixJQUFJLENBQUMsT0FBTyxVQUFVLFVBQVUsUUFBUSxDQUFDLEtBQUssTUFBTSxRQUFRO0FBQUEsRUFBTyxNQUFNLFNBQVMsRUFBRSxFQUNwRixLQUFLLGFBQWE7QUFFckIsVUFBTSxlQUFlO0FBQUEsTUFDbkI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxHQUFHO0FBRVYsVUFBTSxhQUFhO0FBQUEsTUFDakI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLGVBQWU7QUFBQSxNQUNmO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFFWCxVQUFNLGlCQUFpQixRQUFRLE1BQU0sRUFBRTtBQUN2QyxVQUFNLFlBQVksTUFBTSxLQUFLLDRCQUE0QixjQUFjO0FBQUEsTUFDckUsR0FBRztBQUFBLE1BQ0gsRUFBRSxNQUFNLFFBQVEsU0FBUyxXQUFXO0FBQUEsSUFDdEMsQ0FBQztBQUVELFVBQU0sRUFBRSxZQUFZLFFBQVEsSUFBSSxLQUFLLG9CQUFvQixTQUFTO0FBRWxFLFdBQU87QUFBQSxNQUNMLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGdCQUFnQjtBQUFBLElBQ2xCO0FBQUEsRUFDRjtBQUFBLEVBRUEsTUFBTSxvQkFDSixVQUNBLFNBQ0EsV0FBMkIsQ0FBQyxHQUN1RTtBQUNuRyxRQUFJLENBQUMsU0FBUyxLQUFLLEdBQUc7QUFDcEIsWUFBTSxJQUFJLE1BQU0sMkJBQTJCO0FBQUEsSUFDN0M7QUFFQSxRQUFJLENBQUMsS0FBSyxTQUFTLGlCQUFpQixLQUFLLEdBQUc7QUFDMUMsWUFBTSxJQUFJLE1BQU0sdURBQXVEO0FBQUEsSUFDekU7QUFFQSxRQUFJLENBQUMsS0FBSyxVQUFVLFFBQVE7QUFDMUIsWUFBTSxLQUFLLGFBQWE7QUFBQSxJQUMxQjtBQUVBLFVBQU0sWUFBWSxLQUFLLHVCQUF1QixRQUFRO0FBQ3RELFVBQU0sY0FBYyxVQUNqQixJQUFJLENBQUMsT0FBTyxVQUFVLFVBQVUsUUFBUSxDQUFDLEtBQUssTUFBTSxRQUFRO0FBQUEsRUFBTyxNQUFNLFNBQVMsRUFBRSxFQUNwRixLQUFLLGFBQWE7QUFFckIsVUFBTSxlQUFlO0FBQUEsTUFDbkI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxHQUFHO0FBRVYsVUFBTSxhQUFhO0FBQUEsTUFDakI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLGVBQWU7QUFBQSxNQUNmO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFFWCxVQUFNLGlCQUFpQixRQUFRLE1BQU0sRUFBRTtBQUN2QyxVQUFNLFdBQVcsTUFBTSxLQUFLO0FBQUEsTUFDMUI7QUFBQSxNQUNBLENBQUMsR0FBRyxnQkFBZ0IsRUFBRSxNQUFNLFFBQVEsU0FBUyxXQUFXLENBQUM7QUFBQSxNQUN6RDtBQUFBLElBQ0Y7QUFFQSxVQUFNLEVBQUUsWUFBWSxRQUFRLElBQUksS0FBSyxvQkFBb0IsU0FBUyxTQUFTO0FBRTNFLFdBQU87QUFBQSxNQUNMLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGdCQUFnQjtBQUFBLE1BQ2hCLFVBQVUsU0FBUztBQUFBLElBQ3JCO0FBQUEsRUFDRjtBQUFBLEVBRVEsb0JBQW9CLFdBQW1FO0FBQzdGLFVBQU0sYUFBOEQsQ0FBQztBQUVyRSxVQUFNLG1CQUFtQixVQUFVLE1BQU0sbUNBQW1DO0FBQzVFLFFBQUksa0JBQWtCO0FBQ3BCLGlCQUFXLEtBQUs7QUFBQSxRQUNkLFVBQVUsaUJBQWlCLENBQUMsRUFBRSxLQUFLO0FBQUEsUUFDbkMsWUFBWSxpQkFBaUIsQ0FBQztBQUFBLE1BQ2hDLENBQUM7QUFBQSxJQUNIO0FBRUEsVUFBTSxZQUFZLFVBQVUsTUFBTSwwQkFBMEI7QUFDNUQsUUFBSSxhQUFhLGdCQUFnQixLQUFLLFVBQVUsQ0FBQyxDQUFDLEdBQUc7QUFDbkQsaUJBQVcsS0FBSztBQUFBLFFBQ2QsVUFBVSxVQUFVLENBQUMsRUFBRSxLQUFLO0FBQUEsUUFDNUIsWUFBWSxVQUFVLENBQUM7QUFBQSxNQUN6QixDQUFDO0FBQUEsSUFDSDtBQUVBLFVBQU0sZ0JBQWdCLEtBQUssOEJBQThCLFNBQVM7QUFDbEUsUUFBSSxlQUFlO0FBQ2pCLGlCQUFXLEtBQUs7QUFBQSxRQUNkLFVBQVU7QUFBQSxRQUNWLFlBQVk7QUFBQSxNQUNkLENBQUM7QUFBQSxJQUNIO0FBRUEsUUFBSSxnQkFBK0IsQ0FBQztBQUNwQyxRQUFJLGFBQWE7QUFFakIsZUFBVyxhQUFhLFlBQVk7QUFDbEMsWUFBTSxRQUFRLEtBQUsscUJBQXFCLFVBQVUsUUFBUTtBQUMxRCxVQUFJLE1BQU0sUUFBUTtBQUNoQix3QkFBZ0I7QUFDaEIscUJBQWEsVUFBVTtBQUN2QjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsUUFBSSxDQUFDLGNBQWMsUUFBUTtBQUN6QixhQUFPLEVBQUUsWUFBWSxVQUFVLEtBQUssR0FBRyxTQUFTLENBQUMsRUFBRTtBQUFBLElBQ3JEO0FBRUEsVUFBTSxXQUFXLGFBQWEsVUFBVSxRQUFRLFlBQVksRUFBRSxFQUFFLEtBQUssSUFBSSxVQUFVLEtBQUs7QUFDeEYsVUFBTSxhQUFhLFlBQVk7QUFFL0IsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFNBQVM7QUFBQSxJQUNYO0FBQUEsRUFDRjtBQUFBLEVBRVEscUJBQXFCLFVBQWlDO0FBQzVELFFBQUk7QUFDSixRQUFJO0FBQ0YsZUFBUyxLQUFLLE1BQU0sUUFBUTtBQUFBLElBQzlCLFFBQVE7QUFDTixhQUFPLENBQUM7QUFBQSxJQUNWO0FBRUEsUUFBSSxDQUFDLFVBQVUsT0FBTyxXQUFXLFVBQVU7QUFDekMsYUFBTyxDQUFDO0FBQUEsSUFDVjtBQUVBLFVBQU0sZUFBZ0IsT0FBbUM7QUFDekQsUUFBSSxDQUFDLE1BQU0sUUFBUSxZQUFZLEdBQUc7QUFDaEMsYUFBTyxDQUFDO0FBQUEsSUFDVjtBQUVBLFVBQU0sVUFBeUIsQ0FBQztBQUVoQyxlQUFXLFVBQVUsY0FBYztBQUNqQyxVQUFJLENBQUMsVUFBVSxPQUFPLFdBQVcsVUFBVTtBQUN6QztBQUFBLE1BQ0Y7QUFFQSxZQUFNLE1BQU07QUFDWixZQUFNLE9BQU8sT0FBTyxJQUFJLFNBQVMsV0FBVyxJQUFJLE9BQU87QUFDdkQsWUFBTSxPQUFPLE9BQU8sSUFBSSxTQUFTLFdBQVcsSUFBSSxPQUFPO0FBRXZELFVBQUksU0FBUyxtQkFBbUIsTUFBTTtBQUNwQyxnQkFBUSxLQUFLLEVBQUUsTUFBTSxpQkFBaUIsS0FBSyxDQUFDO0FBQzVDO0FBQUEsTUFDRjtBQUVBLFVBQUksU0FBUyxpQkFBaUIsUUFBUSxPQUFPLElBQUksWUFBWSxVQUFVO0FBQ3JFLGdCQUFRLEtBQUs7QUFBQSxVQUNYLE1BQU07QUFBQSxVQUNOO0FBQUEsVUFDQSxTQUFTLElBQUk7QUFBQSxVQUNiLFdBQVcsT0FBTyxJQUFJLGNBQWMsWUFBWSxJQUFJLFlBQVk7QUFBQSxRQUNsRSxDQUFDO0FBQ0Q7QUFBQSxNQUNGO0FBRUEsVUFBSSxTQUFTLGlCQUFpQixRQUFRLE9BQU8sSUFBSSxZQUFZLFVBQVU7QUFDckUsZ0JBQVEsS0FBSyxFQUFFLE1BQU0sZUFBZSxNQUFNLFNBQVMsSUFBSSxRQUFRLENBQUM7QUFDaEU7QUFBQSxNQUNGO0FBRUEsVUFDRSxTQUFTLDBCQUNULFFBQ0EsT0FBTyxJQUFJLFlBQVksWUFDdkIsT0FBTyxJQUFJLFlBQVksVUFDdkI7QUFDQSxnQkFBUSxLQUFLO0FBQUEsVUFDWCxNQUFNO0FBQUEsVUFDTjtBQUFBLFVBQ0EsU0FBUyxJQUFJO0FBQUEsVUFDYixTQUFTLElBQUk7QUFBQSxVQUNiLGlCQUFpQixPQUFPLElBQUksb0JBQW9CLFlBQVksSUFBSSxrQkFBa0I7QUFBQSxRQUNwRixDQUFDO0FBQ0Q7QUFBQSxNQUNGO0FBRUEsVUFDRSxTQUFTLHFCQUNULFFBQ0EsT0FBTyxJQUFJLFNBQVMsWUFDcEIsT0FBTyxJQUFJLFlBQVksVUFDdkI7QUFDQSxnQkFBUSxLQUFLO0FBQUEsVUFDWCxNQUFNO0FBQUEsVUFDTjtBQUFBLFVBQ0EsTUFBTSxJQUFJO0FBQUEsVUFDVixTQUFTLElBQUk7QUFBQSxVQUNiLFlBQVksT0FBTyxJQUFJLGVBQWUsWUFBWSxJQUFJLGFBQWE7QUFBQSxRQUNyRSxDQUFDO0FBQ0Q7QUFBQSxNQUNGO0FBRUEsVUFBSSxTQUFTLDBCQUEwQixRQUFRLE9BQU8sSUFBSSxhQUFhLFVBQVU7QUFDL0UsY0FBTSxlQUFlLElBQUk7QUFDekIsY0FBTSxZQUFvQyxDQUFDO0FBQzNDLFlBQUksZ0JBQWdCLE9BQU8saUJBQWlCLFVBQVU7QUFDcEQscUJBQVcsQ0FBQyxLQUFLLEtBQUssS0FBSyxPQUFPLFFBQVEsWUFBdUMsR0FBRztBQUNsRixnQkFBSSxPQUFPLFVBQVUsVUFBVTtBQUM3Qix3QkFBVSxHQUFHLElBQUk7QUFBQSxZQUNuQjtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBRUEsZ0JBQVEsS0FBSztBQUFBLFVBQ1gsTUFBTTtBQUFBLFVBQ047QUFBQSxVQUNBLFVBQVUsSUFBSTtBQUFBLFVBQ2Q7QUFBQSxVQUNBLFdBQVcsT0FBTyxJQUFJLGNBQWMsWUFBWSxJQUFJLFlBQVk7QUFBQSxRQUNsRSxDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0Y7QUFFQSxXQUFPO0FBQUEsRUFDVDtBQUFBLEVBRVEsOEJBQThCLE1BQTZCO0FBQ2pFLFVBQU0sa0JBQWtCLEtBQUssT0FBTyxlQUFlO0FBQ25ELFFBQUksa0JBQWtCLEdBQUc7QUFDdkIsYUFBTztBQUFBLElBQ1Q7QUFFQSxVQUFNLGNBQWMsS0FBSyxZQUFZLEtBQUssZUFBZTtBQUN6RCxRQUFJLGNBQWMsR0FBRztBQUNuQixhQUFPO0FBQUEsSUFDVDtBQUVBLFFBQUksUUFBUTtBQUNaLFFBQUksV0FBVztBQUNmLFFBQUksVUFBVTtBQUVkLGFBQVMsSUFBSSxhQUFhLElBQUksS0FBSyxRQUFRLEtBQUssR0FBRztBQUNqRCxZQUFNLEtBQUssS0FBSyxDQUFDO0FBRWpCLFVBQUksVUFBVTtBQUNaLFlBQUksU0FBUztBQUNYLG9CQUFVO0FBQ1Y7QUFBQSxRQUNGO0FBRUEsWUFBSSxPQUFPLE1BQU07QUFDZixvQkFBVTtBQUNWO0FBQUEsUUFDRjtBQUVBLFlBQUksT0FBTyxLQUFLO0FBQ2QscUJBQVc7QUFBQSxRQUNiO0FBQ0E7QUFBQSxNQUNGO0FBRUEsVUFBSSxPQUFPLEtBQUs7QUFDZCxtQkFBVztBQUNYO0FBQUEsTUFDRjtBQUVBLFVBQUksT0FBTyxLQUFLO0FBQ2QsaUJBQVM7QUFDVDtBQUFBLE1BQ0Y7QUFFQSxVQUFJLE9BQU8sS0FBSztBQUNkLGlCQUFTO0FBQ1QsWUFBSSxVQUFVLEdBQUc7QUFDZixpQkFBTyxLQUFLLE1BQU0sYUFBYSxJQUFJLENBQUM7QUFBQSxRQUN0QztBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVRLGtCQUFrQixNQUE2QjtBQUNyRCxVQUFNLFVBQVUsS0FBSyxLQUFLLEVBQUUsUUFBUSxPQUFPLEdBQUc7QUFDOUMsUUFBSSxDQUFDLFNBQVM7QUFDWixhQUFPO0FBQUEsSUFDVDtBQUVBLFFBQUksYUFBYSxLQUFLLE9BQU8sS0FBSyxRQUFRLFdBQVcsR0FBRyxHQUFHO0FBQ3pELGFBQU87QUFBQSxJQUNUO0FBRUEsVUFBTSxpQkFBYSwrQkFBYyxPQUFPO0FBQ3hDLFFBQUksQ0FBQyxjQUFjLGVBQWUsS0FBSztBQUNyQyxhQUFPO0FBQUEsSUFDVDtBQUVBLFVBQU0sV0FBVyxXQUFXLE1BQU0sR0FBRztBQUNyQyxRQUFJLFNBQVMsS0FBSyxDQUFDLFlBQVksQ0FBQyxXQUFXLFlBQVksSUFBSSxHQUFHO0FBQzVELGFBQU87QUFBQSxJQUNUO0FBRUEsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLE1BQWMsbUJBQW1CLFlBQW1DO0FBQ2xFLFFBQUksQ0FBQyxZQUFZO0FBQ2Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxXQUFXLFdBQVcsTUFBTSxHQUFHO0FBQ3JDLFFBQUksVUFBVTtBQUVkLGVBQVcsV0FBVyxVQUFVO0FBQzlCLGdCQUFVLFVBQVUsR0FBRyxPQUFPLElBQUksT0FBTyxLQUFLO0FBQzlDLFlBQU0sV0FBVyxLQUFLLElBQUksTUFBTSxzQkFBc0IsT0FBTztBQUM3RCxVQUFJLFVBQVU7QUFDWixZQUFJLG9CQUFvQix1QkFBTztBQUM3QixnQkFBTSxJQUFJLE1BQU0sd0JBQXdCLE9BQU8sK0JBQStCO0FBQUEsUUFDaEY7QUFDQTtBQUFBLE1BQ0Y7QUFFQSxZQUFNLEtBQUssSUFBSSxNQUFNLGFBQWEsT0FBTztBQUFBLElBQzNDO0FBQUEsRUFDRjtBQUFBLEVBRUEsTUFBTSxrQkFBa0IsU0FBeUM7QUFDL0QsUUFBSSxpQkFBaUI7QUFDckIsUUFBSSxlQUFlO0FBQ25CLFFBQUksZUFBZTtBQUNuQixRQUFJLFVBQVU7QUFDZCxVQUFNLFNBQW1CLENBQUM7QUFFMUIsZUFBVyxVQUFVLFNBQVM7QUFDNUIsVUFBSTtBQUNGLGNBQU0sV0FBVyxLQUFLLGtCQUFrQixPQUFPLElBQUk7QUFDbkQsWUFBSSxDQUFDLFVBQVU7QUFDYixxQkFBVztBQUNYO0FBQUEsUUFDRjtBQUVBLFlBQUksT0FBTyxTQUFTLGlCQUFpQjtBQUNuQyxnQkFBTUEsWUFBVyxLQUFLLElBQUksTUFBTSxzQkFBc0IsUUFBUTtBQUM5RCxjQUFJQSxXQUFVO0FBQ1osdUJBQVc7QUFDWDtBQUFBLFVBQ0Y7QUFFQSxnQkFBTSxLQUFLLG1CQUFtQixRQUFRO0FBQ3RDLDRCQUFrQjtBQUNsQjtBQUFBLFFBQ0Y7QUFFQSxZQUFJLE9BQU8sU0FBUyx3QkFBd0I7QUFDMUMsZ0JBQU0sVUFBVSxLQUFLLGVBQWUsT0FBTyxVQUFVLE9BQU8sYUFBYSxDQUFDLENBQUM7QUFDM0UsZ0JBQU1DLGNBQWEsU0FBUyxTQUFTLEdBQUcsSUFBSSxTQUFTLE1BQU0sR0FBRyxTQUFTLFlBQVksR0FBRyxDQUFDLElBQUk7QUFDM0YsZ0JBQU0sS0FBSyxtQkFBbUJBLFdBQVU7QUFFeEMsZ0JBQU1ELFlBQVcsS0FBSyxJQUFJLE1BQU0sc0JBQXNCLFFBQVE7QUFDOUQsY0FBSUEsV0FBVTtBQUNaLGdCQUFJLEVBQUVBLHFCQUFvQix3QkFBUTtBQUNoQyxxQkFBTyxLQUFLLHNCQUFzQixRQUFRLGlDQUFpQztBQUMzRTtBQUFBLFlBQ0Y7QUFFQSxnQkFBSSxDQUFDLE9BQU8sV0FBVztBQUNyQix5QkFBVztBQUNYO0FBQUEsWUFDRjtBQUVBLGtCQUFNLEtBQUssSUFBSSxNQUFNLE9BQU9BLFdBQVUsT0FBTztBQUM3Qyw0QkFBZ0I7QUFDaEI7QUFBQSxVQUNGO0FBRUEsZ0JBQU0sS0FBSyxJQUFJLE1BQU0sT0FBTyxVQUFVLE9BQU87QUFDN0MsMEJBQWdCO0FBQ2hCO0FBQUEsUUFDRjtBQUVBLFlBQUksT0FBTyxTQUFTLGVBQWU7QUFDakMsZ0JBQU1BLFlBQVcsS0FBSyxJQUFJLE1BQU0sc0JBQXNCLFFBQVE7QUFDOUQsY0FBSSxFQUFFQSxxQkFBb0Isd0JBQVE7QUFDaEMsbUJBQU8sS0FBSyxvQkFBb0IsUUFBUSxtQkFBbUI7QUFDM0Q7QUFBQSxVQUNGO0FBRUEsZ0JBQU0sVUFBVSxNQUFNLEtBQUssSUFBSSxNQUFNLFdBQVdBLFNBQVE7QUFDeEQsZ0JBQU0sWUFBWSxRQUFRLFNBQVMsSUFBSSxLQUFLLE9BQU8sUUFBUSxXQUFXLElBQUksSUFBSSxLQUFLO0FBQ25GLGdCQUFNLEtBQUssSUFBSSxNQUFNLE9BQU9BLFdBQVUsR0FBRyxPQUFPLEdBQUcsU0FBUyxHQUFHLE9BQU8sT0FBTyxFQUFFO0FBQy9FLDBCQUFnQjtBQUNoQjtBQUFBLFFBQ0Y7QUFFQSxZQUFJLE9BQU8sU0FBUyx3QkFBd0I7QUFDMUMsZ0JBQU1BLFlBQVcsS0FBSyxJQUFJLE1BQU0sc0JBQXNCLFFBQVE7QUFDOUQsY0FBSSxFQUFFQSxxQkFBb0Isd0JBQVE7QUFDaEMsbUJBQU8sS0FBSyxvQkFBb0IsUUFBUSxtQkFBbUI7QUFDM0Q7QUFBQSxVQUNGO0FBRUEsZ0JBQU0sVUFBVSxNQUFNLEtBQUssSUFBSSxNQUFNLFdBQVdBLFNBQVE7QUFDeEQsZ0JBQU0saUJBQWlCLE9BQU8sUUFBUSxRQUFRLHVCQUF1QixNQUFNO0FBQzNFLGdCQUFNLGVBQWUsSUFBSSxPQUFPLElBQUksY0FBYyxTQUFTLEdBQUc7QUFDOUQsZ0JBQU0sZUFBZSxhQUFhLEtBQUssT0FBTztBQUU5QyxjQUFJLENBQUMsY0FBYztBQUNqQixnQkFBSSxPQUFPLGlCQUFpQjtBQUMxQixvQkFBTSxXQUFXLEdBQUcsT0FBTyxHQUFHLFFBQVEsU0FBUyxJQUFJLElBQUksS0FBSyxNQUFNLEdBQUcsT0FBTyxPQUFPO0FBQUEsRUFBSyxPQUFPLE9BQU87QUFDdEcsb0JBQU0sS0FBSyxJQUFJLE1BQU0sT0FBT0EsV0FBVSxRQUFRO0FBQzlDLDhCQUFnQjtBQUFBLFlBQ2xCLE9BQU87QUFDTCx5QkFBVztBQUFBLFlBQ2I7QUFDQTtBQUFBLFVBQ0Y7QUFFQSxnQkFBTSxjQUFjLGFBQWEsUUFBUSxhQUFhLENBQUMsRUFBRTtBQUN6RCxnQkFBTSxVQUFVLEdBQUcsUUFBUSxNQUFNLEdBQUcsV0FBVyxDQUFDO0FBQUEsRUFBSyxPQUFPLE9BQU8sR0FBRyxRQUFRLE1BQU0sV0FBVyxDQUFDO0FBQ2hHLGdCQUFNLEtBQUssSUFBSSxNQUFNLE9BQU9BLFdBQVUsT0FBTztBQUM3QywwQkFBZ0I7QUFDaEI7QUFBQSxRQUNGO0FBRUEsWUFBSSxPQUFPLFNBQVMsbUJBQW1CO0FBQ3JDLGdCQUFNQSxZQUFXLEtBQUssSUFBSSxNQUFNLHNCQUFzQixRQUFRO0FBQzlELGNBQUksRUFBRUEscUJBQW9CLHdCQUFRO0FBQ2hDLG1CQUFPLEtBQUsscUJBQXFCLFFBQVEsbUJBQW1CO0FBQzVEO0FBQUEsVUFDRjtBQUVBLGdCQUFNLFVBQVUsTUFBTSxLQUFLLElBQUksTUFBTSxXQUFXQSxTQUFRO0FBQ3hELGNBQUksQ0FBQyxRQUFRLFNBQVMsT0FBTyxJQUFJLEdBQUc7QUFDbEMsdUJBQVc7QUFDWDtBQUFBLFVBQ0Y7QUFFQSxnQkFBTSxVQUFVLE9BQU8sYUFDbkIsUUFBUSxNQUFNLE9BQU8sSUFBSSxFQUFFLEtBQUssT0FBTyxPQUFPLElBQzlDLFFBQVEsUUFBUSxPQUFPLE1BQU0sT0FBTyxPQUFPO0FBQy9DLGdCQUFNLEtBQUssSUFBSSxNQUFNLE9BQU9BLFdBQVUsT0FBTztBQUM3QywwQkFBZ0I7QUFDaEI7QUFBQSxRQUNGO0FBRUEsY0FBTSxhQUFhLFNBQVMsU0FBUyxHQUFHLElBQUksU0FBUyxNQUFNLEdBQUcsU0FBUyxZQUFZLEdBQUcsQ0FBQyxJQUFJO0FBQzNGLGNBQU0sS0FBSyxtQkFBbUIsVUFBVTtBQUV4QyxjQUFNLFdBQVcsS0FBSyxJQUFJLE1BQU0sc0JBQXNCLFFBQVE7QUFDOUQsWUFBSSxVQUFVO0FBQ1osY0FBSSxFQUFFLG9CQUFvQix3QkFBUTtBQUNoQyxtQkFBTyxLQUFLLHNCQUFzQixRQUFRLGlDQUFpQztBQUMzRTtBQUFBLFVBQ0Y7QUFFQSxjQUFJLENBQUMsT0FBTyxXQUFXO0FBQ3JCLHVCQUFXO0FBQ1g7QUFBQSxVQUNGO0FBRUEsZ0JBQU0sS0FBSyxJQUFJLE1BQU0sT0FBTyxVQUFVLE9BQU8sT0FBTztBQUNwRCwwQkFBZ0I7QUFDaEI7QUFBQSxRQUNGO0FBRUEsY0FBTSxLQUFLLElBQUksTUFBTSxPQUFPLFVBQVUsT0FBTyxPQUFPO0FBQ3BELHdCQUFnQjtBQUFBLE1BQ2xCLFNBQVMsT0FBTztBQUNkLGVBQU8sS0FBSyxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLLENBQUM7QUFBQSxNQUNwRTtBQUFBLElBQ0Y7QUFFQSxVQUFNLFFBQVE7QUFBQSxNQUNaLHFDQUFxQyxjQUFjLG1CQUFtQixZQUFZLG1CQUFtQixZQUFZLGFBQWEsT0FBTztBQUFBLElBQ3ZJO0FBQ0EsUUFBSSxPQUFPLFFBQVE7QUFDakIsWUFBTSxLQUFLLFdBQVcsT0FBTyxLQUFLLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFDNUM7QUFFQSxXQUFPLE1BQU0sS0FBSyxJQUFJO0FBQUEsRUFDeEI7QUFBQSxFQUVRLGVBQWUsVUFBa0IsV0FBMkM7QUFDbEYsVUFBTSxPQUFNLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQ25DLFVBQU0sWUFBb0M7QUFBQSxNQUN4QyxnQkFBZ0I7QUFBQSxRQUNkO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLE1BQ1gsZ0JBQWdCO0FBQUEsUUFDZDtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLE1BQ1gsY0FBYztBQUFBLFFBQ1o7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsTUFDWCxtQkFBbUI7QUFBQSxRQUNqQjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxJQUNiO0FBRUEsVUFBTSxXQUFtQztBQUFBLE1BQ3ZDLE9BQU87QUFBQSxNQUNQLE1BQU07QUFBQSxNQUNOLFlBQVk7QUFBQSxNQUNaLFlBQVk7QUFBQSxNQUNaLE9BQU87QUFBQSxNQUNQLFNBQVM7QUFBQSxNQUNULE1BQU0sSUFBSSxNQUFNLEdBQUcsRUFBRTtBQUFBLE1BQ3JCLFdBQVc7QUFBQSxNQUNYLFNBQVM7QUFBQSxNQUNULE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxJQUNSO0FBRUEsVUFBTSxTQUFTLFVBQVUsUUFBUSxLQUFLLFVBQVUsY0FBYztBQUM5RCxXQUFPLE9BQU8sUUFBUSw4QkFBOEIsQ0FBQyxPQUFPLFFBQWdCO0FBQzFFLGFBQU8sVUFBVSxHQUFHLEtBQUssU0FBUyxHQUFHLEtBQUs7QUFBQSxJQUM1QyxDQUFDO0FBQUEsRUFDSDtBQUFBLEVBRUEsTUFBYyxnQkFDWixVQUNBLFFBQ0EsUUFDZ0I7QUFDaEIsVUFBTSxTQUFTLEtBQUssU0FBUyxhQUFhLEtBQUs7QUFDL0MsUUFBSSxVQUFVLENBQUMsS0FBSyxJQUFJLE1BQU0sc0JBQXNCLE1BQU0sR0FBRztBQUMzRCxZQUFNLEtBQUssSUFBSSxNQUFNLGFBQWEsTUFBTTtBQUFBLElBQzFDO0FBRUEsVUFBTSxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsUUFBUSxTQUFTLEdBQUc7QUFDL0QsVUFBTSxXQUFXLGNBQWMsU0FBUztBQUN4QyxVQUFNLFdBQVcsU0FBUyxHQUFHLE1BQU0sSUFBSSxRQUFRLEtBQUs7QUFFcEQsVUFBTSxhQUFhLE9BQU8sU0FDdEIsT0FBTyxJQUFJLENBQUMsT0FBTyxRQUFRLE1BQU0sTUFBTSxDQUFDLEtBQUssTUFBTSxRQUFRLEVBQUUsRUFBRSxLQUFLLElBQUksSUFDeEU7QUFFSixVQUFNLE9BQU87QUFBQSxNQUNYO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSTtBQUVYLFdBQU8sS0FBSyxJQUFJLE1BQU0sT0FBTyxVQUFVLElBQUk7QUFBQSxFQUM3QztBQUFBLEVBRUEsbUJBQW1CLFFBQWdCLFFBQThCO0FBQy9ELFVBQU0sa0JBQWtCLG9CQUFJLElBQVk7QUFFeEMsZUFBVyxTQUFTLFFBQVE7QUFDMUIsc0JBQWdCLElBQUksTUFBTSxRQUFRO0FBQUEsSUFDcEM7QUFFQSxVQUFNLGNBQWM7QUFDcEIsUUFBSTtBQUNKLFlBQVEsUUFBUSxZQUFZLEtBQUssTUFBTSxPQUFPLE1BQU07QUFDbEQsWUFBTSxZQUFZLE1BQU0sQ0FBQyxFQUFFLFFBQVEsUUFBUSxFQUFFO0FBQzdDLFVBQUksV0FBVztBQUNiLHdCQUFnQixJQUFJLFNBQVM7QUFBQSxNQUMvQjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFFBQWlCLENBQUM7QUFDeEIsZUFBVyxRQUFRLGlCQUFpQjtBQUNsQyxZQUFNLE9BQU8sS0FBSyxJQUFJLE1BQU0sc0JBQXNCLElBQUk7QUFDdEQsVUFBSSxnQkFBZ0IsdUJBQU87QUFDekIsY0FBTSxLQUFLLElBQUk7QUFBQSxNQUNqQjtBQUFBLElBQ0Y7QUFFQSxVQUFNLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxLQUFLLGNBQWMsRUFBRSxJQUFJLENBQUM7QUFDakQsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLGlCQUFpQixRQUFnQixRQUFxQztBQUNwRSxVQUFNLE9BQU8sb0JBQUksSUFBWTtBQUM3QixVQUFNLFlBQTRCLENBQUM7QUFDbkMsVUFBTSxnQkFBZ0I7QUFDdEIsUUFBSTtBQUVKLFlBQVEsUUFBUSxjQUFjLEtBQUssTUFBTSxPQUFPLE1BQU07QUFDcEQsWUFBTSxTQUFTLE9BQU8sU0FBUyxNQUFNLENBQUMsR0FBRyxFQUFFO0FBQzNDLFVBQUksQ0FBQyxPQUFPLFNBQVMsTUFBTSxLQUFLLFNBQVMsS0FBSyxLQUFLLElBQUksTUFBTSxHQUFHO0FBQzlEO0FBQUEsTUFDRjtBQUVBLFlBQU0sUUFBUSxPQUFPLFNBQVMsQ0FBQztBQUMvQixVQUFJLENBQUMsT0FBTztBQUNWO0FBQUEsTUFDRjtBQUVBLFlBQU0sT0FBTyxLQUFLLElBQUksTUFBTSxzQkFBc0IsTUFBTSxRQUFRO0FBQ2hFLFVBQUksZ0JBQWdCLHVCQUFPO0FBQ3pCLGFBQUssSUFBSSxNQUFNO0FBQ2Ysa0JBQVUsS0FBSyxFQUFFLFFBQVEsS0FBSyxDQUFDO0FBQUEsTUFDakM7QUFBQSxJQUNGO0FBRUEsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLHlCQUF5QixTQUFnQztBQUN2RCxVQUFNLFVBQVUsUUFBUSxLQUFLO0FBQzdCLFFBQUksQ0FBQyxRQUFRLFlBQVksRUFBRSxXQUFXLGtCQUFrQixHQUFHO0FBQ3pELGFBQU87QUFBQSxJQUNUO0FBRUEsUUFBSTtBQUNKLFFBQUk7QUFDRixlQUFTLElBQUksSUFBSSxPQUFPO0FBQUEsSUFDMUIsUUFBUTtBQUNOLGFBQU87QUFBQSxJQUNUO0FBRUEsVUFBTSxZQUFZLE9BQU8sYUFBYSxJQUFJLE9BQU8sS0FBSztBQUN0RCxVQUFNLGVBQWUsS0FBSyxJQUFJLE1BQU0sUUFBUTtBQUM1QyxRQUFJLGFBQWEsY0FBYyxjQUFjO0FBQzNDLGFBQU87QUFBQSxJQUNUO0FBRUEsVUFBTSxZQUFZLE9BQU8sYUFBYSxJQUFJLE1BQU07QUFDaEQsUUFBSSxDQUFDLFdBQVc7QUFDZCxhQUFPO0FBQUEsSUFDVDtBQUVBLFVBQU0sVUFBVSxtQkFBbUIsU0FBUyxFQUFFLFFBQVEsT0FBTyxHQUFHLEVBQUUsS0FBSztBQUN2RSxVQUFNLE9BQU8sS0FBSyxrQkFBa0IsT0FBTztBQUMzQyxXQUFPO0FBQUEsRUFDVDtBQUFBLEVBRUEseUJBQXlCLFNBQStCO0FBQ3RELFVBQU0sV0FBVyxLQUFLLHlCQUF5QixPQUFPO0FBQ3RELFFBQUksQ0FBQyxVQUFVO0FBQ2IsYUFBTztBQUFBLElBQ1Q7QUFFQSxVQUFNLE9BQU8sS0FBSyxJQUFJLE1BQU0sc0JBQXNCLFFBQVE7QUFDMUQsV0FBTyxnQkFBZ0Isd0JBQVEsT0FBTztBQUFBLEVBQ3hDO0FBQUEsRUFFQSxNQUFNLGVBQWUsV0FBbUIsVUFBeUM7QUFDL0UsUUFBSSxDQUFDLFNBQVMsUUFBUTtBQUNwQixZQUFNLElBQUksTUFBTSwrQkFBK0I7QUFBQSxJQUNqRDtBQUVBLFVBQU0sYUFBYSxLQUFLLFNBQVMsYUFBYSxLQUFLO0FBQ25ELFVBQU0sYUFBYSxhQUFhLEdBQUcsVUFBVSxlQUFlO0FBQzVELFVBQU0sS0FBSyxtQkFBbUIsVUFBVTtBQUV4QyxVQUFNLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxRQUFRLFNBQVMsR0FBRztBQUMvRCxVQUFNLGFBQWEsYUFBYSxjQUM3QixRQUFRLGlCQUFpQixHQUFHLEVBQzVCLFFBQVEsUUFBUSxHQUFHLEVBQ25CLEtBQUs7QUFDUixVQUFNLFdBQVcsR0FBRyxTQUFTLElBQUksU0FBUztBQUMxQyxVQUFNLFdBQVcsR0FBRyxVQUFVLElBQUksUUFBUTtBQUUxQyxVQUFNLGFBQWEsU0FDaEIsSUFBSSxDQUFDLEtBQUssVUFBVTtBQUNuQixZQUFNLE9BQU8sSUFBSSxTQUFTLFNBQVMsU0FBUztBQUM1QyxhQUFPLENBQUMsT0FBTyxRQUFRLENBQUMsS0FBSyxJQUFJLElBQUksSUFBSSxJQUFJLFFBQVEsS0FBSyxDQUFDLEVBQUUsS0FBSyxJQUFJO0FBQUEsSUFDeEUsQ0FBQyxFQUNBLEtBQUssTUFBTTtBQUVkLFVBQU0sVUFBVTtBQUFBLE1BQ2QsS0FBSyxTQUFTO0FBQUEsTUFDZDtBQUFBLE1BQ0EsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWSxDQUFDO0FBQUEsTUFDcEM7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBRVgsV0FBTyxLQUFLLElBQUksTUFBTSxPQUFPLFVBQVUsT0FBTztBQUFBLEVBQ2hEO0FBQ0Y7QUFFQSxJQUFNLHFCQUFOLGNBQWlDLHlCQUFTO0FBQUEsRUFnQnhDLFlBQVksTUFBcUIsUUFBNkI7QUFDNUQsVUFBTSxJQUFJO0FBZlosU0FBUSxPQUF5QjtBQUNqQyxTQUFRLFdBQVc7QUFDbkIsU0FBUSxXQUEwQixDQUFDO0FBQ25DLFNBQVEsaUJBQWdDLENBQUM7QUFDekMsU0FBUSxZQUFZO0FBQ3BCLFNBQVEsb0JBQW9CO0FBQzVCLFNBQVEsc0JBQXNCO0FBQzlCLFNBQVEsaUJBQWdDLENBQUM7QUFLekMsU0FBUSxnQkFBZ0I7QUFJdEIsU0FBSyxTQUFTO0FBQUEsRUFDaEI7QUFBQSxFQUVBLGNBQXNCO0FBQ3BCLFdBQU87QUFBQSxFQUNUO0FBQUEsRUFFQSxpQkFBeUI7QUFDdkIsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLFVBQWtCO0FBQ2hCLFdBQU87QUFBQSxFQUNUO0FBQUEsRUFFQSxNQUFNLFNBQXdCO0FBQzVCLFVBQU0sUUFBUSxLQUFLLEtBQUssYUFBYSxFQUFFO0FBQ3ZDLFNBQUssT0FBTyxPQUFPLFNBQVMsU0FBUyxTQUFTO0FBQzlDLFNBQUssV0FBVyxPQUFPLE9BQU8sYUFBYSxXQUFXLE1BQU0sV0FBVztBQUN2RSxTQUFLLE9BQU87QUFBQSxFQUNkO0FBQUEsRUFFQSxNQUFNLFVBQXlCO0FBQzdCLFNBQUssVUFBVSxNQUFNO0FBQUEsRUFDdkI7QUFBQSxFQUVRLFNBQWU7QUFDckIsVUFBTSxFQUFFLFVBQVUsSUFBSTtBQUN0QixjQUFVLE1BQU07QUFDaEIsY0FBVSxTQUFTLDZCQUE2QjtBQUVoRCxVQUFNLFNBQVMsVUFBVSxVQUFVLEVBQUUsS0FBSyxxQ0FBcUMsQ0FBQztBQUNoRixXQUFPLFNBQVMsTUFBTSxFQUFFLE1BQU0sS0FBSyxTQUFTLFVBQVUscUJBQXFCLFlBQVksQ0FBQztBQUV4RixVQUFNLGNBQWMsT0FBTyxVQUFVLEVBQUUsS0FBSywyQ0FBMkMsQ0FBQztBQUN4RixVQUFNLGNBQWMsWUFBWSxTQUFTLFVBQVUsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUNwRSxVQUFNLGFBQWEsWUFBWSxTQUFTLFVBQVUsRUFBRSxNQUFNLGVBQWUsQ0FBQztBQUUxRSxRQUFJLEtBQUssU0FBUyxTQUFTO0FBQ3pCLGtCQUFZLFNBQVMsU0FBUztBQUFBLElBQ2hDLE9BQU87QUFDTCxpQkFBVyxTQUFTLFNBQVM7QUFBQSxJQUMvQjtBQUVBLGdCQUFZLGlCQUFpQixTQUFTLFlBQVk7QUFDaEQsWUFBTSxLQUFLLFdBQVcsT0FBTztBQUFBLElBQy9CLENBQUM7QUFFRCxlQUFXLGlCQUFpQixTQUFTLFlBQVk7QUFDL0MsWUFBTSxhQUFhLEtBQUssSUFBSSxVQUFVLGNBQWM7QUFDcEQsVUFBSSxDQUFDLGNBQWMsV0FBVyxjQUFjLE1BQU07QUFDaEQsWUFBSSx1QkFBTyw2QkFBNkI7QUFDeEM7QUFBQSxNQUNGO0FBRUEsWUFBTSxLQUFLLFdBQVcsUUFBUSxXQUFXLElBQUk7QUFBQSxJQUMvQyxDQUFDO0FBRUQsVUFBTSxZQUNKLEtBQUssU0FBUyxVQUNWLHlCQUNBLEtBQUssV0FDSCxVQUFVLEtBQUssUUFBUSxLQUN2QjtBQUVSLGNBQVUsVUFBVTtBQUFBLE1BQ2xCLEtBQUs7QUFBQSxNQUNMLE1BQU07QUFBQSxJQUNSLENBQUM7QUFFRCxVQUFNLGlCQUFpQixVQUFVLFVBQVUsRUFBRSxLQUFLLDhDQUE4QyxDQUFDO0FBQ2pHLG1CQUFlLFVBQVUsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUMvQyxVQUFNLGlCQUFpQixlQUFlLFNBQVMsU0FBUztBQUFBLE1BQ3RELE1BQU07QUFBQSxNQUNOLE9BQU8sT0FBTyxLQUFLLFNBQVM7QUFBQSxJQUM5QixDQUFDO0FBQ0QsbUJBQWUsTUFBTTtBQUNyQixtQkFBZSxNQUFNO0FBQ3JCLG1CQUFlLGlCQUFpQixVQUFVLE1BQU07QUFDOUMsWUFBTSxTQUFTLE9BQU8sU0FBUyxlQUFlLE9BQU8sRUFBRTtBQUN2RCxVQUFJLE9BQU8sU0FBUyxNQUFNLEdBQUc7QUFDM0IsYUFBSyxZQUFZLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLE1BQU0sQ0FBQztBQUFBLE1BQ25EO0FBQ0EscUJBQWUsUUFBUSxPQUFPLEtBQUssU0FBUztBQUFBLElBQzlDLENBQUM7QUFFRCxVQUFNLHNCQUFzQixlQUFlLFNBQVMsU0FBUztBQUFBLE1BQzNELEtBQUs7QUFBQSxJQUNQLENBQUM7QUFDRCxVQUFNLGtCQUFrQixvQkFBb0IsU0FBUyxTQUFTLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFDbEYsb0JBQWdCLFVBQVUsS0FBSztBQUMvQix3QkFBb0IsV0FBVyxlQUFlO0FBQzlDLG9CQUFnQixpQkFBaUIsVUFBVSxNQUFNO0FBQy9DLFdBQUssb0JBQW9CLGdCQUFnQjtBQUFBLElBQzNDLENBQUM7QUFFRCxVQUFNLGdCQUFnQixlQUFlLFNBQVMsVUFBVSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQzVFLGtCQUFjLGlCQUFpQixTQUFTLE1BQU07QUFDNUMsV0FBSyxlQUFlO0FBQUEsSUFDdEIsQ0FBQztBQUVELFVBQU0sa0JBQWtCLGVBQWUsU0FBUyxVQUFVLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDaEYsb0JBQWdCLGlCQUFpQixTQUFTLE1BQU07QUFDOUMsV0FBSyxpQkFBaUIsQ0FBQztBQUN2QixVQUFJLHVCQUFPLDBCQUEwQjtBQUFBLElBQ3ZDLENBQUM7QUFFRCxtQkFBZSxVQUFVO0FBQUEsTUFDdkIsS0FBSztBQUFBLE1BQ0wsTUFBTSxTQUFTLEtBQUssZUFBZSxNQUFNO0FBQUEsSUFDM0MsQ0FBQztBQUVELFNBQUssZUFBZSxVQUFVLFVBQVUsRUFBRSxLQUFLLHNDQUFzQyxDQUFDO0FBRXRGLFVBQU0sWUFBWSxVQUFVLFVBQVUsRUFBRSxLQUFLLHNDQUFzQyxDQUFDO0FBQ3BGLFNBQUssVUFBVSxVQUFVLFNBQVMsWUFBWTtBQUFBLE1BQzVDLE1BQU07QUFBQSxRQUNKLGFBQ0UsS0FBSyxTQUFTLFVBQ1YsNERBQ0E7QUFBQSxNQUNSO0FBQUEsSUFDRixDQUFDO0FBRUQsU0FBSyxlQUFlLFVBQVUsU0FBUyxVQUFVLEVBQUUsTUFBTSxPQUFPLENBQUM7QUFDakUsU0FBSyxlQUFlLFVBQVUsU0FBUyxVQUFVLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFdEUsU0FBSyxhQUFhLGlCQUFpQixTQUFTLFlBQVk7QUFDdEQsWUFBTSxLQUFLLFlBQVk7QUFBQSxJQUN6QixDQUFDO0FBRUQsU0FBSyxhQUFhLGlCQUFpQixTQUFTLFlBQVk7QUFDdEQsWUFBTSxLQUFLLFNBQVM7QUFBQSxJQUN0QixDQUFDO0FBRUQsU0FBSyxRQUFRLGlCQUFpQixXQUFXLE9BQU8sVUFBVTtBQUN4RCxVQUFJLE1BQU0sUUFBUSxXQUFXLENBQUMsTUFBTSxVQUFVO0FBQzVDLGNBQU0sZUFBZTtBQUNyQixjQUFNLEtBQUssWUFBWTtBQUFBLE1BQ3pCO0FBQUEsSUFDRixDQUFDO0FBRUQsU0FBSyxRQUFRLGlCQUFpQixZQUFZLENBQUMsVUFBVTtBQUNuRCxVQUFJLENBQUMsTUFBTSxjQUFjO0FBQ3ZCO0FBQUEsTUFDRjtBQUVBLFlBQU0sVUFBVSxNQUFNLEtBQUssTUFBTSxhQUFhLEtBQUssRUFBRTtBQUFBLFFBQUssQ0FBQyxTQUN6RCxTQUFTLGdCQUFnQixTQUFTO0FBQUEsTUFDcEM7QUFDQSxVQUFJLENBQUMsU0FBUztBQUNaO0FBQUEsTUFDRjtBQUVBLFlBQU0sZUFBZTtBQUNyQixZQUFNLGFBQWEsYUFBYTtBQUNoQyxVQUFJLENBQUMsS0FBSyxlQUFlO0FBQ3ZCLGFBQUssZ0JBQWdCO0FBQ3JCLGFBQUssUUFBUSxTQUFTLGNBQWM7QUFBQSxNQUN0QztBQUFBLElBQ0YsQ0FBQztBQUVELFNBQUssUUFBUSxpQkFBaUIsYUFBYSxNQUFNO0FBQy9DLFdBQUssZ0JBQWdCO0FBQ3JCLFdBQUssUUFBUSxZQUFZLGNBQWM7QUFBQSxJQUN6QyxDQUFDO0FBRUQsU0FBSyxRQUFRLGlCQUFpQixRQUFRLENBQUMsVUFBVTtBQUMvQyxZQUFNLGVBQWU7QUFDckIsV0FBSyxnQkFBZ0I7QUFDckIsV0FBSyxRQUFRLFlBQVksY0FBYztBQUV2QyxZQUFNLEtBQUssTUFBTTtBQUNqQixVQUFJLENBQUMsSUFBSTtBQUNQO0FBQUEsTUFDRjtBQUVBLFlBQU0sVUFBVSxHQUFHLFFBQVEsZUFBZSxLQUFLO0FBQy9DLFlBQU0sWUFBWSxHQUFHLFFBQVEsWUFBWSxLQUFLO0FBQzlDLFlBQU0sU0FBUyxHQUFHLE9BQU87QUFBQSxFQUFLLFNBQVMsR0FBRyxLQUFLO0FBQy9DLFVBQUksQ0FBQyxRQUFRO0FBQ1g7QUFBQSxNQUNGO0FBRUEsWUFBTSxRQUFRLE9BQ1gsTUFBTSxPQUFPLEVBQ2IsSUFBSSxDQUFDLFNBQVMsS0FBSyxLQUFLLENBQUMsRUFDekIsT0FBTyxDQUFDLFNBQVMsS0FBSyxTQUFTLENBQUM7QUFFbkMsWUFBTSxhQUF1QixDQUFDO0FBQzlCLGlCQUFXLFFBQVEsT0FBTztBQUN4QixjQUFNLE9BQU8sS0FBSyxPQUFPLHlCQUF5QixJQUFJO0FBQ3RELFlBQUksTUFBTTtBQUNSLHFCQUFXLEtBQUssS0FBSyxLQUFLLElBQUksSUFBSTtBQUNsQztBQUFBLFFBQ0Y7QUFFQSxjQUFNLFdBQVcsS0FBSyxPQUFPLHlCQUF5QixJQUFJO0FBQzFELFlBQUksVUFBVTtBQUNaLHFCQUFXLEtBQUssS0FBSyxRQUFRLElBQUk7QUFDakM7QUFBQSxRQUNGO0FBRUEsWUFBSSxLQUFLLFlBQVksRUFBRSxTQUFTLEtBQUssR0FBRztBQUN0QyxxQkFBVyxLQUFLLEtBQUssSUFBSSxJQUFJO0FBQUEsUUFDL0I7QUFBQSxNQUNGO0FBRUEsVUFBSSxDQUFDLFdBQVcsUUFBUTtBQUN0QixZQUFJLHVCQUFPLDhEQUE4RDtBQUN6RTtBQUFBLE1BQ0Y7QUFFQSxZQUFNLFNBQVMsS0FBSyxRQUFRLE1BQU0sS0FBSyxJQUFJLE9BQU87QUFDbEQsV0FBSyxRQUFRLFFBQVEsR0FBRyxLQUFLLFFBQVEsS0FBSyxHQUFHLE1BQU0sR0FBRyxXQUFXLEtBQUssSUFBSSxDQUFDO0FBQzNFLFdBQUssUUFBUSxNQUFNO0FBQ25CLFVBQUksdUJBQU8sU0FBUyxXQUFXLE1BQU0sK0JBQStCO0FBQUEsSUFDdEUsQ0FBQztBQUVELFNBQUssUUFBUSxNQUFNO0FBQUEsRUFDckI7QUFBQSxFQUVBLE1BQWMsV0FBVyxNQUF3QixXQUFXLElBQW1CO0FBQzdFLFNBQUssT0FBTztBQUNaLFNBQUssV0FBVztBQUNoQixTQUFLLFdBQVcsQ0FBQztBQUNqQixTQUFLLGlCQUFpQixDQUFDO0FBRXZCLFVBQU0sZUFBZSxLQUFLLEtBQUssYUFBYTtBQUM1QyxVQUFNLEtBQUssS0FBSyxhQUFhO0FBQUEsTUFDM0IsR0FBRztBQUFBLE1BQ0gsT0FBTztBQUFBLFFBQ0wsTUFBTSxLQUFLO0FBQUEsUUFDWCxVQUFVLEtBQUs7QUFBQSxNQUNqQjtBQUFBLElBQ0YsQ0FBQztBQUVELFNBQUssT0FBTztBQUFBLEVBQ2Q7QUFBQSxFQUVRLGlCQUF1QjtBQUM3QixVQUFNLE9BQU8sQ0FBQyxHQUFHLEtBQUssUUFBUSxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUSxJQUFJLFNBQVMsVUFBVSxJQUFJLFNBQVMsV0FBVztBQUN2RyxRQUFJLENBQUMsTUFBTTtBQUNULFVBQUksdUJBQU8sd0JBQXdCO0FBQ25DO0FBQUEsSUFDRjtBQUVBLFNBQUssZUFBZSxLQUFLLEVBQUUsTUFBTSxLQUFLLE1BQU0sU0FBUyxLQUFLLFFBQVEsQ0FBQztBQUNuRSxRQUFJLHVCQUFPLGlDQUFpQztBQUM1QyxTQUFLLE9BQU87QUFBQSxFQUNkO0FBQUEsRUFFUSxtQkFBbUIsbUJBQWlEO0FBQzFFLFVBQU0sWUFBWSxLQUFLLElBQUksR0FBRyxLQUFLLFNBQVMsSUFBSTtBQUNoRCxRQUFJLENBQUMsS0FBSyxxQkFBcUIsa0JBQWtCLFVBQVUsV0FBVztBQUNwRSxhQUFPLENBQUMsR0FBRyxLQUFLLGdCQUFnQixHQUFHLGtCQUFrQixNQUFNLENBQUMsU0FBUyxDQUFDO0FBQUEsSUFDeEU7QUFFQSxXQUFPLENBQUMsR0FBRyxLQUFLLGdCQUFnQixHQUFHLGtCQUFrQixNQUFNLENBQUMsU0FBUyxDQUFDO0FBQUEsRUFDeEU7QUFBQSxFQUVBLE1BQWMsc0JBQXNCLG1CQUFpRDtBQUNuRixVQUFNLFlBQVksS0FBSyxJQUFJLEdBQUcsS0FBSyxTQUFTLElBQUk7QUFDaEQsUUFBSSxDQUFDLEtBQUsscUJBQXFCLGtCQUFrQixVQUFVLFdBQVc7QUFDcEU7QUFBQSxJQUNGO0FBRUEsVUFBTSxRQUFRLGtCQUFrQixNQUFNLEdBQUcsQ0FBQyxTQUFTO0FBQ25ELFFBQUksQ0FBQyxNQUFNLFFBQVE7QUFDakI7QUFBQSxJQUNGO0FBRUEsVUFBTSxVQUFVLE1BQU0sS0FBSyxPQUFPLHNCQUFzQixLQUFLO0FBQzdELFFBQUksQ0FBQyxTQUFTO0FBQ1o7QUFBQSxJQUNGO0FBRUEsU0FBSyxzQkFBc0IsS0FBSyxzQkFDNUIsR0FBRyxLQUFLLG1CQUFtQjtBQUFBLElBQU8sT0FBTyxLQUN6QztBQUFBLEVBQ047QUFBQSxFQUVRLG9CQUFvQixRQUFxQixRQUFnQixRQUEyQjtBQUMxRixRQUFJLEtBQUssT0FBTyxTQUFTLGtCQUFrQixVQUFVO0FBQ25EO0FBQUEsSUFDRjtBQUVBLFVBQU0sWUFBWSxLQUFLLE9BQU8saUJBQWlCLFFBQVEsTUFBTTtBQUM3RCxRQUFJLENBQUMsVUFBVSxRQUFRO0FBQ3JCO0FBQUEsSUFDRjtBQUVBLFVBQU0sT0FBTyxPQUFPLFVBQVUsRUFBRSxLQUFLLHlDQUF5QyxDQUFDO0FBQy9FLFNBQUssVUFBVTtBQUFBLE1BQ2IsS0FBSztBQUFBLE1BQ0wsTUFBTTtBQUFBLElBQ1IsQ0FBQztBQUNELFVBQU0sT0FBTyxLQUFLLFNBQVMsTUFBTSxFQUFFLEtBQUssOENBQThDLENBQUM7QUFDdkYsZUFBVyxZQUFZLFdBQVc7QUFDaEMsWUFBTSxLQUFLLEtBQUssU0FBUyxJQUFJO0FBQzdCLFlBQU0sT0FBTyxHQUFHLFNBQVMsS0FBSyxFQUFFLE1BQU0sSUFBSSxTQUFTLE1BQU0sS0FBSyxTQUFTLEtBQUssSUFBSSxJQUFJLE1BQU0sSUFBSSxDQUFDO0FBQy9GLFdBQUssaUJBQWlCLFNBQVMsT0FBTyxVQUFVO0FBQzlDLGNBQU0sZUFBZTtBQUNyQixjQUFNLEtBQUssSUFBSSxVQUFVLFFBQVEsSUFBSSxFQUFFLFNBQVMsU0FBUyxJQUFJO0FBQUEsTUFDL0QsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBQUEsRUFFUSxzQkFBc0IsUUFBcUIsUUFBZ0IsUUFBMkI7QUFDNUYsVUFBTSxrQkFBa0IsS0FBSyxPQUFPLG1CQUFtQixRQUFRLE1BQU07QUFDckUsUUFBSSxDQUFDLGdCQUFnQixRQUFRO0FBQzNCO0FBQUEsSUFDRjtBQUVBLFVBQU0sV0FBVyxPQUFPLFVBQVUsRUFBRSxLQUFLLHlDQUF5QyxDQUFDO0FBQ25GLGFBQVMsVUFBVTtBQUFBLE1BQ2pCLEtBQUs7QUFBQSxNQUNMLE1BQU07QUFBQSxJQUNSLENBQUM7QUFFRCxVQUFNLFdBQVcsU0FBUyxTQUFTLE1BQU0sRUFBRSxLQUFLLDhDQUE4QyxDQUFDO0FBQy9GLGVBQVcsUUFBUSxpQkFBaUI7QUFDbEMsWUFBTSxLQUFLLFNBQVMsU0FBUyxJQUFJO0FBQ2pDLFlBQU0sT0FBTyxHQUFHLFNBQVMsS0FBSyxFQUFFLE1BQU0sS0FBSyxNQUFNLE1BQU0sSUFBSSxDQUFDO0FBQzVELFdBQUssaUJBQWlCLFNBQVMsT0FBTyxVQUFVO0FBQzlDLGNBQU0sZUFBZTtBQUNyQixjQUFNLEtBQUssSUFBSSxVQUFVLFFBQVEsSUFBSSxFQUFFLFNBQVMsSUFBSTtBQUFBLE1BQ3RELENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUFBLEVBRVEscUJBQXFCLFFBQTJCO0FBQ3RELFFBQUksQ0FBQyxLQUFLLGVBQWUsUUFBUTtBQUMvQjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFFBQVEsT0FBTyxVQUFVLEVBQUUsS0FBSyxpQ0FBaUMsQ0FBQztBQUN4RSxVQUFNLFVBQVU7QUFBQSxNQUNkLEtBQUs7QUFBQSxNQUNMLE1BQU0sb0JBQW9CLEtBQUssZUFBZSxNQUFNO0FBQUEsSUFDdEQsQ0FBQztBQUVELFVBQU0sT0FBTyxNQUFNLFNBQVMsTUFBTSxFQUFFLEtBQUssOENBQThDLENBQUM7QUFDeEYsZUFBVyxVQUFVLEtBQUssZ0JBQWdCO0FBQ3hDLFlBQU0sS0FBSyxLQUFLLFNBQVMsSUFBSTtBQUM3QixTQUFHLFFBQVEsS0FBSyxlQUFlLE1BQU0sQ0FBQztBQUFBLElBQ3hDO0FBRUEsVUFBTSxVQUFVLE1BQU0sVUFBVSxFQUFFLEtBQUsseUNBQXlDLENBQUM7QUFDakYsVUFBTSxnQkFBZ0IsUUFBUSxTQUFTLFVBQVUsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQzVFLFVBQU0sZ0JBQWdCLFFBQVEsU0FBUyxVQUFVLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFcEUsa0JBQWMsaUJBQWlCLFNBQVMsWUFBWTtBQUNsRCxVQUFJO0FBQ0Ysc0JBQWMsV0FBVztBQUN6QixzQkFBYyxXQUFXO0FBQ3pCLGNBQU0sVUFBVSxNQUFNLEtBQUssT0FBTyxrQkFBa0IsS0FBSyxjQUFjO0FBQ3ZFLGFBQUssaUJBQWlCLENBQUM7QUFDdkIsY0FBTSxPQUFPO0FBQ2IsWUFBSSx1QkFBTyxPQUFPO0FBQ2xCLGFBQUssV0FBVyxhQUFhLG9CQUFvQixPQUFPO0FBQUEsTUFDMUQsU0FBUyxPQUFPO0FBQ2Qsc0JBQWMsV0FBVztBQUN6QixzQkFBYyxXQUFXO0FBQ3pCLFlBQUksdUJBQU8sNEJBQTRCLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxPQUFPLEtBQUssQ0FBQyxFQUFFO0FBQUEsTUFDakc7QUFBQSxJQUNGLENBQUM7QUFFRCxrQkFBYyxpQkFBaUIsU0FBUyxNQUFNO0FBQzVDLFdBQUssaUJBQWlCLENBQUM7QUFDdkIsVUFBSSx1QkFBTyw0QkFBNEI7QUFDdkMsWUFBTSxPQUFPO0FBQUEsSUFDZixDQUFDO0FBQUEsRUFDSDtBQUFBLEVBRVEsb0NBQW9DLE1BQWMsUUFBNkI7QUFDckYsV0FBTyxLQUFLLFFBQVEsY0FBYyxDQUFDLE1BQU0sWUFBb0I7QUFDM0QsWUFBTSxNQUFNLE9BQU8sU0FBUyxTQUFTLEVBQUU7QUFDdkMsVUFBSSxDQUFDLE9BQU8sU0FBUyxHQUFHLEtBQUssTUFBTSxLQUFLLE1BQU0sT0FBTyxRQUFRO0FBQzNELGVBQU87QUFBQSxNQUNUO0FBRUEsWUFBTSxPQUFPLE9BQU8sTUFBTSxDQUFDLEdBQUc7QUFDOUIsVUFBSSxDQUFDLE1BQU07QUFDVCxlQUFPO0FBQUEsTUFDVDtBQUVBLGFBQU8sS0FBSyxJQUFJO0FBQUEsSUFDbEIsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQUVRLGdDQUFnQyxTQUF3QixRQUFvQztBQUNsRyxXQUFPLFFBQVEsSUFBSSxDQUFDLFdBQVc7QUFDN0IsVUFBSSxPQUFPLFNBQVMsZUFBZTtBQUNqQyxlQUFPO0FBQUEsVUFDTCxHQUFHO0FBQUEsVUFDSCxTQUFTLEtBQUssb0NBQW9DLE9BQU8sU0FBUyxNQUFNO0FBQUEsUUFDMUU7QUFBQSxNQUNGO0FBRUEsVUFBSSxPQUFPLFNBQVMsZUFBZTtBQUNqQyxlQUFPO0FBQUEsVUFDTCxHQUFHO0FBQUEsVUFDSCxTQUFTLEtBQUssb0NBQW9DLE9BQU8sU0FBUyxNQUFNO0FBQUEsUUFDMUU7QUFBQSxNQUNGO0FBRUEsVUFBSSxPQUFPLFNBQVMsd0JBQXdCO0FBQzFDLGVBQU87QUFBQSxVQUNMLEdBQUc7QUFBQSxVQUNILFNBQVMsS0FBSyxvQ0FBb0MsT0FBTyxTQUFTLE1BQU07QUFBQSxRQUMxRTtBQUFBLE1BQ0Y7QUFFQSxVQUFJLE9BQU8sU0FBUyxtQkFBbUI7QUFDckMsZUFBTztBQUFBLFVBQ0wsR0FBRztBQUFBLFVBQ0gsU0FBUyxLQUFLLG9DQUFvQyxPQUFPLFNBQVMsTUFBTTtBQUFBLFFBQzFFO0FBQUEsTUFDRjtBQUVBLFVBQUksT0FBTyxTQUFTLHdCQUF3QjtBQUMxQyxjQUFNLE9BQU8sT0FBTyxhQUFhLENBQUM7QUFDbEMsY0FBTSxjQUFzQyxDQUFDO0FBQzdDLG1CQUFXLENBQUMsS0FBSyxLQUFLLEtBQUssT0FBTyxRQUFRLElBQUksR0FBRztBQUMvQyxzQkFBWSxHQUFHLElBQUksS0FBSyxvQ0FBb0MsT0FBTyxNQUFNO0FBQUEsUUFDM0U7QUFFQSxlQUFPO0FBQUEsVUFDTCxHQUFHO0FBQUEsVUFDSCxXQUFXO0FBQUEsUUFDYjtBQUFBLE1BQ0Y7QUFFQSxhQUFPO0FBQUEsSUFDVCxDQUFDO0FBQUEsRUFDSDtBQUFBLEVBRVEsZUFBZSxRQUE2QjtBQUNsRCxRQUFJLE9BQU8sU0FBUyxpQkFBaUI7QUFDbkMsYUFBTyxrQkFBa0IsT0FBTyxJQUFJO0FBQUEsSUFDdEM7QUFDQSxRQUFJLE9BQU8sU0FBUyxlQUFlO0FBQ2pDLGFBQU8sZ0JBQWdCLE9BQU8sSUFBSSxHQUFHLE9BQU8sWUFBWSxpQkFBaUIsRUFBRTtBQUFBLElBQzdFO0FBQ0EsUUFBSSxPQUFPLFNBQVMsZUFBZTtBQUNqQyxhQUFPLGdCQUFnQixPQUFPLElBQUk7QUFBQSxJQUNwQztBQUNBLFFBQUksT0FBTyxTQUFTLHdCQUF3QjtBQUMxQyxhQUFPLHlCQUF5QixPQUFPLElBQUksVUFBVSxPQUFPLE9BQU87QUFBQSxJQUNyRTtBQUNBLFFBQUksT0FBTyxTQUFTLG1CQUFtQjtBQUNyQyxhQUFPLG9CQUFvQixPQUFPLElBQUksVUFBVyxPQUFPLElBQUk7QUFBQSxJQUM5RDtBQUNBLFdBQU8seUJBQXlCLE9BQU8sUUFBUSxPQUFPLE9BQU8sSUFBSTtBQUFBLEVBQ25FO0FBQUEsRUFFQSxNQUFjLG1CQUFtQixhQUF1QztBQUN0RSxRQUFJLENBQUMsWUFBWSxXQUFXLEdBQUcsR0FBRztBQUNoQyxhQUFPO0FBQUEsSUFDVDtBQUVBLFVBQU0sQ0FBQyxTQUFTLEdBQUcsSUFBSSxJQUFJLFlBQVksTUFBTSxDQUFDLEVBQUUsS0FBSyxFQUFFLE1BQU0sS0FBSztBQUNsRSxVQUFNLE1BQU0sS0FBSyxLQUFLLEdBQUcsRUFBRSxLQUFLO0FBRWhDLFlBQVEsUUFBUSxZQUFZLEdBQUc7QUFBQSxNQUM3QixLQUFLO0FBQ0gsYUFBSztBQUFBLFVBQ0g7QUFBQSxVQUNBO0FBQUEsWUFDRTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsVUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLFFBQ2I7QUFDQSxlQUFPO0FBQUEsTUFDVCxLQUFLO0FBQ0gsWUFBSSxDQUFDLEtBQUs7QUFDUixlQUFLLFdBQVcsYUFBYSxrQkFBa0IsS0FBSyxPQUFPLFNBQVMsS0FBSyxFQUFFO0FBQUEsUUFDN0UsT0FBTztBQUNMLGVBQUssT0FBTyxTQUFTLFFBQVE7QUFDN0IsZ0JBQU0sS0FBSyxPQUFPLGFBQWE7QUFDL0IsZUFBSyxXQUFXLGFBQWEsaUJBQWlCLEdBQUcsRUFBRTtBQUFBLFFBQ3JEO0FBQ0EsZUFBTztBQUFBLE1BQ1QsS0FBSztBQUNILGNBQU0sS0FBSyxPQUFPLGFBQWE7QUFDL0IsYUFBSyxXQUFXLGFBQWEsc0JBQXNCO0FBQ25ELGVBQU87QUFBQSxNQUNULEtBQUs7QUFDSCxhQUFLLFdBQVcsQ0FBQztBQUNqQixhQUFLLGlCQUFpQixDQUFDO0FBQ3ZCLGFBQUssc0JBQXNCO0FBQzNCLGFBQUssYUFBYSxNQUFNO0FBQ3hCLGVBQU87QUFBQSxNQUNULEtBQUs7QUFDSCxjQUFNLEtBQUssU0FBUztBQUNwQixlQUFPO0FBQUEsTUFDVCxLQUFLO0FBQ0gsWUFBSSxRQUFRLFNBQVM7QUFDbkIsZ0JBQU0sS0FBSyxXQUFXLE9BQU87QUFBQSxRQUMvQixXQUFXLFFBQVEsUUFBUTtBQUN6QixnQkFBTSxhQUFhLEtBQUssSUFBSSxVQUFVLGNBQWM7QUFDcEQsY0FBSSxDQUFDLGNBQWMsV0FBVyxjQUFjLE1BQU07QUFDaEQsZ0JBQUksdUJBQU8sNkJBQTZCO0FBQUEsVUFDMUMsT0FBTztBQUNMLGtCQUFNLEtBQUssV0FBVyxRQUFRLFdBQVcsSUFBSTtBQUFBLFVBQy9DO0FBQUEsUUFDRixPQUFPO0FBQ0wsZUFBSyxXQUFXLGFBQWEseUJBQXlCO0FBQUEsUUFDeEQ7QUFDQSxlQUFPO0FBQUEsTUFDVCxLQUFLO0FBQ0gsWUFBSSxDQUFDLEtBQUs7QUFDUixlQUFLLFdBQVcsYUFBYSxzQkFBc0I7QUFDbkQsaUJBQU87QUFBQSxRQUNUO0FBQ0EsYUFBSyxXQUFXLEdBQUc7QUFDbkIsZUFBTztBQUFBLE1BQ1QsS0FBSztBQUNILFlBQUksQ0FBQyxLQUFLO0FBQ1IsZUFBSyxXQUFXLGFBQWEsbUJBQW1CO0FBQ2hELGlCQUFPO0FBQUEsUUFDVDtBQUNBLGNBQU0sS0FBSyxVQUFVLElBQUksUUFBUSxNQUFNLEVBQUUsQ0FBQztBQUMxQyxlQUFPO0FBQUEsTUFDVCxLQUFLO0FBQ0gsWUFBSSxDQUFDLEtBQUs7QUFDUixlQUFLLFdBQVcsYUFBYSw4QkFBOEI7QUFDM0QsaUJBQU87QUFBQSxRQUNUO0FBQ0EsY0FBTSxLQUFLLFdBQVcsR0FBRztBQUN6QixlQUFPO0FBQUEsTUFDVCxLQUFLO0FBQ0gsWUFBSSxDQUFDLEtBQUs7QUFDUixlQUFLLGVBQWU7QUFBQSxRQUN0QixPQUFPO0FBQ0wsZUFBSyxlQUFlLEtBQUssRUFBRSxNQUFNLFFBQVEsU0FBUyxJQUFJLENBQUM7QUFDdkQsZUFBSyxXQUFXLGFBQWEsV0FBVyxHQUFHLEVBQUU7QUFBQSxRQUMvQztBQUNBLGVBQU87QUFBQSxNQUNULEtBQUs7QUFDSCxhQUFLO0FBQUEsVUFDSDtBQUFBLFVBQ0EsS0FBSyxlQUFlLFNBQ2hCLEtBQUssZUFBZSxJQUFJLENBQUMsS0FBSyxRQUFRLEdBQUcsTUFBTSxDQUFDLEtBQUssSUFBSSxJQUFJLEtBQUssSUFBSSxPQUFPLEVBQUUsRUFBRSxLQUFLLElBQUksSUFDMUY7QUFBQSxRQUNOO0FBQ0EsZUFBTztBQUFBLE1BQ1Q7QUFDRSxhQUFLLFdBQVcsYUFBYSxxQkFBcUIsT0FBTyxjQUFjO0FBQ3ZFLGVBQU87QUFBQSxJQUNYO0FBQUEsRUFDRjtBQUFBLEVBRVEsV0FBVyxPQUFxQjtBQUN0QyxVQUFNLElBQUksTUFBTSxZQUFZO0FBQzVCLFVBQU0sUUFBUSxLQUFLLElBQUksTUFDcEIsaUJBQWlCLEVBQ2pCLE9BQU8sQ0FBQyxTQUFTLEtBQUssS0FBSyxZQUFZLEVBQUUsU0FBUyxDQUFDLENBQUMsRUFDcEQsTUFBTSxHQUFHLEVBQUU7QUFFZCxRQUFJLENBQUMsTUFBTSxRQUFRO0FBQ2pCLFdBQUssV0FBVyxhQUFhLHVCQUF1QixLQUFLLEVBQUU7QUFDM0Q7QUFBQSxJQUNGO0FBRUEsU0FBSyxXQUFXLGFBQWEsTUFBTSxJQUFJLENBQUMsU0FBUyxLQUFLLEtBQUssSUFBSSxFQUFFLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFBQSxFQUMvRTtBQUFBLEVBRUEsTUFBYyxVQUFVLEtBQTRCO0FBQ2xELFVBQU0sUUFBUSxLQUFLLElBQUksTUFBTSxpQkFBaUI7QUFDOUMsVUFBTSxVQUFvQixDQUFDO0FBRTNCLGVBQVcsUUFBUSxPQUFPO0FBQ3hCLFlBQU0sT0FBTyxNQUFNLEtBQUssSUFBSSxNQUFNLFdBQVcsSUFBSTtBQUNqRCxZQUFNLGVBQWUsSUFBSSxPQUFPLFdBQVcsR0FBRyxlQUFlLEdBQUcsRUFBRSxLQUFLLElBQUk7QUFDM0UsWUFBTSxvQkFBb0IsSUFBSSxPQUFPLHNCQUFzQixHQUFHLFFBQVEsSUFBSSxFQUFFLEtBQUssSUFBSTtBQUNyRixVQUFJLGdCQUFnQixtQkFBbUI7QUFDckMsZ0JBQVEsS0FBSyxLQUFLLElBQUk7QUFBQSxNQUN4QjtBQUNBLFVBQUksUUFBUSxVQUFVLElBQUk7QUFDeEI7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUVBLFNBQUs7QUFBQSxNQUNIO0FBQUEsTUFDQSxRQUFRLFNBQVMsUUFBUSxJQUFJLENBQUMsU0FBUyxLQUFLLElBQUksRUFBRSxFQUFFLEtBQUssSUFBSSxJQUFJLDJCQUEyQixHQUFHO0FBQUEsSUFDakc7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFjLFdBQVcsT0FBOEI7QUFDckQsVUFBTSxJQUFJLE1BQU0sWUFBWTtBQUM1QixVQUFNLE9BQU8sS0FBSyxJQUFJLE1BQ25CLGlCQUFpQixFQUNqQixLQUFLLENBQUMsY0FBYyxVQUFVLEtBQUssWUFBWSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0FBRS9ELFFBQUksQ0FBQyxNQUFNO0FBQ1QsV0FBSyxXQUFXLGFBQWEsaUNBQWlDLEtBQUssRUFBRTtBQUNyRTtBQUFBLElBQ0Y7QUFFQSxVQUFNLEtBQUssSUFBSSxVQUFVLFFBQVEsSUFBSSxFQUFFLFNBQVMsSUFBSTtBQUNwRCxTQUFLLFdBQVcsYUFBYSxXQUFXLEtBQUssSUFBSSxFQUFFO0FBQUEsRUFDckQ7QUFBQSxFQUVRLFdBQ04sTUFDQSxNQUNBLFVBQ0Esa0JBQTJCLENBQUMsR0FDNUIsY0FDTTtBQUNOLFVBQU0sU0FBUyxLQUFLLGFBQWEsVUFBVTtBQUFBLE1BQ3pDLEtBQUsscUVBQXFFLElBQUk7QUFBQSxJQUNoRixDQUFDO0FBRUQsV0FBTyxVQUFVO0FBQUEsTUFDZixLQUFLO0FBQUEsTUFDTCxNQUFNLFNBQVMsU0FBUyxRQUFRO0FBQUEsSUFDbEMsQ0FBQztBQUVELFVBQU0sWUFBWSxPQUFPLFVBQVU7QUFBQSxNQUNqQyxLQUFLO0FBQUEsTUFDTDtBQUFBLElBQ0YsQ0FBQztBQUVELFFBQUksU0FBUyxhQUFhO0FBQ3hCLFdBQUssS0FBSyx3QkFBd0IsV0FBVyxJQUFJO0FBQUEsSUFDbkQ7QUFFQSxRQUFJLFNBQVMsZUFBZSxjQUFjO0FBQ3hDLGFBQU8sVUFBVTtBQUFBLFFBQ2YsS0FBSztBQUFBLFFBQ0wsTUFBTTtBQUFBLE1BQ1IsQ0FBQztBQUFBLElBQ0g7QUFFQSxRQUFJLFVBQVU7QUFDWixhQUFPLFVBQVU7QUFBQSxRQUNmLEtBQUs7QUFBQSxRQUNMLE1BQU07QUFBQSxNQUNSLENBQUM7QUFBQSxJQUNIO0FBRUEsUUFBSSxTQUFTLGVBQWUsZ0JBQWdCLFFBQVE7QUFDbEQsWUFBTSxXQUFXLE9BQU8sVUFBVSxFQUFFLEtBQUsseUNBQXlDLENBQUM7QUFDbkYsZUFBUyxVQUFVO0FBQUEsUUFDakIsS0FBSztBQUFBLFFBQ0wsTUFBTTtBQUFBLE1BQ1IsQ0FBQztBQUVELFlBQU0sV0FBVyxTQUFTLFNBQVMsTUFBTSxFQUFFLEtBQUssOENBQThDLENBQUM7QUFDL0YsaUJBQVcsUUFBUSxpQkFBaUI7QUFDbEMsY0FBTSxLQUFLLFNBQVMsU0FBUyxJQUFJO0FBQ2pDLGNBQU0sT0FBTyxHQUFHLFNBQVMsS0FBSyxFQUFFLE1BQU0sS0FBSyxNQUFNLE1BQU0sSUFBSSxDQUFDO0FBQzVELGFBQUssaUJBQWlCLFNBQVMsT0FBTyxVQUFVO0FBQzlDLGdCQUFNLGVBQWU7QUFDckIsZ0JBQU0sS0FBSyxJQUFJLFVBQVUsUUFBUSxJQUFJLEVBQUUsU0FBUyxJQUFJO0FBQUEsUUFDdEQsQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGO0FBRUEsU0FBSyxhQUFhLFlBQVksS0FBSyxhQUFhO0FBQUEsRUFDbEQ7QUFBQSxFQUVBLE1BQWMsY0FBNkI7QUFDekMsVUFBTSxXQUFXLEtBQUssUUFBUSxNQUFNLEtBQUs7QUFDekMsUUFBSSxDQUFDLFVBQVU7QUFDYjtBQUFBLElBQ0Y7QUFFQSxRQUFJLE1BQU0sS0FBSyxtQkFBbUIsUUFBUSxHQUFHO0FBQzNDLFdBQUssUUFBUSxRQUFRO0FBQ3JCO0FBQUEsSUFDRjtBQUVBLFFBQUksS0FBSyxTQUFTLFVBQVUsQ0FBQyxLQUFLLFVBQVU7QUFDMUMsWUFBTSxhQUFhLEtBQUssSUFBSSxVQUFVLGNBQWM7QUFDcEQsVUFBSSxDQUFDLGNBQWMsV0FBVyxjQUFjLE1BQU07QUFDaEQsWUFBSSx1QkFBTyw2QkFBNkI7QUFDeEM7QUFBQSxNQUNGO0FBQ0EsV0FBSyxXQUFXLFdBQVc7QUFBQSxJQUM3QjtBQUVBLFVBQU0sb0JBQW9CLENBQUMsR0FBRyxLQUFLLFFBQVE7QUFDM0MsVUFBTSxLQUFLLHNCQUFzQixpQkFBaUI7QUFDbEQsVUFBTSxlQUFlLEtBQUssbUJBQW1CLGlCQUFpQjtBQUU5RCxRQUFJLEtBQUsscUJBQXFCO0FBQzVCLG1CQUFhLFFBQVE7QUFBQSxRQUNuQixNQUFNO0FBQUEsUUFDTixTQUFTO0FBQUEsRUFBaUMsS0FBSyxtQkFBbUI7QUFBQSxNQUNwRSxDQUFDO0FBQUEsSUFDSDtBQUVBLFNBQUssU0FBUyxLQUFLLEVBQUUsTUFBTSxRQUFRLFNBQVMsU0FBUyxDQUFDO0FBQ3RELFNBQUssV0FBVyxRQUFRLFFBQVE7QUFDaEMsU0FBSyxRQUFRLFFBQVE7QUFDckIsU0FBSyxhQUFhLFdBQVc7QUFDN0IsU0FBSyxhQUFhLFdBQVc7QUFFN0IsVUFBTSxrQkFBa0IsS0FBSyxhQUFhLFVBQVU7QUFBQSxNQUNsRCxLQUFLO0FBQUEsSUFDUCxDQUFDO0FBQ0Qsb0JBQWdCLFVBQVU7QUFBQSxNQUN4QixLQUFLO0FBQUEsTUFDTCxNQUFNO0FBQUEsSUFDUixDQUFDO0FBQ0QsVUFBTSxxQkFBcUIsZ0JBQWdCLFVBQVU7QUFBQSxNQUNuRCxLQUFLO0FBQUEsTUFDTCxNQUFNO0FBQUEsSUFDUixDQUFDO0FBQ0QsVUFBTSx3QkFBd0IsZ0JBQWdCLFVBQVU7QUFBQSxNQUN0RCxLQUFLO0FBQUEsSUFDUCxDQUFDO0FBQ0QsVUFBTSw0QkFBNEIsc0JBQXNCLFNBQVMsVUFBVTtBQUFBLE1BQ3pFLEtBQUs7QUFBQSxNQUNMLE1BQU07QUFBQSxJQUNSLENBQUM7QUFDRCxVQUFNLHNCQUFzQixzQkFBc0IsVUFBVTtBQUFBLE1BQzFELEtBQUs7QUFBQSxNQUNMLE1BQU07QUFBQSxJQUNSLENBQUM7QUFDRCxVQUFNLGtCQUFrQixnQkFBZ0IsVUFBVTtBQUFBLE1BQ2hELEtBQUs7QUFBQSxNQUNMLE1BQU07QUFBQSxJQUNSLENBQUM7QUFDRCxVQUFNLGVBQWUsS0FBSyxPQUFPLFNBQVM7QUFFMUMsUUFBSSxpQkFBaUI7QUFDckIsUUFBSSxtQkFBbUI7QUFDdkIsUUFBSSxtQkFBbUI7QUFFdkIsVUFBTSxzQkFBc0IsQ0FBQyxVQUFtQixjQUE2QjtBQUMzRSx5QkFBbUI7QUFDbkIsNEJBQXNCLFlBQVksZ0JBQWdCLENBQUMsZ0JBQWdCO0FBQ25FLFVBQUksa0JBQWtCO0FBQ3BCLFlBQUksV0FBVztBQUNiLG9DQUEwQjtBQUFBLFlBQ3hCLG1CQUFtQix5QkFBeUI7QUFBQSxVQUM5QztBQUFBLFFBQ0YsT0FBTztBQUNMLG9DQUEwQixRQUFRLG1CQUFtQixhQUFhLHNCQUFzQjtBQUFBLFFBQzFGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFFQSw4QkFBMEIsaUJBQWlCLFNBQVMsTUFBTTtBQUN4RCwwQkFBb0IsQ0FBQyxrQkFBa0IsS0FBSztBQUFBLElBQzlDLENBQUM7QUFFRCxRQUFJO0FBQ0YsVUFBSSxLQUFLLFNBQVMsUUFBUTtBQUN4QixjQUFNLFNBQVMsTUFBTSxLQUFLLE9BQU8sbUJBQW1CLEtBQUssVUFBVSxVQUFVLGNBQWM7QUFBQSxVQUN6RixlQUFlLENBQUMsVUFBVTtBQUN4Qiw4QkFBa0I7QUFDbEIsK0JBQW1CLFFBQVEsY0FBYztBQUN6QyxpQkFBSyxhQUFhLFlBQVksS0FBSyxhQUFhO0FBQUEsVUFDbEQ7QUFBQSxVQUNBLGlCQUFpQixDQUFDLFVBQVU7QUFDMUIsZ0JBQUksaUJBQWlCLFVBQVU7QUFDN0I7QUFBQSxZQUNGO0FBRUEsZ0NBQW9CO0FBQ3BCLGdDQUFvQixRQUFRLGdCQUFnQjtBQUM1QyxnQ0FBb0IsTUFBTSxJQUFJO0FBQzlCLGlCQUFLLGFBQWEsWUFBWSxLQUFLLGFBQWE7QUFBQSxVQUNsRDtBQUFBLFFBQ0YsQ0FBQztBQUVELGFBQUssU0FBUyxLQUFLLEVBQUUsTUFBTSxhQUFhLFNBQVMsT0FBTyxPQUFPLENBQUM7QUFDaEUsY0FBTSxhQUNKLE9BQU8sT0FBTyxTQUFTLElBQ25CLDJCQUEyQixPQUFPLE9BQU8sTUFBTSxLQUMvQztBQUVOLGNBQU0sS0FBSyx3QkFBd0Isb0JBQW9CLE9BQU8sUUFBUSxPQUFPLE1BQU07QUFDbkYsd0JBQWdCLFFBQVEsVUFBVTtBQUNsQyxhQUFLLG9CQUFvQixpQkFBaUIsT0FBTyxRQUFRLE9BQU8sTUFBTTtBQUN0RSxhQUFLLHNCQUFzQixpQkFBaUIsT0FBTyxRQUFRLE9BQU8sTUFBTTtBQUFBLE1BQzFFLE9BQU87QUFDTCxjQUFNLFNBQVMsTUFBTSxLQUFLLE9BQU8sb0JBQW9CLFVBQVUsY0FBYztBQUFBLFVBQzNFLGVBQWUsQ0FBQyxVQUFVO0FBQ3hCLDhCQUFrQjtBQUNsQiwrQkFBbUIsUUFBUSxjQUFjO0FBQ3pDLGlCQUFLLGFBQWEsWUFBWSxLQUFLLGFBQWE7QUFBQSxVQUNsRDtBQUFBLFVBQ0EsaUJBQWlCLENBQUMsVUFBVTtBQUMxQixnQkFBSSxpQkFBaUIsVUFBVTtBQUM3QjtBQUFBLFlBQ0Y7QUFFQSxnQ0FBb0I7QUFDcEIsZ0NBQW9CLFFBQVEsZ0JBQWdCO0FBQzVDLGdDQUFvQixNQUFNLElBQUk7QUFDOUIsaUJBQUssYUFBYSxZQUFZLEtBQUssYUFBYTtBQUFBLFVBQ2xEO0FBQUEsUUFDRixDQUFDO0FBRUQsYUFBSyxTQUFTLEtBQUssRUFBRSxNQUFNLGFBQWEsU0FBUyxPQUFPLE9BQU8sQ0FBQztBQUNoRSxjQUFNLFlBQXNCLENBQUM7QUFDN0Isa0JBQVU7QUFBQSxVQUNSLE9BQU8sT0FBTyxTQUFTLElBQ25CLHVCQUF1QixPQUFPLE9BQU8sTUFBTSxLQUMzQztBQUFBLFFBQ047QUFFQSxjQUFNLEtBQUssd0JBQXdCLG9CQUFvQixPQUFPLFFBQVEsT0FBTyxNQUFNO0FBQ25GLHdCQUFnQixRQUFRLFVBQVUsS0FBSyxLQUFLLENBQUM7QUFFN0MsYUFBSyxpQkFBaUIsS0FBSyxnQ0FBZ0MsT0FBTyxnQkFBZ0IsT0FBTyxNQUFNO0FBRS9GLGFBQUssb0JBQW9CLGlCQUFpQixPQUFPLFFBQVEsT0FBTyxNQUFNO0FBQ3RFLGFBQUssc0JBQXNCLGlCQUFpQixPQUFPLFFBQVEsT0FBTyxNQUFNO0FBQ3hFLGFBQUsscUJBQXFCLGVBQWU7QUFBQSxNQUMzQztBQUVBLFVBQUksaUJBQWlCLFlBQVksQ0FBQyxrQkFBa0I7QUFDbEQsOEJBQXNCLE9BQU87QUFBQSxNQUMvQixPQUFPO0FBQ0wsNEJBQW9CLGlCQUFpQixZQUFZLEtBQUs7QUFBQSxNQUN4RDtBQUFBLElBQ0YsU0FBUyxPQUFPO0FBQ2Qsc0JBQWdCLFFBQVEsUUFBUTtBQUNoQyxjQUFRLE1BQU0sdUJBQXVCLEtBQUs7QUFDMUMsVUFBSSx1QkFBTyxnQkFBZ0IsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLE9BQU8sS0FBSyxDQUFDLEVBQUU7QUFBQSxJQUNyRixVQUFFO0FBQ0EsV0FBSyxhQUFhLFdBQVc7QUFDN0IsV0FBSyxhQUFhLFdBQVc7QUFDN0IsV0FBSyxRQUFRLE1BQU07QUFBQSxJQUNyQjtBQUFBLEVBQ0Y7QUFBQSxFQUVBLE1BQWMsV0FBMEI7QUFDdEMsUUFBSTtBQUNGLFlBQU0sUUFBUSxLQUFLLFNBQVMsU0FBUyxzQkFBc0I7QUFDM0QsWUFBTSxPQUFPLE1BQU0sS0FBSyxPQUFPLGVBQWUsT0FBTyxLQUFLLFFBQVE7QUFDbEUsVUFBSSx1QkFBTyxlQUFlLEtBQUssSUFBSSxFQUFFO0FBQ3JDLFlBQU0sS0FBSyxJQUFJLFVBQVUsUUFBUSxJQUFJLEVBQUUsU0FBUyxJQUFJO0FBQUEsSUFDdEQsU0FBUyxPQUFPO0FBQ2QsVUFBSSx1QkFBTyx3QkFBd0IsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLE9BQU8sS0FBSyxDQUFDLEVBQUU7QUFBQSxJQUM3RjtBQUFBLEVBQ0Y7QUFBQSxFQUVRLDJCQUEyQixNQUFjLFNBQXNCLENBQUMsR0FBVztBQUNqRixVQUFNLFlBQVksS0FBSyxJQUFJLE1BQU0sUUFBUTtBQUN6QyxRQUFJLFNBQVM7QUFDYixVQUFNLFFBQVEsS0FBSyxPQUFPLFNBQVM7QUFHbkMsYUFBUyxPQUFPLFFBQVEsd0JBQXdCLE1BQU07QUFFdEQsVUFBTSxjQUFjLENBQUMsWUFBbUM7QUFDdEQsWUFBTSxNQUFNLE9BQU8sU0FBUyxTQUFTLEVBQUU7QUFDdkMsVUFBSSxDQUFDLE9BQU8sU0FBUyxHQUFHLEtBQUssTUFBTSxLQUFLLE1BQU0sT0FBTyxRQUFRO0FBQzNELGVBQU87QUFBQSxNQUNUO0FBRUEsWUFBTSxPQUFPLE9BQU8sTUFBTSxDQUFDLEdBQUc7QUFDOUIsVUFBSSxDQUFDLE1BQU07QUFDVCxlQUFPO0FBQUEsTUFDVDtBQUVBLGFBQU8seUJBQXlCLG1CQUFtQixTQUFTLENBQUMsU0FBUyxtQkFBbUIsSUFBSSxDQUFDO0FBQUEsSUFDaEc7QUFFQSxRQUFJLFVBQVUsVUFBVTtBQUV0QixlQUFTLE9BQU87QUFBQSxRQUNkO0FBQUEsUUFDQSxDQUFDLE1BQU0sUUFBZ0IsWUFBb0I7QUFDekMsZ0JBQU0sTUFBTSxZQUFZLE9BQU87QUFDL0IsY0FBSSxDQUFDLEtBQUs7QUFDUixtQkFBTztBQUFBLFVBQ1Q7QUFFQSxpQkFBTyxNQUFNLE9BQU8sS0FBSyxDQUFDLEtBQUssR0FBRztBQUFBLFFBQ3BDO0FBQUEsTUFDRjtBQUdBLGVBQVMsT0FBTztBQUFBLFFBQ2Q7QUFBQSxRQUNBLENBQUMsTUFBTSxRQUFnQixRQUFnQixZQUFvQjtBQUN6RCxnQkFBTSxNQUFNLFlBQVksT0FBTztBQUMvQixjQUFJLENBQUMsS0FBSztBQUNSLG1CQUFPO0FBQUEsVUFDVDtBQUVBLGlCQUFPLEdBQUcsTUFBTSxJQUFJLE9BQU8sS0FBSyxDQUFDLEtBQUssR0FBRztBQUFBLFFBQzNDO0FBQUEsTUFDRjtBQUVBLGVBQVMsT0FBTyxRQUFRLGNBQWMsQ0FBQyxNQUFNLFlBQW9CO0FBQy9ELGNBQU0sTUFBTSxZQUFZLE9BQU87QUFDL0IsWUFBSSxDQUFDLEtBQUs7QUFDUixpQkFBTztBQUFBLFFBQ1Q7QUFFQSxlQUFPLFdBQVcsT0FBTyxLQUFLLEdBQUc7QUFBQSxNQUNuQyxDQUFDO0FBQ0QsYUFBTztBQUFBLElBQ1Q7QUFFQSxRQUFJLFVBQVUsVUFBVTtBQUN0QixlQUFTLE9BQU8sUUFBUSxjQUFjLENBQUMsTUFBTSxZQUFvQjtBQUMvRCxjQUFNLE1BQU0sWUFBWSxPQUFPO0FBQy9CLFlBQUksQ0FBQyxLQUFLO0FBQ1IsaUJBQU87QUFBQSxRQUNUO0FBRUEsZUFBTyxXQUFXLE9BQU8sS0FBSyxHQUFHO0FBQUEsTUFDbkMsQ0FBQztBQUNELGFBQU87QUFBQSxJQUNUO0FBR0EsYUFBUyxPQUFPLFFBQVEsY0FBYyxFQUFFO0FBQ3hDLGFBQVMsT0FBTyxRQUFRLFdBQVcsR0FBRztBQUN0QyxhQUFTLE9BQU8sUUFBUSxrQkFBa0IsSUFBSTtBQUU5QyxXQUFPO0FBQUEsRUFDVDtBQUFBLEVBRUEsTUFBYyx3QkFDWixRQUNBLE1BQ0EsU0FBc0IsQ0FBQyxHQUNSO0FBQ2YsV0FBTyxNQUFNO0FBQ2IsVUFBTSxXQUFXLEtBQUssMkJBQTJCLE1BQU0sTUFBTTtBQUM3RCxVQUFNLGlDQUFpQixlQUFlLFVBQVUsUUFBUSxLQUFLLFlBQVksSUFBSSxJQUFJO0FBQUEsRUFDbkY7QUFDRjtBQUVBLElBQU0sbUJBQU4sY0FBK0Isc0JBQU07QUFBQSxFQUduQyxZQUFZLEtBQVUsVUFBK0M7QUFDbkUsVUFBTSxHQUFHO0FBQ1QsU0FBSyxXQUFXO0FBQUEsRUFDbEI7QUFBQSxFQUVBLFNBQWU7QUFDYixVQUFNLEVBQUUsVUFBVSxJQUFJO0FBQ3RCLGNBQVUsTUFBTTtBQUNoQixjQUFVLFNBQVMsc0JBQXNCO0FBRXpDLGNBQVUsU0FBUyxNQUFNLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUUzRCxVQUFNLFFBQVEsVUFBVSxTQUFTLFlBQVk7QUFBQSxNQUMzQyxNQUFNLEVBQUUsYUFBYSxxQ0FBcUM7QUFBQSxJQUM1RCxDQUFDO0FBRUQsVUFBTSxTQUFTLFVBQVUsU0FBUyxVQUFVLEVBQUUsTUFBTSxNQUFNLENBQUM7QUFDM0QsV0FBTyxpQkFBaUIsU0FBUyxZQUFZO0FBQzNDLGFBQU8sV0FBVztBQUNsQixVQUFJO0FBQ0YsY0FBTSxLQUFLLFNBQVMsTUFBTSxLQUFLO0FBQy9CLGFBQUssTUFBTTtBQUFBLE1BQ2IsU0FBUyxPQUFPO0FBQ2QsZ0JBQVEsTUFBTSxLQUFLO0FBQ25CLFlBQUksdUJBQU8sbUJBQW1CLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxPQUFPLEtBQUssQ0FBQyxFQUFFO0FBQUEsTUFDeEYsVUFBRTtBQUNBLGVBQU8sV0FBVztBQUFBLE1BQ3BCO0FBQUEsSUFDRixDQUFDO0FBRUQsVUFBTSxNQUFNO0FBQUEsRUFDZDtBQUFBLEVBRUEsVUFBZ0I7QUFDZCxTQUFLLFVBQVUsTUFBTTtBQUFBLEVBQ3ZCO0FBQ0Y7QUFFQSxJQUFNLG1CQUFOLGNBQStCLHNCQUFNO0FBQUEsRUFRbkMsWUFDRSxLQUNBLFFBQ0EsZUFDQTtBQUNBLFVBQU0sR0FBRztBQVZYLFNBQVEsU0FBNEIsQ0FBQztBQUNyQyxTQUFRLFFBQVE7QUFVZCxTQUFLLFNBQVM7QUFDZCxTQUFLLGdCQUFnQjtBQUFBLEVBQ3ZCO0FBQUEsRUFFQSxTQUFlO0FBQ2IsVUFBTSxFQUFFLFVBQVUsSUFBSTtBQUN0QixjQUFVLE1BQU07QUFDaEIsY0FBVSxTQUFTLG1DQUFtQztBQUV0RCxjQUFVLFNBQVMsTUFBTSxFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFFN0QsVUFBTSxhQUFhLFVBQVUsVUFBVSxFQUFFLEtBQUssdUNBQXVDLENBQUM7QUFFdEYsVUFBTSxRQUFRLFdBQVcsU0FBUyxTQUFTO0FBQUEsTUFDekMsTUFBTTtBQUFBLE1BQ04sYUFBYTtBQUFBLElBQ2YsQ0FBQztBQUVELFVBQU0sZ0JBQWdCLFdBQVcsU0FBUyxVQUFVLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFdkUsU0FBSyxXQUFXLFVBQVUsVUFBVSxFQUFFLEtBQUsscUNBQXFDLENBQUM7QUFDakYsU0FBSyxTQUFTLFVBQVUsVUFBVSxFQUFFLEtBQUssc0NBQXNDLENBQUM7QUFFaEYsVUFBTSxpQkFBaUIsU0FBUyxNQUFNO0FBQ3BDLFdBQUssUUFBUSxNQUFNLE1BQU0sS0FBSyxFQUFFLFlBQVk7QUFDNUMsV0FBSyxnQkFBZ0I7QUFBQSxJQUN2QixDQUFDO0FBRUQsa0JBQWMsaUJBQWlCLFNBQVMsWUFBWTtBQUNsRCxZQUFNLEtBQUssV0FBVyxJQUFJO0FBQUEsSUFDNUIsQ0FBQztBQUVELFNBQUssS0FBSyxXQUFXLEtBQUs7QUFDMUIsVUFBTSxNQUFNO0FBQUEsRUFDZDtBQUFBLEVBRUEsVUFBZ0I7QUFDZCxTQUFLLFVBQVUsTUFBTTtBQUFBLEVBQ3ZCO0FBQUEsRUFFQSxNQUFjLFdBQVcsY0FBc0M7QUFDN0QsU0FBSyxTQUFTLFFBQVEsbUJBQW1CO0FBQ3pDLFNBQUssT0FBTyxNQUFNO0FBRWxCLFFBQUk7QUFDRixXQUFLLFNBQVMsTUFBTSxLQUFLLE9BQU8sb0JBQW9CLFlBQVk7QUFDaEUsV0FBSyxnQkFBZ0I7QUFBQSxJQUN2QixTQUFTLE9BQU87QUFDZCxjQUFRLE1BQU0sb0NBQW9DLEtBQUs7QUFDdkQsV0FBSyxTQUFTO0FBQUEsUUFDWiwwQkFBMEIsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLE9BQU8sS0FBSyxDQUFDO0FBQUEsTUFDbEY7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBRVEsa0JBQXdCO0FBQzlCLFNBQUssT0FBTyxNQUFNO0FBRWxCLFVBQU0saUJBQWlCLEtBQUssT0FBTyxPQUFPLENBQUMsVUFBVTtBQUNuRCxZQUFNLFVBQVUsTUFBTSxHQUFHLFlBQVk7QUFDckMsYUFBTyxDQUFDLEtBQUssU0FBUyxRQUFRLFNBQVMsS0FBSyxLQUFLO0FBQUEsSUFDbkQsQ0FBQztBQUVELFNBQUssU0FBUyxRQUFRLFdBQVcsZUFBZSxNQUFNLE9BQU8sS0FBSyxPQUFPLE1BQU0sU0FBUztBQUV4RixRQUFJLENBQUMsZUFBZSxRQUFRO0FBQzFCLFdBQUssT0FBTyxVQUFVO0FBQUEsUUFDcEIsS0FBSztBQUFBLFFBQ0wsTUFBTTtBQUFBLE1BQ1IsQ0FBQztBQUNEO0FBQUEsSUFDRjtBQUVBLGVBQVcsU0FBUyxlQUFlLE1BQU0sR0FBRyxHQUFHLEdBQUc7QUFDaEQsWUFBTSxNQUFNLEtBQUssT0FBTyxTQUFTLFVBQVU7QUFBQSxRQUN6QyxLQUFLO0FBQUEsTUFDUCxDQUFDO0FBRUQsVUFBSSxVQUFVLEVBQUUsS0FBSywyQkFBMkIsTUFBTSxNQUFNLEdBQUcsQ0FBQztBQUVoRSxVQUFJLGlCQUFpQixTQUFTLFlBQVk7QUFDeEMsWUFBSTtBQUNGLGdCQUFNLEtBQUssY0FBYyxNQUFNLEVBQUU7QUFDakMsY0FBSSx1QkFBTyxtQkFBbUIsTUFBTSxFQUFFLEVBQUU7QUFDeEMsZUFBSyxNQUFNO0FBQUEsUUFDYixTQUFTLE9BQU87QUFDZCxrQkFBUSxNQUFNLHVCQUF1QixLQUFLO0FBQzFDLGNBQUksdUJBQU8sd0JBQXdCLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxPQUFPLEtBQUssQ0FBQyxFQUFFO0FBQUEsUUFDN0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUNGO0FBRUEsSUFBTSwwQkFBTixjQUFzQyxpQ0FBaUI7QUFBQSxFQUdyRCxZQUFZLEtBQVUsUUFBNkI7QUFDakQsVUFBTSxLQUFLLE1BQU07QUFDakIsU0FBSyxTQUFTO0FBQUEsRUFDaEI7QUFBQSxFQUVBLFVBQWdCO0FBQ2QsVUFBTSxFQUFFLFlBQVksSUFBSTtBQUN4QixnQkFBWSxNQUFNO0FBRWxCLGdCQUFZLFNBQVMsTUFBTSxFQUFFLE1BQU0sZ0NBQWdDLENBQUM7QUFFcEUsUUFBSSx3QkFBUSxXQUFXLEVBQ3BCLFFBQVEsb0JBQW9CLEVBQzVCLFFBQVEsOENBQThDLEVBQ3REO0FBQUEsTUFBUSxDQUFDLFNBQ1IsS0FDRyxlQUFlLGNBQWMsRUFDN0IsU0FBUyxLQUFLLE9BQU8sU0FBUyxnQkFBZ0IsRUFDOUMsU0FBUyxPQUFPLFVBQVU7QUFDekIsYUFBSyxPQUFPLFNBQVMsbUJBQW1CLE1BQU0sS0FBSztBQUNuRCxjQUFNLEtBQUssT0FBTyxhQUFhO0FBQUEsTUFDakMsQ0FBQztBQUFBLElBQ0w7QUFFRixRQUFJLHdCQUFRLFdBQVcsRUFDcEIsUUFBUSxPQUFPLEVBQ2YsUUFBUSx3REFBd0QsRUFDaEU7QUFBQSxNQUFRLENBQUMsU0FDUixLQUNHLGVBQWUsb0JBQW9CLEVBQ25DLFNBQVMsS0FBSyxPQUFPLFNBQVMsS0FBSyxFQUNuQyxTQUFTLE9BQU8sVUFBVTtBQUN6QixhQUFLLE9BQU8sU0FBUyxRQUFRLE1BQU0sS0FBSyxLQUFLLGlCQUFpQjtBQUM5RCxjQUFNLEtBQUssT0FBTyxhQUFhO0FBQUEsTUFDakMsQ0FBQztBQUFBLElBQ0wsRUFDQztBQUFBLE1BQVUsQ0FBQyxXQUNWLE9BQU8sY0FBYyxRQUFRLEVBQUUsUUFBUSxNQUFNO0FBQzNDLFlBQUksaUJBQWlCLEtBQUssS0FBSyxLQUFLLFFBQVEsT0FBTyxZQUFZO0FBQzdELGVBQUssT0FBTyxTQUFTLFFBQVE7QUFDN0IsZ0JBQU0sS0FBSyxPQUFPLGFBQWE7QUFDL0IsZUFBSyxRQUFRO0FBQUEsUUFDZixDQUFDLEVBQUUsS0FBSztBQUFBLE1BQ1YsQ0FBQztBQUFBLElBQ0g7QUFFRixRQUFJLHdCQUFRLFdBQVcsRUFDcEIsUUFBUSxzQkFBc0IsRUFDOUIsUUFBUSx3Q0FBd0MsRUFDaEQ7QUFBQSxNQUFVLENBQUMsV0FDVixPQUNHLFVBQVUsR0FBRyxJQUFJLENBQUMsRUFDbEIsU0FBUyxLQUFLLE9BQU8sU0FBUyxTQUFTLEVBQ3ZDLGtCQUFrQixFQUNsQixTQUFTLE9BQU8sVUFBVTtBQUN6QixhQUFLLE9BQU8sU0FBUyxZQUFZO0FBQ2pDLGNBQU0sS0FBSyxPQUFPLGFBQWE7QUFBQSxNQUNqQyxDQUFDO0FBQUEsSUFDTDtBQUVGLFFBQUksd0JBQVEsV0FBVyxFQUNwQixRQUFRLFlBQVksRUFDcEIsUUFBUSxxREFBcUQsRUFDN0Q7QUFBQSxNQUFVLENBQUMsV0FDVixPQUNHLFVBQVUsS0FBSyxLQUFNLEVBQUUsRUFDdkIsU0FBUyxLQUFLLE9BQU8sU0FBUyxTQUFTLEVBQ3ZDLGtCQUFrQixFQUNsQixTQUFTLE9BQU8sVUFBVTtBQUN6QixhQUFLLE9BQU8sU0FBUyxZQUFZO0FBQ2pDLGNBQU0sS0FBSyxPQUFPLGFBQWE7QUFBQSxNQUNqQyxDQUFDO0FBQUEsSUFDTDtBQUVGLFFBQUksd0JBQVEsV0FBVyxFQUNwQixRQUFRLGVBQWUsRUFDdkIsUUFBUSxpREFBaUQsRUFDekQ7QUFBQSxNQUFRLENBQUMsU0FDUixLQUNHLGVBQWUsYUFBYSxFQUM1QixTQUFTLEtBQUssT0FBTyxTQUFTLFlBQVksRUFDMUMsU0FBUyxPQUFPLFVBQVU7QUFDekIsYUFBSyxPQUFPLFNBQVMsZUFBZSxNQUFNLEtBQUs7QUFDL0MsY0FBTSxLQUFLLE9BQU8sYUFBYTtBQUFBLE1BQ2pDLENBQUM7QUFBQSxJQUNMO0FBRUYsUUFBSSx3QkFBUSxXQUFXLEVBQ3BCLFFBQVEsZ0JBQWdCLEVBQ3hCLFFBQVEsNENBQTRDLEVBQ3BEO0FBQUEsTUFBWSxDQUFDLGFBQ1osU0FDRyxVQUFVLFVBQVUsY0FBYyxFQUNsQyxVQUFVLFVBQVUsY0FBYyxFQUNsQyxVQUFVLFVBQVUsYUFBYSxFQUNqQyxTQUFTLEtBQUssT0FBTyxTQUFTLGFBQWEsRUFDM0MsU0FBUyxPQUFPLFVBQTBDO0FBQ3pELGFBQUssT0FBTyxTQUFTLGdCQUFnQjtBQUNyQyxjQUFNLEtBQUssT0FBTyxhQUFhO0FBQUEsTUFDakMsQ0FBQztBQUFBLElBQ0w7QUFFRixRQUFJLHdCQUFRLFdBQVcsRUFDcEIsUUFBUSxlQUFlLEVBQ3ZCLFFBQVEsa0RBQWtELEVBQzFEO0FBQUEsTUFBWSxDQUFDLGFBQ1osU0FDRyxVQUFVLGFBQWEsV0FBVyxFQUNsQyxVQUFVLFlBQVksVUFBVSxFQUNoQyxVQUFVLFVBQVUsUUFBUSxFQUM1QixTQUFTLEtBQUssT0FBTyxTQUFTLFlBQVksRUFDMUMsU0FBUyxPQUFPLFVBQStDO0FBQzlELGFBQUssT0FBTyxTQUFTLGVBQWU7QUFDcEMsY0FBTSxLQUFLLE9BQU8sYUFBYTtBQUFBLE1BQ2pDLENBQUM7QUFBQSxJQUNMO0FBRUYsUUFBSSx3QkFBUSxXQUFXLEVBQ3BCLFFBQVEsZ0JBQWdCLEVBQ3hCLFFBQVEsNkRBQTZELEVBQ3JFO0FBQUEsTUFBVSxDQUFDLFdBQ1YsT0FBTyxjQUFjLGVBQWUsRUFBRSxRQUFRLFlBQVk7QUFDeEQsY0FBTSxLQUFLLE9BQU8sYUFBYTtBQUFBLE1BQ2pDLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDSjtBQUNGOyIsCiAgIm5hbWVzIjogWyJleGlzdGluZyIsICJmb2xkZXJQYXRoIl0KfQo=
