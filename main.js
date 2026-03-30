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
    this.documentFrequencies = {};
    this.avgChunkLength = 0;
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
  stem(word) {
    let w = word.toLowerCase();
    if (w.length < 3) return w;
    if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
    else if (w.endsWith("sses")) w = w.slice(0, -2);
    else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (w.endsWith("eed")) {
      if (w.length > 4) w = w.slice(0, -1);
    } else if ((w.endsWith("ed") || w.endsWith("ing")) && /[aeiouy]/.test(w.slice(0, -2))) {
      w = w.endsWith("ed") ? w.slice(0, -2) : w.slice(0, -3);
      if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) {
        w += "e";
      } else if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/.test(w)) {
        w = w.slice(0, -1);
      }
    }
    if (w.endsWith("y") && /[aeiouy]/.test(w.slice(0, -1))) {
      w = w.slice(0, -1) + "i";
    }
    return w;
  }
  tokenize(input) {
    return input.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2).map((t) => this.stem(t));
  }
  splitIntoChunks(text, chunkSize, overlapSize = 100) {
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
        const overlapStr = current ? current.slice(Math.max(0, current.length - overlapSize)) : "";
        const spaceIdx = overlapStr.indexOf(" ");
        const cleanOverlap = spaceIdx !== -1 ? overlapStr.slice(spaceIdx + 1) : overlapStr;
        current = cleanOverlap ? `...${cleanOverlap}

${paragraph}` : paragraph;
      } else {
        const hardSplit = this.hardSplit(paragraph, chunkSize, overlapSize);
        chunks.push(...hardSplit.slice(0, -1));
        current = hardSplit[hardSplit.length - 1];
      }
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  }
  hardSplit(text, chunkSize, overlapSize = 100) {
    const result = [];
    let start = 0;
    while (start < text.length) {
      const end = start + chunkSize;
      result.push(text.slice(start, end));
      start += chunkSize - overlapSize;
      if (start >= text.length || chunkSize <= overlapSize) {
        break;
      }
    }
    return result;
  }
  async rebuildIndex() {
    const files = this.app.vault.getMarkdownFiles();
    const chunks = [];
    const df = {};
    let totalTokens = 0;
    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const split = this.splitIntoChunks(content, this.settings.chunkSize, 100);
        for (const chunkText of split) {
          const tokens = this.tokenize(chunkText);
          if (!tokens.length) {
            continue;
          }
          const termFrequencies = {};
          for (const token of tokens) {
            termFrequencies[token] = (termFrequencies[token] || 0) + 1;
          }
          for (const token of Object.keys(termFrequencies)) {
            df[token] = (df[token] || 0) + 1;
          }
          totalTokens += tokens.length;
          chunks.push({
            filePath: file.path,
            chunkText,
            tokens,
            termFrequencies
          });
        }
      } catch (error) {
        console.error(`Failed to index ${file.path}`, error);
      }
    }
    this.noteIndex = chunks;
    this.documentFrequencies = df;
    this.avgChunkLength = chunks.length > 0 ? totalTokens / chunks.length : 0;
    new import_obsidian.Notice(`Indexed ${files.length} notes into ${chunks.length} chunks.`);
  }
  calculateBM25Score(chunk, queryTokens) {
    const k1 = 1.2;
    const b = 0.75;
    const N = this.noteIndex.length;
    let score = 0;
    for (const token of queryTokens) {
      if (!chunk.termFrequencies[token]) {
        continue;
      }
      const n = this.documentFrequencies[token] || 0;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      const f = chunk.termFrequencies[token];
      const dl = chunk.tokens.length;
      const avgdl = this.avgChunkLength || 1;
      const tf = f * (k1 + 1) / (f + k1 * (1 - b + b * (dl / avgdl)));
      score += idf * tf;
    }
    return score;
  }
  retrieveRelevantChunks(question) {
    const queryTokens = this.tokenize(question);
    if (!queryTokens.length) {
      return [];
    }
    const scored = this.noteIndex.map((chunk) => {
      const score = this.calculateBM25Score(chunk, queryTokens);
      return { chunk, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, this.settings.maxChunks).map((x) => x.chunk);
    return scored;
  }
  retrieveRelevantChunksForFile(question, filePath) {
    const queryTokens = this.tokenize(question);
    if (!queryTokens.length) {
      return [];
    }
    const scored = this.noteIndex.filter((chunk) => chunk.filePath === filePath).map((chunk) => {
      const score = this.calculateBM25Score(chunk, queryTokens);
      return { chunk, score };
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHtcbiAgQXBwLFxuICBJdGVtVmlldyxcbiAgTWFya2Rvd25SZW5kZXJlcixcbiAgTW9kYWwsXG4gIE5vdGljZSxcbiAgbm9ybWFsaXplUGF0aCxcbiAgUGx1Z2luLFxuICBQbHVnaW5TZXR0aW5nVGFiLFxuICBTZXR0aW5nLFxuICBURmlsZSxcbiAgV29ya3NwYWNlTGVhZixcbiAgcmVxdWVzdFVybFxufSBmcm9tIFwib2JzaWRpYW5cIjtcblxuaW50ZXJmYWNlIE9wZW5Sb3V0ZXJBc3Npc3RhbnRTZXR0aW5ncyB7XG4gIG9wZW5Sb3V0ZXJBcGlLZXk6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbiAgbWF4Q2h1bmtzOiBudW1iZXI7XG4gIGNodW5rU2l6ZTogbnVtYmVyO1xuICBhbnN3ZXJGb2xkZXI6IHN0cmluZztcbiAgY2l0YXRpb25TdHlsZTogXCJwaHJhc2VcIiB8IFwic291cmNlXCIgfCBcImZvb3RlclwiO1xuICB0aGlua2luZ1ZpZXc6IFwiY29sbGFwc2VkXCIgfCBcImV4cGFuZGVkXCIgfCBcImhpZGRlblwiO1xufVxuXG5pbnRlcmZhY2UgTm90ZUNodW5rIHtcbiAgZmlsZVBhdGg6IHN0cmluZztcbiAgY2h1bmtUZXh0OiBzdHJpbmc7XG4gIHRva2Vuczogc3RyaW5nW107XG4gIHRlcm1GcmVxdWVuY2llczogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbn1cblxuaW50ZXJmYWNlIE9wZW5Sb3V0ZXJNb2RlbCB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBjb250ZXh0TGVuZ3RoPzogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgQ2hhdE1lc3NhZ2Uge1xuICByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7XG4gIGNvbnRlbnQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFN0cmVhbUhhbmRsZXJzIHtcbiAgb25BbnN3ZXJEZWx0YT86IChkZWx0YTogc3RyaW5nKSA9PiB2b2lkO1xuICBvblRoaW5raW5nRGVsdGE/OiAoZGVsdGE6IHN0cmluZykgPT4gdm9pZDtcbn1cblxudHlwZSBBZ2VudEFjdGlvbiA9XG4gIHwge1xuICAgICAgdHlwZTogXCJjcmVhdGVfZm9sZGVyXCI7XG4gICAgICBwYXRoOiBzdHJpbmc7XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwiY3JlYXRlX2ZpbGVcIjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIGNvbnRlbnQ6IHN0cmluZztcbiAgICAgIG92ZXJ3cml0ZT86IGJvb2xlYW47XG4gICAgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwiYXBwZW5kX2ZpbGVcIjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIGNvbnRlbnQ6IHN0cmluZztcbiAgICB9XG4gIHwge1xuICAgICAgdHlwZTogXCJpbnNlcnRfYWZ0ZXJfaGVhZGluZ1wiO1xuICAgICAgcGF0aDogc3RyaW5nO1xuICAgICAgaGVhZGluZzogc3RyaW5nO1xuICAgICAgY29udGVudDogc3RyaW5nO1xuICAgICAgY3JlYXRlSWZNaXNzaW5nPzogYm9vbGVhbjtcbiAgICB9XG4gIHwge1xuICAgICAgdHlwZTogXCJyZXBsYWNlX2luX2ZpbGVcIjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIGZpbmQ6IHN0cmluZztcbiAgICAgIHJlcGxhY2U6IHN0cmluZztcbiAgICAgIHJlcGxhY2VBbGw/OiBib29sZWFuO1xuICAgIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcImNyZWF0ZV9mcm9tX3RlbXBsYXRlXCI7XG4gICAgICBwYXRoOiBzdHJpbmc7XG4gICAgICB0ZW1wbGF0ZTogc3RyaW5nO1xuICAgICAgdmFyaWFibGVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICAgIG92ZXJ3cml0ZT86IGJvb2xlYW47XG4gICAgfTtcblxuaW50ZXJmYWNlIENpdGF0aW9uTGluayB7XG4gIG51bWJlcjogbnVtYmVyO1xuICBmaWxlOiBURmlsZTtcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogT3BlblJvdXRlckFzc2lzdGFudFNldHRpbmdzID0ge1xuICBvcGVuUm91dGVyQXBpS2V5OiBcIlwiLFxuICBtb2RlbDogXCJvcGVuYWkvZ3B0LTRvLW1pbmlcIixcbiAgbWF4Q2h1bmtzOiA2LFxuICBjaHVua1NpemU6IDcwMCxcbiAgYW5zd2VyRm9sZGVyOiBcIlJBRyBBbnN3ZXJzXCIsXG4gIGNpdGF0aW9uU3R5bGU6IFwicGhyYXNlXCIsXG4gIHRoaW5raW5nVmlldzogXCJjb2xsYXBzZWRcIlxufTtcblxuY29uc3QgUkFHX0NIQVRfVklFV19UWVBFID0gXCJyYWctb3BlbnJvdXRlci1jaGF0LXNpZGViYXJcIjtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUmFnT3BlblJvdXRlclBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gIHNldHRpbmdzOiBPcGVuUm91dGVyQXNzaXN0YW50U2V0dGluZ3M7XG4gIG5vdGVJbmRleDogTm90ZUNodW5rW10gPSBbXTtcbiAgZG9jdW1lbnRGcmVxdWVuY2llczogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICBhdmdDaHVua0xlbmd0aDogbnVtYmVyID0gMDtcbiAgcHJpdmF0ZSBtb2RlbENhY2hlOiBPcGVuUm91dGVyTW9kZWxbXSA9IFtdO1xuICBwcml2YXRlIG1vZGVsQ2FjaGVVcGRhdGVkQXQgPSAwO1xuXG4gIGFzeW5jIG9ubG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXG4gICAgdGhpcy5yZWdpc3RlclZpZXcoXG4gICAgICBSQUdfQ0hBVF9WSUVXX1RZUEUsXG4gICAgICAobGVhZikgPT4gbmV3IFJhZ0NoYXRTaWRlYmFyVmlldyhsZWFmLCB0aGlzKVxuICAgICk7XG5cbiAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IFJhZ09wZW5Sb3V0ZXJTZXR0aW5nVGFiKHRoaXMuYXBwLCB0aGlzKSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwicmFnLW9wZW5yb3V0ZXItaW5kZXgtbm90ZXNcIixcbiAgICAgIG5hbWU6IFwiSW5kZXggVmF1bHQgTm90ZXNcIixcbiAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHRoaXMucmVidWlsZEluZGV4KCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwicmFnLW9wZW5yb3V0ZXItYXNrLXF1ZXN0aW9uXCIsXG4gICAgICBuYW1lOiBcIkFzayBRdWVzdGlvbiBXaXRoIFZhdWx0IENvbnRleHRcIixcbiAgICAgIGNhbGxiYWNrOiAoKSA9PiB7XG4gICAgICAgIG5ldyBBc2tRdWVzdGlvbk1vZGFsKHRoaXMuYXBwLCBhc3luYyAocXVlc3Rpb24pID0+IHtcbiAgICAgICAgICBhd2FpdCB0aGlzLmhhbmRsZVF1ZXN0aW9uKHF1ZXN0aW9uKTtcbiAgICAgICAgfSkub3BlbigpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcInJhZy1vcGVucm91dGVyLWNoYXQtY3VycmVudC1ub3RlXCIsXG4gICAgICBuYW1lOiBcIkNoYXQgV2l0aCBDdXJyZW50IE5vdGVcIixcbiAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFjdGl2ZUZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgICAgICBpZiAoIWFjdGl2ZUZpbGUgfHwgYWN0aXZlRmlsZS5leHRlbnNpb24gIT09IFwibWRcIikge1xuICAgICAgICAgIG5ldyBOb3RpY2UoXCJPcGVuIGEgbWFya2Rvd24gbm90ZSBmaXJzdC5cIik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5vcGVuQ2hhdFNpZGViYXIoXCJub3RlXCIsIGFjdGl2ZUZpbGUucGF0aCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6IFwicmFnLW9wZW5yb3V0ZXItYWdlbnQtY2hhdC12YXVsdFwiLFxuICAgICAgbmFtZTogXCJBZ2VudCBDaGF0IFdpdGggVmF1bHRcIixcbiAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHRoaXMub3BlbkNoYXRTaWRlYmFyKFwidmF1bHRcIik7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBhd2FpdCB0aGlzLnJlYnVpbGRJbmRleCgpO1xuICB9XG5cbiAgYXN5bmMgbG9hZFNldHRpbmdzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xuICAgIHRoaXMuc2V0dGluZ3Mub3BlblJvdXRlckFwaUtleSA9IHRoaXMuc2V0dGluZ3Mub3BlblJvdXRlckFwaUtleS50cmltKCk7XG4gICAgdGhpcy5zZXR0aW5ncy5tb2RlbCA9IHRoaXMuc2V0dGluZ3MubW9kZWwudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MubW9kZWw7XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgfVxuXG4gIG9udW5sb2FkKCk6IHZvaWQge1xuICAgIHRoaXMubm90ZUluZGV4ID0gW107XG4gICAgdGhpcy5hcHAud29ya3NwYWNlXG4gICAgICAuZ2V0TGVhdmVzT2ZUeXBlKFJBR19DSEFUX1ZJRVdfVFlQRSlcbiAgICAgIC5mb3JFYWNoKChsZWFmKSA9PiBsZWFmLmRldGFjaCgpKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgb3BlbkNoYXRTaWRlYmFyKG1vZGU6IFwidmF1bHRcIiB8IFwibm90ZVwiLCBub3RlUGF0aD86IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0UmlnaHRMZWFmKGZhbHNlKSA/PyB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0UmlnaHRMZWFmKHRydWUpO1xuICAgIGlmICghbGVhZikge1xuICAgICAgbmV3IE5vdGljZShcIlVuYWJsZSB0byBvcGVuIGNoYXQgc2lkZWJhci5cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgYXdhaXQgbGVhZi5zZXRWaWV3U3RhdGUoe1xuICAgICAgdHlwZTogUkFHX0NIQVRfVklFV19UWVBFLFxuICAgICAgYWN0aXZlOiB0cnVlLFxuICAgICAgc3RhdGU6IHtcbiAgICAgICAgbW9kZSxcbiAgICAgICAgbm90ZVBhdGg6IG5vdGVQYXRoID8/IFwiXCJcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0aGlzLmFwcC53b3Jrc3BhY2UucmV2ZWFsTGVhZihsZWFmKTtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0QXBpS2V5T3JUaHJvdygpOiBzdHJpbmcge1xuICAgIGNvbnN0IGtleSA9IHRoaXMuc2V0dGluZ3Mub3BlblJvdXRlckFwaUtleS50cmltKCk7XG4gICAgaWYgKCFrZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlNldCB5b3VyIE9wZW5Sb3V0ZXIgQVBJIGtleSBpbiBwbHVnaW4gc2V0dGluZ3MgZmlyc3QuXCIpO1xuICAgIH1cblxuICAgIHJldHVybiBrZXk7XG4gIH1cblxuICBhc3luYyBnZXRPcGVuUm91dGVyTW9kZWxzKGZvcmNlUmVmcmVzaCA9IGZhbHNlKTogUHJvbWlzZTxPcGVuUm91dGVyTW9kZWxbXT4ge1xuICAgIGNvbnN0IGNhY2hlSXNGcmVzaCA9XG4gICAgICB0aGlzLm1vZGVsQ2FjaGUubGVuZ3RoID4gMCAmJiBEYXRlLm5vdygpIC0gdGhpcy5tb2RlbENhY2hlVXBkYXRlZEF0IDwgMTAgKiA2MCAqIDEwMDA7XG5cbiAgICBpZiAoIWZvcmNlUmVmcmVzaCAmJiBjYWNoZUlzRnJlc2gpIHtcbiAgICAgIHJldHVybiB0aGlzLm1vZGVsQ2FjaGU7XG4gICAgfVxuXG4gICAgY29uc3QgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgXCJIVFRQLVJlZmVyZXJcIjogXCJodHRwczovL29ic2lkaWFuLm1kXCIsXG4gICAgICBcIlgtVGl0bGVcIjogXCJPYnNpZGlhbiBSQUcgT3BlblJvdXRlciBQbHVnaW5cIlxuICAgIH07XG5cbiAgICBpZiAodGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xuICAgICAgaGVhZGVycy5BdXRob3JpemF0aW9uID0gYEJlYXJlciAke3RoaXMuc2V0dGluZ3Mub3BlblJvdXRlckFwaUtleS50cmltKCl9YDtcbiAgICB9XG5cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xuICAgICAgdXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjEvbW9kZWxzXCIsXG4gICAgICBtZXRob2Q6IFwiR0VUXCIsXG4gICAgICBoZWFkZXJzXG4gICAgfSk7XG5cbiAgICBjb25zdCBtb2RlbHNSYXcgPSBBcnJheS5pc0FycmF5KHJlc3BvbnNlLmpzb24/LmRhdGEpID8gcmVzcG9uc2UuanNvbi5kYXRhIDogW107XG4gICAgY29uc3QgbW9kZWxzID0gbW9kZWxzUmF3XG4gICAgICAubWFwKChpdGVtOiB1bmtub3duKTogT3BlblJvdXRlck1vZGVsIHwgbnVsbCA9PiB7XG4gICAgICAgIGlmICghaXRlbSB8fCB0eXBlb2YgaXRlbSAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgb2JqID0gaXRlbSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgY29uc3QgaWQgPSB0eXBlb2Ygb2JqLmlkID09PSBcInN0cmluZ1wiID8gb2JqLmlkIDogXCJcIjtcbiAgICAgICAgaWYgKCFpZCkge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBpZCxcbiAgICAgICAgICBuYW1lOiB0eXBlb2Ygb2JqLm5hbWUgPT09IFwic3RyaW5nXCIgPyBvYmoubmFtZSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogdHlwZW9mIG9iai5kZXNjcmlwdGlvbiA9PT0gXCJzdHJpbmdcIiA/IG9iai5kZXNjcmlwdGlvbiA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBjb250ZXh0TGVuZ3RoOlxuICAgICAgICAgICAgdHlwZW9mIG9iai5jb250ZXh0X2xlbmd0aCA9PT0gXCJudW1iZXJcIiA/IG9iai5jb250ZXh0X2xlbmd0aCA6IHVuZGVmaW5lZFxuICAgICAgICB9IGFzIE9wZW5Sb3V0ZXJNb2RlbDtcbiAgICAgIH0pXG4gICAgICAuZmlsdGVyKChtb2RlbDogT3BlblJvdXRlck1vZGVsIHwgbnVsbCk6IG1vZGVsIGlzIE9wZW5Sb3V0ZXJNb2RlbCA9PiBCb29sZWFuKG1vZGVsKSlcbiAgICAgIC5zb3J0KChhOiBPcGVuUm91dGVyTW9kZWwsIGI6IE9wZW5Sb3V0ZXJNb2RlbCkgPT4gYS5pZC5sb2NhbGVDb21wYXJlKGIuaWQpKTtcblxuICAgIHRoaXMubW9kZWxDYWNoZSA9IG1vZGVscztcbiAgICB0aGlzLm1vZGVsQ2FjaGVVcGRhdGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIHJldHVybiBtb2RlbHM7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGhhbmRsZVF1ZXN0aW9uKHF1ZXN0aW9uOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIXF1ZXN0aW9uLnRyaW0oKSkge1xuICAgICAgbmV3IE5vdGljZShcIlF1ZXN0aW9uIGNhbm5vdCBiZSBlbXB0eS5cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLnNldHRpbmdzLm9wZW5Sb3V0ZXJBcGlLZXkudHJpbSgpKSB7XG4gICAgICBuZXcgTm90aWNlKFwiU2V0IHlvdXIgT3BlblJvdXRlciBBUEkga2V5IGluIHBsdWdpbiBzZXR0aW5ncyBmaXJzdC5cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLm5vdGVJbmRleC5sZW5ndGgpIHtcbiAgICAgIGF3YWl0IHRoaXMucmVidWlsZEluZGV4KCk7XG4gICAgfVxuXG4gICAgY29uc3QgdG9wQ2h1bmtzID0gdGhpcy5yZXRyaWV2ZVJlbGV2YW50Q2h1bmtzKHF1ZXN0aW9uKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBhd2FpdCB0aGlzLnF1ZXJ5T3BlblJvdXRlcihxdWVzdGlvbiwgdG9wQ2h1bmtzKTtcbiAgICBjb25zdCBjcmVhdGVkRmlsZSA9IGF3YWl0IHRoaXMud3JpdGVBbnN3ZXJOb3RlKHF1ZXN0aW9uLCBhbnN3ZXIsIHRvcENodW5rcyk7XG5cbiAgICBhd2FpdCB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZih0cnVlKS5vcGVuRmlsZShjcmVhdGVkRmlsZSk7XG4gICAgbmV3IE5vdGljZShgQW5zd2VyIGNyZWF0ZWQ6ICR7Y3JlYXRlZEZpbGUucGF0aH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgc3RlbSh3b3JkOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGxldCB3ID0gd29yZC50b0xvd2VyQ2FzZSgpO1xuICAgIGlmICh3Lmxlbmd0aCA8IDMpIHJldHVybiB3O1xuICAgIFxuICAgIGlmICh3LmVuZHNXaXRoKCdpZXMnKSkgdyA9IHcuc2xpY2UoMCwgLTMpICsgJ3knO1xuICAgIGVsc2UgaWYgKHcuZW5kc1dpdGgoJ3NzZXMnKSkgdyA9IHcuc2xpY2UoMCwgLTIpO1xuICAgIGVsc2UgaWYgKHcuZW5kc1dpdGgoJ3MnKSAmJiAhdy5lbmRzV2l0aCgnc3MnKSkgdyA9IHcuc2xpY2UoMCwgLTEpO1xuICAgIFxuICAgIGlmICh3LmVuZHNXaXRoKCdlZWQnKSkge1xuICAgICAgICBpZiAody5sZW5ndGggPiA0KSB3ID0gdy5zbGljZSgwLCAtMSk7XG4gICAgfSBlbHNlIGlmICgody5lbmRzV2l0aCgnZWQnKSB8fCB3LmVuZHNXaXRoKCdpbmcnKSkgJiYgL1thZWlvdXldLy50ZXN0KHcuc2xpY2UoMCwgLTIpKSkge1xuICAgICAgICB3ID0gdy5lbmRzV2l0aCgnZWQnKSA/IHcuc2xpY2UoMCwgLTIpIDogdy5zbGljZSgwLCAtMyk7XG4gICAgICAgIGlmICh3LmVuZHNXaXRoKCdhdCcpIHx8IHcuZW5kc1dpdGgoJ2JsJykgfHwgdy5lbmRzV2l0aCgnaXonKSkge1xuICAgICAgICAgICAgdyArPSAnZSc7XG4gICAgICAgIH0gZWxzZSBpZiAoLyhiYnxkZHxmZnxnZ3xtbXxubnxwcHxycnx0dCkkLy50ZXN0KHcpKSB7XG4gICAgICAgICAgICB3ID0gdy5zbGljZSgwLCAtMSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgaWYgKHcuZW5kc1dpdGgoJ3knKSAmJiAvW2FlaW91eV0vLnRlc3Qody5zbGljZSgwLCAtMSkpKSB7XG4gICAgICAgIHcgPSB3LnNsaWNlKDAsIC0xKSArICdpJztcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIHc7XG4gIH1cblxuICBwcml2YXRlIHRva2VuaXplKGlucHV0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIGlucHV0XG4gICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgLnJlcGxhY2UoL1teYS16MC05XFxzXS9nLCBcIiBcIilcbiAgICAgIC5zcGxpdCgvXFxzKy8pXG4gICAgICAuZmlsdGVyKCh0KSA9PiB0Lmxlbmd0aCA+IDIpXG4gICAgICAubWFwKCh0KSA9PiB0aGlzLnN0ZW0odCkpO1xuICB9XG5cbiAgcHJpdmF0ZSBzcGxpdEludG9DaHVua3ModGV4dDogc3RyaW5nLCBjaHVua1NpemU6IG51bWJlciwgb3ZlcmxhcFNpemU6IG51bWJlciA9IDEwMCk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCBjaHVua3M6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcGFyYWdyYXBocyA9IHRleHRcbiAgICAgIC5zcGxpdCgvXFxuezIsfS8pXG4gICAgICAubWFwKChwKSA9PiBwLnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoKHApID0+IHAubGVuZ3RoID4gMCk7XG5cbiAgICBsZXQgY3VycmVudCA9IFwiXCI7XG5cbiAgICBmb3IgKGNvbnN0IHBhcmFncmFwaCBvZiBwYXJhZ3JhcGhzKSB7XG4gICAgICBpZiAoY3VycmVudC5sZW5ndGggKyBwYXJhZ3JhcGgubGVuZ3RoICsgMiA8PSBjaHVua1NpemUpIHtcbiAgICAgICAgY3VycmVudCA9IGN1cnJlbnQgPyBgJHtjdXJyZW50fVxcblxcbiR7cGFyYWdyYXBofWAgOiBwYXJhZ3JhcGg7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAoY3VycmVudCkge1xuICAgICAgICBjaHVua3MucHVzaChjdXJyZW50KTtcbiAgICAgIH1cblxuICAgICAgaWYgKHBhcmFncmFwaC5sZW5ndGggPD0gY2h1bmtTaXplKSB7XG4gICAgICAgIGNvbnN0IG92ZXJsYXBTdHIgPSBjdXJyZW50ID8gY3VycmVudC5zbGljZShNYXRoLm1heCgwLCBjdXJyZW50Lmxlbmd0aCAtIG92ZXJsYXBTaXplKSkgOiBcIlwiO1xuICAgICAgICBjb25zdCBzcGFjZUlkeCA9IG92ZXJsYXBTdHIuaW5kZXhPZignICcpO1xuICAgICAgICBjb25zdCBjbGVhbk92ZXJsYXAgPSBzcGFjZUlkeCAhPT0gLTEgPyBvdmVybGFwU3RyLnNsaWNlKHNwYWNlSWR4ICsgMSkgOiBvdmVybGFwU3RyO1xuICAgICAgICBjdXJyZW50ID0gY2xlYW5PdmVybGFwID8gYC4uLiR7Y2xlYW5PdmVybGFwfVxcblxcbiR7cGFyYWdyYXBofWAgOiBwYXJhZ3JhcGg7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBoYXJkU3BsaXQgPSB0aGlzLmhhcmRTcGxpdChwYXJhZ3JhcGgsIGNodW5rU2l6ZSwgb3ZlcmxhcFNpemUpO1xuICAgICAgICBjaHVua3MucHVzaCguLi5oYXJkU3BsaXQuc2xpY2UoMCwgLTEpKTtcbiAgICAgICAgY3VycmVudCA9IGhhcmRTcGxpdFtoYXJkU3BsaXQubGVuZ3RoIC0gMV07XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnQpIHtcbiAgICAgIGNodW5rcy5wdXNoKGN1cnJlbnQpO1xuICAgIH1cblxuICAgIHJldHVybiBjaHVua3M7XG4gIH1cblxuICBwcml2YXRlIGhhcmRTcGxpdCh0ZXh0OiBzdHJpbmcsIGNodW5rU2l6ZTogbnVtYmVyLCBvdmVybGFwU2l6ZTogbnVtYmVyID0gMTAwKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHJlc3VsdDogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgc3RhcnQgPSAwO1xuXG4gICAgd2hpbGUgKHN0YXJ0IDwgdGV4dC5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IGVuZCA9IHN0YXJ0ICsgY2h1bmtTaXplO1xuICAgICAgcmVzdWx0LnB1c2godGV4dC5zbGljZShzdGFydCwgZW5kKSk7XG4gICAgICBzdGFydCArPSBjaHVua1NpemUgLSBvdmVybGFwU2l6ZTtcbiAgICAgIGlmIChzdGFydCA+PSB0ZXh0Lmxlbmd0aCB8fCBjaHVua1NpemUgPD0gb3ZlcmxhcFNpemUpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIGFzeW5jIHJlYnVpbGRJbmRleCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBmaWxlcyA9IHRoaXMuYXBwLnZhdWx0LmdldE1hcmtkb3duRmlsZXMoKTtcbiAgICBjb25zdCBjaHVua3M6IE5vdGVDaHVua1tdID0gW107XG4gICAgY29uc3QgZGY6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcbiAgICBsZXQgdG90YWxUb2tlbnMgPSAwO1xuXG4gICAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQuY2FjaGVkUmVhZChmaWxlKTtcbiAgICAgICAgY29uc3Qgc3BsaXQgPSB0aGlzLnNwbGl0SW50b0NodW5rcyhjb250ZW50LCB0aGlzLnNldHRpbmdzLmNodW5rU2l6ZSwgMTAwKTtcblxuICAgICAgICBmb3IgKGNvbnN0IGNodW5rVGV4dCBvZiBzcGxpdCkge1xuICAgICAgICAgIGNvbnN0IHRva2VucyA9IHRoaXMudG9rZW5pemUoY2h1bmtUZXh0KTtcbiAgICAgICAgICBpZiAoIXRva2Vucy5sZW5ndGgpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHRlcm1GcmVxdWVuY2llczogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICAgICAgICAgIGZvciAoY29uc3QgdG9rZW4gb2YgdG9rZW5zKSB7XG4gICAgICAgICAgICAgdGVybUZyZXF1ZW5jaWVzW3Rva2VuXSA9ICh0ZXJtRnJlcXVlbmNpZXNbdG9rZW5dIHx8IDApICsgMTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBmb3IgKGNvbnN0IHRva2VuIG9mIE9iamVjdC5rZXlzKHRlcm1GcmVxdWVuY2llcykpIHtcbiAgICAgICAgICAgICBkZlt0b2tlbl0gPSAoZGZbdG9rZW5dIHx8IDApICsgMTtcbiAgICAgICAgICB9XG4gICAgICAgICAgXG4gICAgICAgICAgdG90YWxUb2tlbnMgKz0gdG9rZW5zLmxlbmd0aDtcblxuICAgICAgICAgIGNodW5rcy5wdXNoKHtcbiAgICAgICAgICAgIGZpbGVQYXRoOiBmaWxlLnBhdGgsXG4gICAgICAgICAgICBjaHVua1RleHQsXG4gICAgICAgICAgICB0b2tlbnMsXG4gICAgICAgICAgICB0ZXJtRnJlcXVlbmNpZXNcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmFpbGVkIHRvIGluZGV4ICR7ZmlsZS5wYXRofWAsIGVycm9yKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLm5vdGVJbmRleCA9IGNodW5rcztcbiAgICB0aGlzLmRvY3VtZW50RnJlcXVlbmNpZXMgPSBkZjtcbiAgICB0aGlzLmF2Z0NodW5rTGVuZ3RoID0gY2h1bmtzLmxlbmd0aCA+IDAgPyB0b3RhbFRva2VucyAvIGNodW5rcy5sZW5ndGggOiAwO1xuICAgIG5ldyBOb3RpY2UoYEluZGV4ZWQgJHtmaWxlcy5sZW5ndGh9IG5vdGVzIGludG8gJHtjaHVua3MubGVuZ3RofSBjaHVua3MuYCk7XG4gIH1cblxuICBwcml2YXRlIGNhbGN1bGF0ZUJNMjVTY29yZShjaHVuazogTm90ZUNodW5rLCBxdWVyeVRva2Vuczogc3RyaW5nW10pOiBudW1iZXIge1xuICAgIGNvbnN0IGsxID0gMS4yO1xuICAgIGNvbnN0IGIgPSAwLjc1O1xuICAgIGNvbnN0IE4gPSB0aGlzLm5vdGVJbmRleC5sZW5ndGg7XG4gICAgbGV0IHNjb3JlID0gMDtcblxuICAgIGZvciAoY29uc3QgdG9rZW4gb2YgcXVlcnlUb2tlbnMpIHtcbiAgICAgIGlmICghY2h1bmsudGVybUZyZXF1ZW5jaWVzW3Rva2VuXSkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgY29uc3QgbiA9IHRoaXMuZG9jdW1lbnRGcmVxdWVuY2llc1t0b2tlbl0gfHwgMDtcbiAgICAgIGNvbnN0IGlkZiA9IE1hdGgubG9nKChOIC0gbiArIDAuNSkgLyAobiArIDAuNSkgKyAxKTtcbiAgICAgIFxuICAgICAgY29uc3QgZiA9IGNodW5rLnRlcm1GcmVxdWVuY2llc1t0b2tlbl07XG4gICAgICBjb25zdCBkbCA9IGNodW5rLnRva2Vucy5sZW5ndGg7XG4gICAgICBjb25zdCBhdmdkbCA9IHRoaXMuYXZnQ2h1bmtMZW5ndGggfHwgMTtcbiAgICAgIFxuICAgICAgY29uc3QgdGYgPSAoZiAqIChrMSArIDEpKSAvIChmICsgazEgKiAoMSAtIGIgKyBiICogKGRsIC8gYXZnZGwpKSk7XG4gICAgICBzY29yZSArPSBpZGYgKiB0ZjtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIHNjb3JlO1xuICB9XG5cbiAgcHJpdmF0ZSByZXRyaWV2ZVJlbGV2YW50Q2h1bmtzKHF1ZXN0aW9uOiBzdHJpbmcpOiBOb3RlQ2h1bmtbXSB7XG4gICAgY29uc3QgcXVlcnlUb2tlbnMgPSB0aGlzLnRva2VuaXplKHF1ZXN0aW9uKTtcbiAgICBpZiAoIXF1ZXJ5VG9rZW5zLmxlbmd0aCkge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cblxuICAgIGNvbnN0IHNjb3JlZCA9IHRoaXMubm90ZUluZGV4XG4gICAgICAubWFwKChjaHVuaykgPT4ge1xuICAgICAgICBjb25zdCBzY29yZSA9IHRoaXMuY2FsY3VsYXRlQk0yNVNjb3JlKGNodW5rLCBxdWVyeVRva2Vucyk7XG4gICAgICAgIHJldHVybiB7IGNodW5rLCBzY29yZSB9O1xuICAgICAgfSlcbiAgICAgIC5maWx0ZXIoKHgpID0+IHguc2NvcmUgPiAwKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlKVxuICAgICAgLnNsaWNlKDAsIHRoaXMuc2V0dGluZ3MubWF4Q2h1bmtzKVxuICAgICAgLm1hcCgoeCkgPT4geC5jaHVuayk7XG5cbiAgICByZXR1cm4gc2NvcmVkO1xuICB9XG5cbiAgcHJpdmF0ZSByZXRyaWV2ZVJlbGV2YW50Q2h1bmtzRm9yRmlsZShxdWVzdGlvbjogc3RyaW5nLCBmaWxlUGF0aDogc3RyaW5nKTogTm90ZUNodW5rW10ge1xuICAgIGNvbnN0IHF1ZXJ5VG9rZW5zID0gdGhpcy50b2tlbml6ZShxdWVzdGlvbik7XG4gICAgaWYgKCFxdWVyeVRva2Vucy5sZW5ndGgpIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICBjb25zdCBzY29yZWQgPSB0aGlzLm5vdGVJbmRleFxuICAgICAgLmZpbHRlcigoY2h1bmspID0+IGNodW5rLmZpbGVQYXRoID09PSBmaWxlUGF0aClcbiAgICAgIC5tYXAoKGNodW5rKSA9PiB7XG4gICAgICAgIGNvbnN0IHNjb3JlID0gdGhpcy5jYWxjdWxhdGVCTTI1U2NvcmUoY2h1bmssIHF1ZXJ5VG9rZW5zKTtcbiAgICAgICAgcmV0dXJuIHsgY2h1bmssIHNjb3JlIH07XG4gICAgICB9KVxuICAgICAgLmZpbHRlcigoeCkgPT4geC5zY29yZSA+IDApXG4gICAgICAuc29ydCgoYSwgYikgPT4gYi5zY29yZSAtIGEuc2NvcmUpXG4gICAgICAuc2xpY2UoMCwgdGhpcy5zZXR0aW5ncy5tYXhDaHVua3MpXG4gICAgICAubWFwKCh4KSA9PiB4LmNodW5rKTtcblxuICAgIHJldHVybiBzY29yZWQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHF1ZXJ5T3BlblJvdXRlcldpdGhNZXNzYWdlcyhcbiAgICBzeXN0ZW1Qcm9tcHQ6IHN0cmluZyxcbiAgICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXVxuICApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IGFwaUtleSA9IHRoaXMuZ2V0QXBpS2V5T3JUaHJvdygpO1xuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0VXJsKHtcbiAgICAgIHVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxL2NoYXQvY29tcGxldGlvbnNcIixcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthcGlLZXl9YCxcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIFwiSFRUUC1SZWZlcmVyXCI6IFwiaHR0cHM6Ly9vYnNpZGlhbi5tZFwiLFxuICAgICAgICBcIlgtVGl0bGVcIjogXCJPYnNpZGlhbiBSQUcgT3BlblJvdXRlciBQbHVnaW5cIlxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbW9kZWw6IHRoaXMuc2V0dGluZ3MubW9kZWwsXG4gICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgeyByb2xlOiBcInN5c3RlbVwiLCBjb250ZW50OiBzeXN0ZW1Qcm9tcHQgfSxcbiAgICAgICAgICAuLi5tZXNzYWdlcy5tYXAoKG1zZykgPT4gKHsgcm9sZTogbXNnLnJvbGUsIGNvbnRlbnQ6IG1zZy5jb250ZW50IH0pKVxuICAgICAgICBdLFxuICAgICAgICB0ZW1wZXJhdHVyZTogMC4yXG4gICAgICB9KVxuICAgIH0pO1xuXG4gICAgY29uc3QgYW5zd2VyID0gcmVzcG9uc2UuanNvbj8uY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50O1xuICAgIGlmICghYW5zd2VyIHx8IHR5cGVvZiBhbnN3ZXIgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk9wZW5Sb3V0ZXIgcmV0dXJuZWQgYW4gdW5leHBlY3RlZCByZXNwb25zZS5cIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIGFuc3dlcjtcbiAgfVxuXG4gIGFzeW5jIHN1bW1hcml6ZUNoYXRNZXNzYWdlcyhtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgaWYgKCFtZXNzYWdlcy5sZW5ndGgpIHtcbiAgICAgIHJldHVybiBcIlwiO1xuICAgIH1cblxuICAgIGNvbnN0IHRyYW5zY3JpcHQgPSBtZXNzYWdlc1xuICAgICAgLm1hcCgobXNnKSA9PiBgJHttc2cucm9sZSA9PT0gXCJ1c2VyXCIgPyBcIlVzZXJcIiA6IFwiQXNzaXN0YW50XCJ9OiAke21zZy5jb250ZW50fWApXG4gICAgICAuam9pbihcIlxcblxcblwiKTtcblxuICAgIGNvbnN0IHN1bW1hcnkgPSBhd2FpdCB0aGlzLnF1ZXJ5T3BlblJvdXRlcldpdGhNZXNzYWdlcyhcbiAgICAgIFwiU3VtbWFyaXplIHRoZSBjb252ZXJzYXRpb24gaW50byBjb21wYWN0IGZhY3R1YWwgbWVtb3J5IGJ1bGxldHMuIEtlZXAgY3JpdGljYWwgY29uc3RyYWludHMgYW5kIGRlY2lzaW9ucy5cIixcbiAgICAgIFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiB0cmFuc2NyaXB0IH1dXG4gICAgKTtcblxuICAgIHJldHVybiBzdW1tYXJ5LnRyaW0oKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc3RyZWFtT3BlblJvdXRlcldpdGhNZXNzYWdlcyhcbiAgICBzeXN0ZW1Qcm9tcHQ6IHN0cmluZyxcbiAgICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSxcbiAgICBoYW5kbGVyczogU3RyZWFtSGFuZGxlcnMgPSB7fVxuICApOiBQcm9taXNlPHsgcmF3QW5zd2VyOiBzdHJpbmc7IHRoaW5raW5nOiBzdHJpbmcgfT4ge1xuICAgIGNvbnN0IGFwaUtleSA9IHRoaXMuZ2V0QXBpS2V5T3JUaHJvdygpO1xuXG4gICAgY29uc3QgYm9keSA9IHtcbiAgICAgIG1vZGVsOiB0aGlzLnNldHRpbmdzLm1vZGVsLFxuICAgICAgbWVzc2FnZXM6IFtcbiAgICAgICAgeyByb2xlOiBcInN5c3RlbVwiLCBjb250ZW50OiBzeXN0ZW1Qcm9tcHQgfSxcbiAgICAgICAgLi4ubWVzc2FnZXMubWFwKChtc2cpID0+ICh7IHJvbGU6IG1zZy5yb2xlLCBjb250ZW50OiBtc2cuY29udGVudCB9KSlcbiAgICAgIF0sXG4gICAgICB0ZW1wZXJhdHVyZTogMC4yLFxuICAgICAgc3RyZWFtOiB0cnVlLFxuICAgICAgaW5jbHVkZV9yZWFzb25pbmc6IHRydWVcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjEvY2hhdC9jb21wbGV0aW9uc1wiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YXBpS2V5fWAsXG4gICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICBcIkhUVFAtUmVmZXJlclwiOiBcImh0dHBzOi8vb2JzaWRpYW4ubWRcIixcbiAgICAgICAgXCJYLVRpdGxlXCI6IFwiT2JzaWRpYW4gUkFHIE9wZW5Sb3V0ZXIgUGx1Z2luXCJcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KVxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgbGV0IGRldGFpbHMgPSBcIlwiO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZGV0YWlscyA9IChhd2FpdCByZXNwb25zZS50ZXh0KCkpLnNsaWNlKDAsIDMwMCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgZGV0YWlscyA9IFwiXCI7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJPcGVuUm91dGVyIGF1dGhlbnRpY2F0aW9uIGZhaWxlZCAoNDAxKS4gVmVyaWZ5IEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzLlwiKTtcbiAgICAgIH1cblxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgT3BlblJvdXRlciByZXF1ZXN0IGZhaWxlZCAoJHtyZXNwb25zZS5zdGF0dXN9JHtyZXNwb25zZS5zdGF0dXNUZXh0ID8gYCAke3Jlc3BvbnNlLnN0YXR1c1RleHR9YCA6IFwiXCJ9KSR7ZGV0YWlscyA/IGA6ICR7ZGV0YWlsc31gIDogXCJcIn1gXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmICghcmVzcG9uc2UuYm9keSkge1xuICAgICAgY29uc3QgZmFsbGJhY2tBbnN3ZXIgPSBhd2FpdCB0aGlzLnF1ZXJ5T3BlblJvdXRlcldpdGhNZXNzYWdlcyhzeXN0ZW1Qcm9tcHQsIG1lc3NhZ2VzKTtcbiAgICAgIGhhbmRsZXJzLm9uQW5zd2VyRGVsdGE/LihmYWxsYmFja0Fuc3dlcik7XG4gICAgICByZXR1cm4geyByYXdBbnN3ZXI6IGZhbGxiYWNrQW5zd2VyLCB0aGlua2luZzogXCJcIiB9O1xuICAgIH1cblxuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXJlZCA9IFwiXCI7XG4gICAgbGV0IHJhd0Fuc3dlciA9IFwiXCI7XG4gICAgbGV0IHRoaW5raW5nID0gXCJcIjtcblxuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGJ1ZmZlcmVkICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IGxpbmVzID0gYnVmZmVyZWQuc3BsaXQoXCJcXG5cIik7XG4gICAgICBidWZmZXJlZCA9IGxpbmVzLnBvcCgpID8/IFwiXCI7XG5cbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgICAgIGlmICghdHJpbW1lZC5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBheWxvYWRUZXh0ID0gdHJpbW1lZC5zbGljZSg1KS50cmltKCk7XG4gICAgICAgIGlmICghcGF5bG9hZFRleHQgfHwgcGF5bG9hZFRleHQgPT09IFwiW0RPTkVdXCIpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcGF5bG9hZCA9IEpTT04ucGFyc2UocGF5bG9hZFRleHQpIGFzIHtcbiAgICAgICAgICAgIGNob2ljZXM/OiBBcnJheTx7XG4gICAgICAgICAgICAgIGRlbHRhPzoge1xuICAgICAgICAgICAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICAgICAgICAgICAgcmVhc29uaW5nPzogc3RyaW5nO1xuICAgICAgICAgICAgICAgIHJlYXNvbmluZ19jb250ZW50Pzogc3RyaW5nO1xuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfT47XG4gICAgICAgICAgfTtcblxuICAgICAgICAgIGNvbnN0IGRlbHRhID0gcGF5bG9hZC5jaG9pY2VzPy5bMF0/LmRlbHRhO1xuICAgICAgICAgIGNvbnN0IGNvbnRlbnREZWx0YSA9IHR5cGVvZiBkZWx0YT8uY29udGVudCA9PT0gXCJzdHJpbmdcIiA/IGRlbHRhLmNvbnRlbnQgOiBcIlwiO1xuICAgICAgICAgIGNvbnN0IHJlYXNvbmluZ0RlbHRhID1cbiAgICAgICAgICAgIHR5cGVvZiBkZWx0YT8ucmVhc29uaW5nID09PSBcInN0cmluZ1wiXG4gICAgICAgICAgICAgID8gZGVsdGEucmVhc29uaW5nXG4gICAgICAgICAgICAgIDogdHlwZW9mIGRlbHRhPy5yZWFzb25pbmdfY29udGVudCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgICAgICAgID8gZGVsdGEucmVhc29uaW5nX2NvbnRlbnRcbiAgICAgICAgICAgICAgICA6IFwiXCI7XG5cbiAgICAgICAgICBpZiAoY29udGVudERlbHRhKSB7XG4gICAgICAgICAgICByYXdBbnN3ZXIgKz0gY29udGVudERlbHRhO1xuICAgICAgICAgICAgaGFuZGxlcnMub25BbnN3ZXJEZWx0YT8uKGNvbnRlbnREZWx0YSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlYXNvbmluZ0RlbHRhKSB7XG4gICAgICAgICAgICB0aGlua2luZyArPSByZWFzb25pbmdEZWx0YTtcbiAgICAgICAgICAgIGhhbmRsZXJzLm9uVGhpbmtpbmdEZWx0YT8uKHJlYXNvbmluZ0RlbHRhKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgcmF3QW5zd2VyLCB0aGlua2luZyB9O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBxdWVyeU9wZW5Sb3V0ZXIocXVlc3Rpb246IHN0cmluZywgY29udGV4dENodW5rczogTm90ZUNodW5rW10pOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IGNvbnRleHRUZXh0ID0gY29udGV4dENodW5rc1xuICAgICAgLm1hcCgoY2h1bmssIGluZGV4KSA9PiB7XG4gICAgICAgIHJldHVybiBgU291cmNlICR7aW5kZXggKyAxfSAoJHtjaHVuay5maWxlUGF0aH0pOlxcbiR7Y2h1bmsuY2h1bmtUZXh0fWA7XG4gICAgICB9KVxuICAgICAgLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIik7XG5cbiAgICBjb25zdCBzeXN0ZW1Qcm9tcHQgPVxuICAgICAgXCJZb3UgYXJlIGEgbm90ZSBhc3Npc3RhbnQuIEFuc3dlciB0aGUgcXVlc3Rpb24gdXNpbmcgdGhlIHByb3ZpZGVkIG5vdGUgY29udGV4dCB3aGVuIHJlbGV2YW50LiBJZiBjb250ZXh0IGlzIGluc3VmZmljaWVudCwgc2F5IHdoYXQgaXMgbWlzc2luZy5cIjtcblxuICAgIGNvbnN0IHVzZXJQcm9tcHQgPSBbXG4gICAgICBcIlF1ZXN0aW9uOlwiLFxuICAgICAgcXVlc3Rpb24sXG4gICAgICBcIlwiLFxuICAgICAgXCJSZXRyaWV2ZWQgTm90ZSBDb250ZXh0OlwiLFxuICAgICAgY29udGV4dFRleHQgfHwgXCJObyBjb250ZXh0IHJldHJpZXZlZC5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIlJlcXVpcmVtZW50czpcIixcbiAgICAgIFwiLSBCZSBjb25jaXNlIGFuZCBmYWN0dWFsLlwiLFxuICAgICAgXCItIENpdGUgc291cmNlIG51bWJlcnMgbGlrZSBbMV0sIFsyXSB3aGVuIHVzaW5nIGNvbnRleHQuXCIsXG4gICAgICBcIi0gSWYgeW91IGFyZSB1bmNlcnRhaW4sIGNsZWFybHkgc2F5IHNvLlwiXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgcmV0dXJuIHRoaXMucXVlcnlPcGVuUm91dGVyV2l0aE1lc3NhZ2VzKHN5c3RlbVByb21wdCwgW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IHVzZXJQcm9tcHQgfV0pO1xuICB9XG5cbiAgYXN5bmMgY2hhdFdpdGhOb3RlKFxuICAgIG5vdGVGaWxlUGF0aDogc3RyaW5nLFxuICAgIHF1ZXN0aW9uOiBzdHJpbmcsXG4gICAgaGlzdG9yeTogQ2hhdE1lc3NhZ2VbXVxuICApOiBQcm9taXNlPHsgYW5zd2VyOiBzdHJpbmc7IGNodW5rczogTm90ZUNodW5rW10gfT4ge1xuICAgIGlmICghcXVlc3Rpb24udHJpbSgpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU2V0IHlvdXIgT3BlblJvdXRlciBBUEkga2V5IGluIHBsdWdpbiBzZXR0aW5ncyBmaXJzdC5cIik7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLm5vdGVJbmRleC5sZW5ndGgpIHtcbiAgICAgIGF3YWl0IHRoaXMucmVidWlsZEluZGV4KCk7XG4gICAgfVxuXG4gICAgY29uc3QgdG9wQ2h1bmtzID0gdGhpcy5yZXRyaWV2ZVJlbGV2YW50Q2h1bmtzRm9yRmlsZShxdWVzdGlvbiwgbm90ZUZpbGVQYXRoKTtcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IHRvcENodW5rc1xuICAgICAgLm1hcCgoY2h1bmssIGluZGV4KSA9PiBgU291cmNlICR7aW5kZXggKyAxfSAoJHtjaHVuay5maWxlUGF0aH0pOlxcbiR7Y2h1bmsuY2h1bmtUZXh0fWApXG4gICAgICAuam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcblxuICAgIGNvbnN0IHN5c3RlbVByb21wdCA9XG4gICAgICBcIllvdSBhcmUgYSBub3RlIGFzc2lzdGFudC4gS2VlcCByZXNwb25zZXMgZ3JvdW5kZWQgaW4gdGhlIHByb3ZpZGVkIG5vdGUgY29udGV4dCBhbmQgY29udmVyc2F0aW9uIGhpc3RvcnkuIElmIGNvbnRleHQgaXMgbWlzc2luZywgc2F5IHdoYXQgaXMgbWlzc2luZy5cIjtcblxuICAgIGNvbnN0IHVzZXJQcm9tcHQgPSBbXG4gICAgICBgQ3VycmVudCBub3RlOiAke25vdGVGaWxlUGF0aH1gLFxuICAgICAgXCJcIixcbiAgICAgIFwiUXVlc3Rpb246XCIsXG4gICAgICBxdWVzdGlvbixcbiAgICAgIFwiXCIsXG4gICAgICBcIlJldHJpZXZlZCBOb3RlIENvbnRleHQ6XCIsXG4gICAgICBjb250ZXh0VGV4dCB8fCBcIk5vIGNvbnRleHQgcmV0cmlldmVkIGZyb20gdGhpcyBub3RlLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiUmVxdWlyZW1lbnRzOlwiLFxuICAgICAgXCItIEJlIGNvbmNpc2UgYW5kIGZhY3R1YWwuXCIsXG4gICAgICBcIi0gQ2l0ZSBzb3VyY2UgbnVtYmVycyBsaWtlIFsxXSwgWzJdIHdoZW4gdXNpbmcgY29udGV4dC5cIixcbiAgICAgIFwiLSBJZiB1bmNlcnRhaW4sIGNsZWFybHkgc2F5IHNvLlwiXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgYm91bmRlZEhpc3RvcnkgPSBoaXN0b3J5LnNsaWNlKC04KTtcbiAgICBjb25zdCBhbnN3ZXIgPSBhd2FpdCB0aGlzLnF1ZXJ5T3BlblJvdXRlcldpdGhNZXNzYWdlcyhzeXN0ZW1Qcm9tcHQsIFtcbiAgICAgIC4uLmJvdW5kZWRIaXN0b3J5LFxuICAgICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogdXNlclByb21wdCB9XG4gICAgXSk7XG5cbiAgICByZXR1cm4geyBhbnN3ZXIsIGNodW5rczogdG9wQ2h1bmtzIH07XG4gIH1cblxuICBhc3luYyBzdHJlYW1DaGF0V2l0aE5vdGUoXG4gICAgbm90ZUZpbGVQYXRoOiBzdHJpbmcsXG4gICAgcXVlc3Rpb246IHN0cmluZyxcbiAgICBoaXN0b3J5OiBDaGF0TWVzc2FnZVtdLFxuICAgIGhhbmRsZXJzOiBTdHJlYW1IYW5kbGVycyA9IHt9XG4gICk6IFByb21pc2U8eyBhbnN3ZXI6IHN0cmluZzsgY2h1bmtzOiBOb3RlQ2h1bmtbXTsgdGhpbmtpbmc6IHN0cmluZyB9PiB7XG4gICAgaWYgKCFxdWVzdGlvbi50cmltKCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlF1ZXN0aW9uIGNhbm5vdCBiZSBlbXB0eS5cIik7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLnNldHRpbmdzLm9wZW5Sb3V0ZXJBcGlLZXkudHJpbSgpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTZXQgeW91ciBPcGVuUm91dGVyIEFQSSBrZXkgaW4gcGx1Z2luIHNldHRpbmdzIGZpcnN0LlwiKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMubm90ZUluZGV4Lmxlbmd0aCkge1xuICAgICAgYXdhaXQgdGhpcy5yZWJ1aWxkSW5kZXgoKTtcbiAgICB9XG5cbiAgICBjb25zdCB0b3BDaHVua3MgPSB0aGlzLnJldHJpZXZlUmVsZXZhbnRDaHVua3NGb3JGaWxlKHF1ZXN0aW9uLCBub3RlRmlsZVBhdGgpO1xuICAgIGNvbnN0IGNvbnRleHRUZXh0ID0gdG9wQ2h1bmtzXG4gICAgICAubWFwKChjaHVuaywgaW5kZXgpID0+IGBTb3VyY2UgJHtpbmRleCArIDF9ICgke2NodW5rLmZpbGVQYXRofSk6XFxuJHtjaHVuay5jaHVua1RleHR9YClcbiAgICAgIC5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpO1xuXG4gICAgY29uc3Qgc3lzdGVtUHJvbXB0ID1cbiAgICAgIFwiWW91IGFyZSBhIG5vdGUgYXNzaXN0YW50LiBLZWVwIHJlc3BvbnNlcyBncm91bmRlZCBpbiB0aGUgcHJvdmlkZWQgbm90ZSBjb250ZXh0IGFuZCBjb252ZXJzYXRpb24gaGlzdG9yeS4gSWYgY29udGV4dCBpcyBtaXNzaW5nLCBzYXkgd2hhdCBpcyBtaXNzaW5nLlwiO1xuXG4gICAgY29uc3QgdXNlclByb21wdCA9IFtcbiAgICAgIGBDdXJyZW50IG5vdGU6ICR7bm90ZUZpbGVQYXRofWAsXG4gICAgICBcIlwiLFxuICAgICAgXCJRdWVzdGlvbjpcIixcbiAgICAgIHF1ZXN0aW9uLFxuICAgICAgXCJcIixcbiAgICAgIFwiUmV0cmlldmVkIE5vdGUgQ29udGV4dDpcIixcbiAgICAgIGNvbnRleHRUZXh0IHx8IFwiTm8gY29udGV4dCByZXRyaWV2ZWQgZnJvbSB0aGlzIG5vdGUuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJSZXF1aXJlbWVudHM6XCIsXG4gICAgICBcIi0gQmUgY29uY2lzZSBhbmQgZmFjdHVhbC5cIixcbiAgICAgIFwiLSBDaXRlIHNvdXJjZSBudW1iZXJzIGxpa2UgWzFdLCBbMl0gd2hlbiB1c2luZyBjb250ZXh0LlwiLFxuICAgICAgXCItIElmIHVuY2VydGFpbiwgY2xlYXJseSBzYXkgc28uXCJcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCBib3VuZGVkSGlzdG9yeSA9IGhpc3Rvcnkuc2xpY2UoLTgpO1xuICAgIGNvbnN0IHN0cmVhbWVkID0gYXdhaXQgdGhpcy5zdHJlYW1PcGVuUm91dGVyV2l0aE1lc3NhZ2VzKFxuICAgICAgc3lzdGVtUHJvbXB0LFxuICAgICAgWy4uLmJvdW5kZWRIaXN0b3J5LCB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiB1c2VyUHJvbXB0IH1dLFxuICAgICAgaGFuZGxlcnNcbiAgICApO1xuXG4gICAgcmV0dXJuIHsgYW5zd2VyOiBzdHJlYW1lZC5yYXdBbnN3ZXIsIGNodW5rczogdG9wQ2h1bmtzLCB0aGlua2luZzogc3RyZWFtZWQudGhpbmtpbmcgfTtcbiAgfVxuXG4gIGFzeW5jIGNoYXRXaXRoVmF1bHQoXG4gICAgcXVlc3Rpb246IHN0cmluZyxcbiAgICBoaXN0b3J5OiBDaGF0TWVzc2FnZVtdXG4gICk6IFByb21pc2U8eyBhbnN3ZXI6IHN0cmluZzsgY2h1bmtzOiBOb3RlQ2h1bmtbXTsgcGVuZGluZ0FjdGlvbnM6IEFnZW50QWN0aW9uW10gfT4ge1xuICAgIGlmICghcXVlc3Rpb24udHJpbSgpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU2V0IHlvdXIgT3BlblJvdXRlciBBUEkga2V5IGluIHBsdWdpbiBzZXR0aW5ncyBmaXJzdC5cIik7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLm5vdGVJbmRleC5sZW5ndGgpIHtcbiAgICAgIGF3YWl0IHRoaXMucmVidWlsZEluZGV4KCk7XG4gICAgfVxuXG4gICAgY29uc3QgdG9wQ2h1bmtzID0gdGhpcy5yZXRyaWV2ZVJlbGV2YW50Q2h1bmtzKHF1ZXN0aW9uKTtcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IHRvcENodW5rc1xuICAgICAgLm1hcCgoY2h1bmssIGluZGV4KSA9PiBgU291cmNlICR7aW5kZXggKyAxfSAoJHtjaHVuay5maWxlUGF0aH0pOlxcbiR7Y2h1bmsuY2h1bmtUZXh0fWApXG4gICAgICAuam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcblxuICAgIGNvbnN0IHN5c3RlbVByb21wdCA9IFtcbiAgICAgIFwiWW91IGFyZSBhIHZhdWx0IGFzc2lzdGFudC4gVXNlIHByb3ZpZGVkIG5vdGUgY29udGV4dCBhbmQgY29udmVyc2F0aW9uIGhpc3RvcnkuXCIsXG4gICAgICBcIllvdSBtYXkgY3JlYXRlIGZvbGRlcnMvZmlsZXMgd2hlbiBleHBsaWNpdGx5IHVzZWZ1bCB0byB0aGUgdXNlcidzIHJlcXVlc3QuXCIsXG4gICAgICBcIk5ldmVyIGRlbGV0ZSBvciByZW5hbWUgZmlsZXMuXCIsXG4gICAgICBcIldoZW4gcHJvcG9zaW5nIGFjdGlvbnMsIGFwcGVuZCBleGFjdGx5IG9uZSBmZW5jZWQgY29kZSBibG9jayB3aXRoIGxhbmd1YWdlIHRhZyBhZ2VudC1hY3Rpb25zIGFuZCBKU09OIHBheWxvYWQ6XCIsXG4gICAgICBcIntcXFwiYWN0aW9uc1xcXCI6W3tcXFwidHlwZVxcXCI6XFxcImNyZWF0ZV9mb2xkZXJcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiY3JlYXRlX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIixcXFwib3ZlcndyaXRlXFxcIjpmYWxzZX0se1xcXCJ0eXBlXFxcIjpcXFwiYXBwZW5kX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiaW5zZXJ0X2FmdGVyX2hlYWRpbmdcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJoZWFkaW5nXFxcIjpcXFwiIyMgU2VjdGlvblxcXCIsXFxcImNvbnRlbnRcXFwiOlxcXCIuLi5cXFwifSx7XFxcInR5cGVcXFwiOlxcXCJyZXBsYWNlX2luX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJmaW5kXFxcIjpcXFwib2xkXFxcIixcXFwicmVwbGFjZVxcXCI6XFxcIm5ld1xcXCIsXFxcInJlcGxhY2VBbGxcXFwiOmZhbHNlfSx7XFxcInR5cGVcXFwiOlxcXCJjcmVhdGVfZnJvbV90ZW1wbGF0ZVxcXCIsXFxcInBhdGhcXFwiOlxcXCJGb2xkZXIvcGxhbi5tZFxcXCIsXFxcInRlbXBsYXRlXFxcIjpcXFwicHJvamVjdC1wbGFuXFxcIixcXFwidmFyaWFibGVzXFxcIjp7XFxcInRpdGxlXFxcIjpcXFwiUHJvamVjdFxcXCJ9fV19XCIsXG4gICAgICBcIlRlbXBsYXRlIG5hbWVzIGF2YWlsYWJsZTogcHJvamVjdC1wbGFuLCBtZWV0aW5nLW5vdGUsIHdvcmxkLWxvcmUsIGNoYXJhY3Rlci1zaGVldC5cIixcbiAgICAgIFwiT25seSB1c2UgcmVsYXRpdmUgdmF1bHQgcGF0aHMuXCJcbiAgICBdLmpvaW4oXCIgXCIpO1xuXG4gICAgY29uc3QgdXNlclByb21wdCA9IFtcbiAgICAgIFwiUXVlc3Rpb246XCIsXG4gICAgICBxdWVzdGlvbixcbiAgICAgIFwiXCIsXG4gICAgICBcIlJldHJpZXZlZCBWYXVsdCBDb250ZXh0OlwiLFxuICAgICAgY29udGV4dFRleHQgfHwgXCJObyBjb250ZXh0IHJldHJpZXZlZC5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIlJlcXVpcmVtZW50czpcIixcbiAgICAgIFwiLSBCZSBjb25jaXNlIGFuZCBmYWN0dWFsLlwiLFxuICAgICAgXCItIENpdGUgc291cmNlIG51bWJlcnMgbGlrZSBbMV0sIFsyXSB3aGVuIHVzaW5nIGNvbnRleHQuXCIsXG4gICAgICBcIi0gSWYgdW5jZXJ0YWluLCBjbGVhcmx5IHNheSBzby5cIlxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGNvbnN0IGJvdW5kZWRIaXN0b3J5ID0gaGlzdG9yeS5zbGljZSgtOCk7XG4gICAgY29uc3QgcmF3QW5zd2VyID0gYXdhaXQgdGhpcy5xdWVyeU9wZW5Sb3V0ZXJXaXRoTWVzc2FnZXMoc3lzdGVtUHJvbXB0LCBbXG4gICAgICAuLi5ib3VuZGVkSGlzdG9yeSxcbiAgICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IHVzZXJQcm9tcHQgfVxuICAgIF0pO1xuXG4gICAgY29uc3QgeyBhbnN3ZXJUZXh0LCBhY3Rpb25zIH0gPSB0aGlzLmV4dHJhY3RBZ2VudEFjdGlvbnMocmF3QW5zd2VyKTtcblxuICAgIHJldHVybiB7XG4gICAgICBhbnN3ZXI6IGFuc3dlclRleHQsXG4gICAgICBjaHVua3M6IHRvcENodW5rcyxcbiAgICAgIHBlbmRpbmdBY3Rpb25zOiBhY3Rpb25zXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIHN0cmVhbUNoYXRXaXRoVmF1bHQoXG4gICAgcXVlc3Rpb246IHN0cmluZyxcbiAgICBoaXN0b3J5OiBDaGF0TWVzc2FnZVtdLFxuICAgIGhhbmRsZXJzOiBTdHJlYW1IYW5kbGVycyA9IHt9XG4gICk6IFByb21pc2U8eyBhbnN3ZXI6IHN0cmluZzsgY2h1bmtzOiBOb3RlQ2h1bmtbXTsgcGVuZGluZ0FjdGlvbnM6IEFnZW50QWN0aW9uW107IHRoaW5raW5nOiBzdHJpbmcgfT4ge1xuICAgIGlmICghcXVlc3Rpb24udHJpbSgpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJRdWVzdGlvbiBjYW5ub3QgYmUgZW1wdHkuXCIpO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5LnRyaW0oKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU2V0IHlvdXIgT3BlblJvdXRlciBBUEkga2V5IGluIHBsdWdpbiBzZXR0aW5ncyBmaXJzdC5cIik7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLm5vdGVJbmRleC5sZW5ndGgpIHtcbiAgICAgIGF3YWl0IHRoaXMucmVidWlsZEluZGV4KCk7XG4gICAgfVxuXG4gICAgY29uc3QgdG9wQ2h1bmtzID0gdGhpcy5yZXRyaWV2ZVJlbGV2YW50Q2h1bmtzKHF1ZXN0aW9uKTtcbiAgICBjb25zdCBjb250ZXh0VGV4dCA9IHRvcENodW5rc1xuICAgICAgLm1hcCgoY2h1bmssIGluZGV4KSA9PiBgU291cmNlICR7aW5kZXggKyAxfSAoJHtjaHVuay5maWxlUGF0aH0pOlxcbiR7Y2h1bmsuY2h1bmtUZXh0fWApXG4gICAgICAuam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcblxuICAgIGNvbnN0IHN5c3RlbVByb21wdCA9IFtcbiAgICAgIFwiWW91IGFyZSBhIHZhdWx0IGFzc2lzdGFudC4gVXNlIHByb3ZpZGVkIG5vdGUgY29udGV4dCBhbmQgY29udmVyc2F0aW9uIGhpc3RvcnkuXCIsXG4gICAgICBcIllvdSBtYXkgY3JlYXRlIGZvbGRlcnMvZmlsZXMgd2hlbiBleHBsaWNpdGx5IHVzZWZ1bCB0byB0aGUgdXNlcidzIHJlcXVlc3QuXCIsXG4gICAgICBcIk5ldmVyIGRlbGV0ZSBvciByZW5hbWUgZmlsZXMuXCIsXG4gICAgICBcIldoZW4gcHJvcG9zaW5nIGFjdGlvbnMsIGFwcGVuZCBleGFjdGx5IG9uZSBmZW5jZWQgY29kZSBibG9jayB3aXRoIGxhbmd1YWdlIHRhZyBhZ2VudC1hY3Rpb25zIGFuZCBKU09OIHBheWxvYWQ6XCIsXG4gICAgICBcIntcXFwiYWN0aW9uc1xcXCI6W3tcXFwidHlwZVxcXCI6XFxcImNyZWF0ZV9mb2xkZXJcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiY3JlYXRlX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIixcXFwib3ZlcndyaXRlXFxcIjpmYWxzZX0se1xcXCJ0eXBlXFxcIjpcXFwiYXBwZW5kX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJjb250ZW50XFxcIjpcXFwiLi4uXFxcIn0se1xcXCJ0eXBlXFxcIjpcXFwiaW5zZXJ0X2FmdGVyX2hlYWRpbmdcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJoZWFkaW5nXFxcIjpcXFwiIyMgU2VjdGlvblxcXCIsXFxcImNvbnRlbnRcXFwiOlxcXCIuLi5cXFwifSx7XFxcInR5cGVcXFwiOlxcXCJyZXBsYWNlX2luX2ZpbGVcXFwiLFxcXCJwYXRoXFxcIjpcXFwiRm9sZGVyL2ZpbGUubWRcXFwiLFxcXCJmaW5kXFxcIjpcXFwib2xkXFxcIixcXFwicmVwbGFjZVxcXCI6XFxcIm5ld1xcXCIsXFxcInJlcGxhY2VBbGxcXFwiOmZhbHNlfSx7XFxcInR5cGVcXFwiOlxcXCJjcmVhdGVfZnJvbV90ZW1wbGF0ZVxcXCIsXFxcInBhdGhcXFwiOlxcXCJGb2xkZXIvcGxhbi5tZFxcXCIsXFxcInRlbXBsYXRlXFxcIjpcXFwicHJvamVjdC1wbGFuXFxcIixcXFwidmFyaWFibGVzXFxcIjp7XFxcInRpdGxlXFxcIjpcXFwiUHJvamVjdFxcXCJ9fV19XCIsXG4gICAgICBcIlRlbXBsYXRlIG5hbWVzIGF2YWlsYWJsZTogcHJvamVjdC1wbGFuLCBtZWV0aW5nLW5vdGUsIHdvcmxkLWxvcmUsIGNoYXJhY3Rlci1zaGVldC5cIixcbiAgICAgIFwiT25seSB1c2UgcmVsYXRpdmUgdmF1bHQgcGF0aHMuXCJcbiAgICBdLmpvaW4oXCIgXCIpO1xuXG4gICAgY29uc3QgdXNlclByb21wdCA9IFtcbiAgICAgIFwiUXVlc3Rpb246XCIsXG4gICAgICBxdWVzdGlvbixcbiAgICAgIFwiXCIsXG4gICAgICBcIlJldHJpZXZlZCBWYXVsdCBDb250ZXh0OlwiLFxuICAgICAgY29udGV4dFRleHQgfHwgXCJObyBjb250ZXh0IHJldHJpZXZlZC5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIlJlcXVpcmVtZW50czpcIixcbiAgICAgIFwiLSBCZSBjb25jaXNlIGFuZCBmYWN0dWFsLlwiLFxuICAgICAgXCItIENpdGUgc291cmNlIG51bWJlcnMgbGlrZSBbMV0sIFsyXSB3aGVuIHVzaW5nIGNvbnRleHQuXCIsXG4gICAgICBcIi0gSWYgdW5jZXJ0YWluLCBjbGVhcmx5IHNheSBzby5cIlxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGNvbnN0IGJvdW5kZWRIaXN0b3J5ID0gaGlzdG9yeS5zbGljZSgtOCk7XG4gICAgY29uc3Qgc3RyZWFtZWQgPSBhd2FpdCB0aGlzLnN0cmVhbU9wZW5Sb3V0ZXJXaXRoTWVzc2FnZXMoXG4gICAgICBzeXN0ZW1Qcm9tcHQsXG4gICAgICBbLi4uYm91bmRlZEhpc3RvcnksIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IHVzZXJQcm9tcHQgfV0sXG4gICAgICBoYW5kbGVyc1xuICAgICk7XG5cbiAgICBjb25zdCB7IGFuc3dlclRleHQsIGFjdGlvbnMgfSA9IHRoaXMuZXh0cmFjdEFnZW50QWN0aW9ucyhzdHJlYW1lZC5yYXdBbnN3ZXIpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFuc3dlcjogYW5zd2VyVGV4dCxcbiAgICAgIGNodW5rczogdG9wQ2h1bmtzLFxuICAgICAgcGVuZGluZ0FjdGlvbnM6IGFjdGlvbnMsXG4gICAgICB0aGlua2luZzogc3RyZWFtZWQudGhpbmtpbmdcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBleHRyYWN0QWdlbnRBY3Rpb25zKHJhd0Fuc3dlcjogc3RyaW5nKTogeyBhbnN3ZXJUZXh0OiBzdHJpbmc7IGFjdGlvbnM6IEFnZW50QWN0aW9uW10gfSB7XG4gICAgY29uc3QgY2FuZGlkYXRlczogQXJyYXk8eyBqc29uVGV4dDogc3RyaW5nOyByZW1vdmVUZXh0OiBzdHJpbmcgfT4gPSBbXTtcblxuICAgIGNvbnN0IGFnZW50QWN0aW9uRmVuY2UgPSByYXdBbnN3ZXIubWF0Y2goL2BgYGFnZW50LWFjdGlvbnNcXHMqKFtcXHNcXFNdKj8pYGBgL2kpO1xuICAgIGlmIChhZ2VudEFjdGlvbkZlbmNlKSB7XG4gICAgICBjYW5kaWRhdGVzLnB1c2goe1xuICAgICAgICBqc29uVGV4dDogYWdlbnRBY3Rpb25GZW5jZVsxXS50cmltKCksXG4gICAgICAgIHJlbW92ZVRleHQ6IGFnZW50QWN0aW9uRmVuY2VbMF1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGpzb25GZW5jZSA9IHJhd0Fuc3dlci5tYXRjaCgvYGBganNvblxccyooW1xcc1xcU10qPylgYGAvaSk7XG4gICAgaWYgKGpzb25GZW5jZSAmJiAvXCJhY3Rpb25zXCJcXHMqOi8udGVzdChqc29uRmVuY2VbMV0pKSB7XG4gICAgICBjYW5kaWRhdGVzLnB1c2goe1xuICAgICAgICBqc29uVGV4dDoganNvbkZlbmNlWzFdLnRyaW0oKSxcbiAgICAgICAgcmVtb3ZlVGV4dDoganNvbkZlbmNlWzBdXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCByYXdKc29uT2JqZWN0ID0gdGhpcy5leHRyYWN0Rmlyc3RBY3Rpb25zSlNPTk9iamVjdChyYXdBbnN3ZXIpO1xuICAgIGlmIChyYXdKc29uT2JqZWN0KSB7XG4gICAgICBjYW5kaWRhdGVzLnB1c2goe1xuICAgICAgICBqc29uVGV4dDogcmF3SnNvbk9iamVjdCxcbiAgICAgICAgcmVtb3ZlVGV4dDogcmF3SnNvbk9iamVjdFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgbGV0IHBhcnNlZEFjdGlvbnM6IEFnZW50QWN0aW9uW10gPSBbXTtcbiAgICBsZXQgcmVtb3ZlVGV4dCA9IFwiXCI7XG5cbiAgICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgICBjb25zdCBtYXliZSA9IHRoaXMucGFyc2VBY3Rpb25zRnJvbUpzb24oY2FuZGlkYXRlLmpzb25UZXh0KTtcbiAgICAgIGlmIChtYXliZS5sZW5ndGgpIHtcbiAgICAgICAgcGFyc2VkQWN0aW9ucyA9IG1heWJlO1xuICAgICAgICByZW1vdmVUZXh0ID0gY2FuZGlkYXRlLnJlbW92ZVRleHQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghcGFyc2VkQWN0aW9ucy5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB7IGFuc3dlclRleHQ6IHJhd0Fuc3dlci50cmltKCksIGFjdGlvbnM6IFtdIH07XG4gICAgfVxuXG4gICAgY29uc3Qgc3RyaXBwZWQgPSByZW1vdmVUZXh0ID8gcmF3QW5zd2VyLnJlcGxhY2UocmVtb3ZlVGV4dCwgXCJcIikudHJpbSgpIDogcmF3QW5zd2VyLnRyaW0oKTtcbiAgICBjb25zdCBhbnN3ZXJUZXh0ID0gc3RyaXBwZWQgfHwgXCJQbGFubmVkIGFjdGlvbnMgYXJlIHJlYWR5LiBSZXZpZXcgYW5kIGFwcHJvdmUgYmVsb3cuXCI7XG5cbiAgICByZXR1cm4ge1xuICAgICAgYW5zd2VyVGV4dCxcbiAgICAgIGFjdGlvbnM6IHBhcnNlZEFjdGlvbnNcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBwYXJzZUFjdGlvbnNGcm9tSnNvbihqc29uVGV4dDogc3RyaW5nKTogQWdlbnRBY3Rpb25bXSB7XG4gICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShqc29uVGV4dCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuXG4gICAgaWYgKCFwYXJzZWQgfHwgdHlwZW9mIHBhcnNlZCAhPT0gXCJvYmplY3RcIikge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cblxuICAgIGNvbnN0IG1heWJlQWN0aW9ucyA9IChwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmFjdGlvbnM7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KG1heWJlQWN0aW9ucykpIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICBjb25zdCBhY3Rpb25zOiBBZ2VudEFjdGlvbltdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGFjdGlvbiBvZiBtYXliZUFjdGlvbnMpIHtcbiAgICAgIGlmICghYWN0aW9uIHx8IHR5cGVvZiBhY3Rpb24gIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG9iaiA9IGFjdGlvbiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNvbnN0IHR5cGUgPSB0eXBlb2Ygb2JqLnR5cGUgPT09IFwic3RyaW5nXCIgPyBvYmoudHlwZSA6IFwiXCI7XG4gICAgICBjb25zdCBwYXRoID0gdHlwZW9mIG9iai5wYXRoID09PSBcInN0cmluZ1wiID8gb2JqLnBhdGggOiBcIlwiO1xuXG4gICAgICBpZiAodHlwZSA9PT0gXCJjcmVhdGVfZm9sZGVyXCIgJiYgcGF0aCkge1xuICAgICAgICBhY3Rpb25zLnB1c2goeyB0eXBlOiBcImNyZWF0ZV9mb2xkZXJcIiwgcGF0aCB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmICh0eXBlID09PSBcImNyZWF0ZV9maWxlXCIgJiYgcGF0aCAmJiB0eXBlb2Ygb2JqLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgYWN0aW9ucy5wdXNoKHtcbiAgICAgICAgICB0eXBlOiBcImNyZWF0ZV9maWxlXCIsXG4gICAgICAgICAgcGF0aCxcbiAgICAgICAgICBjb250ZW50OiBvYmouY29udGVudCxcbiAgICAgICAgICBvdmVyd3JpdGU6IHR5cGVvZiBvYmoub3ZlcndyaXRlID09PSBcImJvb2xlYW5cIiA/IG9iai5vdmVyd3JpdGUgOiB1bmRlZmluZWRcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodHlwZSA9PT0gXCJhcHBlbmRfZmlsZVwiICYmIHBhdGggJiYgdHlwZW9mIG9iai5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGFjdGlvbnMucHVzaCh7IHR5cGU6IFwiYXBwZW5kX2ZpbGVcIiwgcGF0aCwgY29udGVudDogb2JqLmNvbnRlbnQgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAoXG4gICAgICAgIHR5cGUgPT09IFwiaW5zZXJ0X2FmdGVyX2hlYWRpbmdcIiAmJlxuICAgICAgICBwYXRoICYmXG4gICAgICAgIHR5cGVvZiBvYmouaGVhZGluZyA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICB0eXBlb2Ygb2JqLmNvbnRlbnQgPT09IFwic3RyaW5nXCJcbiAgICAgICkge1xuICAgICAgICBhY3Rpb25zLnB1c2goe1xuICAgICAgICAgIHR5cGU6IFwiaW5zZXJ0X2FmdGVyX2hlYWRpbmdcIixcbiAgICAgICAgICBwYXRoLFxuICAgICAgICAgIGhlYWRpbmc6IG9iai5oZWFkaW5nLFxuICAgICAgICAgIGNvbnRlbnQ6IG9iai5jb250ZW50LFxuICAgICAgICAgIGNyZWF0ZUlmTWlzc2luZzogdHlwZW9mIG9iai5jcmVhdGVJZk1pc3NpbmcgPT09IFwiYm9vbGVhblwiID8gb2JqLmNyZWF0ZUlmTWlzc2luZyA6IHVuZGVmaW5lZFxuICAgICAgICB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgdHlwZSA9PT0gXCJyZXBsYWNlX2luX2ZpbGVcIiAmJlxuICAgICAgICBwYXRoICYmXG4gICAgICAgIHR5cGVvZiBvYmouZmluZCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICB0eXBlb2Ygb2JqLnJlcGxhY2UgPT09IFwic3RyaW5nXCJcbiAgICAgICkge1xuICAgICAgICBhY3Rpb25zLnB1c2goe1xuICAgICAgICAgIHR5cGU6IFwicmVwbGFjZV9pbl9maWxlXCIsXG4gICAgICAgICAgcGF0aCxcbiAgICAgICAgICBmaW5kOiBvYmouZmluZCxcbiAgICAgICAgICByZXBsYWNlOiBvYmoucmVwbGFjZSxcbiAgICAgICAgICByZXBsYWNlQWxsOiB0eXBlb2Ygb2JqLnJlcGxhY2VBbGwgPT09IFwiYm9vbGVhblwiID8gb2JqLnJlcGxhY2VBbGwgOiB1bmRlZmluZWRcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodHlwZSA9PT0gXCJjcmVhdGVfZnJvbV90ZW1wbGF0ZVwiICYmIHBhdGggJiYgdHlwZW9mIG9iai50ZW1wbGF0ZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBjb25zdCB2YXJpYWJsZXNSYXcgPSBvYmoudmFyaWFibGVzO1xuICAgICAgICBjb25zdCB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgICAgaWYgKHZhcmlhYmxlc1JhdyAmJiB0eXBlb2YgdmFyaWFibGVzUmF3ID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFyaWFibGVzUmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICB2YXJpYWJsZXNba2V5XSA9IHZhbHVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGFjdGlvbnMucHVzaCh7XG4gICAgICAgICAgdHlwZTogXCJjcmVhdGVfZnJvbV90ZW1wbGF0ZVwiLFxuICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgdGVtcGxhdGU6IG9iai50ZW1wbGF0ZSxcbiAgICAgICAgICB2YXJpYWJsZXMsXG4gICAgICAgICAgb3ZlcndyaXRlOiB0eXBlb2Ygb2JqLm92ZXJ3cml0ZSA9PT0gXCJib29sZWFuXCIgPyBvYmoub3ZlcndyaXRlIDogdW5kZWZpbmVkXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBhY3Rpb25zO1xuICB9XG5cbiAgcHJpdmF0ZSBleHRyYWN0Rmlyc3RBY3Rpb25zSlNPTk9iamVjdCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBhY3Rpb25zS2V5SW5kZXggPSB0ZXh0LnNlYXJjaCgvXCJhY3Rpb25zXCJcXHMqOi8pO1xuICAgIGlmIChhY3Rpb25zS2V5SW5kZXggPCAwKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBvYmplY3RTdGFydCA9IHRleHQubGFzdEluZGV4T2YoXCJ7XCIsIGFjdGlvbnNLZXlJbmRleCk7XG4gICAgaWYgKG9iamVjdFN0YXJ0IDwgMCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgbGV0IGRlcHRoID0gMDtcbiAgICBsZXQgaW5TdHJpbmcgPSBmYWxzZTtcbiAgICBsZXQgZXNjYXBlZCA9IGZhbHNlO1xuXG4gICAgZm9yIChsZXQgaSA9IG9iamVjdFN0YXJ0OyBpIDwgdGV4dC5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgY29uc3QgY2ggPSB0ZXh0W2ldO1xuXG4gICAgICBpZiAoaW5TdHJpbmcpIHtcbiAgICAgICAgaWYgKGVzY2FwZWQpIHtcbiAgICAgICAgICBlc2NhcGVkID0gZmFsc2U7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY2ggPT09IFwiXFxcXFwiKSB7XG4gICAgICAgICAgZXNjYXBlZCA9IHRydWU7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY2ggPT09ICdcIicpIHtcbiAgICAgICAgICBpblN0cmluZyA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAoY2ggPT09ICdcIicpIHtcbiAgICAgICAgaW5TdHJpbmcgPSB0cnVlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKGNoID09PSBcIntcIikge1xuICAgICAgICBkZXB0aCArPSAxO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKGNoID09PSBcIn1cIikge1xuICAgICAgICBkZXB0aCAtPSAxO1xuICAgICAgICBpZiAoZGVwdGggPT09IDApIHtcbiAgICAgICAgICByZXR1cm4gdGV4dC5zbGljZShvYmplY3RTdGFydCwgaSArIDEpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBwcml2YXRlIHNhbml0aXplVmF1bHRQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBwYXRoLnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKTtcbiAgICBpZiAoIXRyaW1tZWQpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGlmICgvXlthLXpBLVpdOi8udGVzdCh0cmltbWVkKSB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aCh0cmltbWVkKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQgfHwgbm9ybWFsaXplZCA9PT0gXCIuXCIpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IHNlZ21lbnRzID0gbm9ybWFsaXplZC5zcGxpdChcIi9cIik7XG4gICAgaWYgKHNlZ21lbnRzLnNvbWUoKHNlZ21lbnQpID0+ICFzZWdtZW50IHx8IHNlZ21lbnQgPT09IFwiLi5cIikpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIHJldHVybiBub3JtYWxpemVkO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBlbnN1cmVGb2xkZXJFeGlzdHMoZm9sZGVyUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFmb2xkZXJQYXRoKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc2VnbWVudHMgPSBmb2xkZXJQYXRoLnNwbGl0KFwiL1wiKTtcbiAgICBsZXQgY3VycmVudCA9IFwiXCI7XG5cbiAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMpIHtcbiAgICAgIGN1cnJlbnQgPSBjdXJyZW50ID8gYCR7Y3VycmVudH0vJHtzZWdtZW50fWAgOiBzZWdtZW50O1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoY3VycmVudCk7XG4gICAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgICAgaWYgKGV4aXN0aW5nIGluc3RhbmNlb2YgVEZpbGUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBjcmVhdGUgZm9sZGVyICR7Y3VycmVudH06IGEgZmlsZSBleGlzdHMgYXQgdGhpcyBwYXRoLmApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGVGb2xkZXIoY3VycmVudCk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgYXBwbHlBZ2VudEFjdGlvbnMoYWN0aW9uczogQWdlbnRBY3Rpb25bXSk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgbGV0IGNyZWF0ZWRGb2xkZXJzID0gMDtcbiAgICBsZXQgY3JlYXRlZEZpbGVzID0gMDtcbiAgICBsZXQgdXBkYXRlZEZpbGVzID0gMDtcbiAgICBsZXQgc2tpcHBlZCA9IDA7XG4gICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgZm9yIChjb25zdCBhY3Rpb24gb2YgYWN0aW9ucykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2FmZVBhdGggPSB0aGlzLnNhbml0aXplVmF1bHRQYXRoKGFjdGlvbi5wYXRoKTtcbiAgICAgICAgaWYgKCFzYWZlUGF0aCkge1xuICAgICAgICAgIHNraXBwZWQgKz0gMTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJjcmVhdGVfZm9sZGVyXCIpIHtcbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBza2lwcGVkICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZUZvbGRlckV4aXN0cyhzYWZlUGF0aCk7XG4gICAgICAgICAgY3JlYXRlZEZvbGRlcnMgKz0gMTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJjcmVhdGVfZnJvbV90ZW1wbGF0ZVwiKSB7XG4gICAgICAgICAgY29uc3QgY29udGVudCA9IHRoaXMucmVuZGVyVGVtcGxhdGUoYWN0aW9uLnRlbXBsYXRlLCBhY3Rpb24udmFyaWFibGVzID8/IHt9KTtcbiAgICAgICAgICBjb25zdCBmb2xkZXJQYXRoID0gc2FmZVBhdGguaW5jbHVkZXMoXCIvXCIpID8gc2FmZVBhdGguc2xpY2UoMCwgc2FmZVBhdGgubGFzdEluZGV4T2YoXCIvXCIpKSA6IFwiXCI7XG4gICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVGb2xkZXJFeGlzdHMoZm9sZGVyUGF0aCk7XG5cbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBpZiAoIShleGlzdGluZyBpbnN0YW5jZW9mIFRGaWxlKSkge1xuICAgICAgICAgICAgICBlcnJvcnMucHVzaChgQ2Fubm90IGNyZWF0ZSBmaWxlICR7c2FmZVBhdGh9OiBhIGZvbGRlciBleGlzdHMgYXQgdGhpcyBwYXRoLmApO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFhY3Rpb24ub3ZlcndyaXRlKSB7XG4gICAgICAgICAgICAgIHNraXBwZWQgKz0gMTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeShleGlzdGluZywgY29udGVudCk7XG4gICAgICAgICAgICB1cGRhdGVkRmlsZXMgKz0gMTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNyZWF0ZShzYWZlUGF0aCwgY29udGVudCk7XG4gICAgICAgICAgY3JlYXRlZEZpbGVzICs9IDE7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoYWN0aW9uLnR5cGUgPT09IFwiYXBwZW5kX2ZpbGVcIikge1xuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHNhZmVQYXRoKTtcbiAgICAgICAgICBpZiAoIShleGlzdGluZyBpbnN0YW5jZW9mIFRGaWxlKSkge1xuICAgICAgICAgICAgZXJyb3JzLnB1c2goYENhbm5vdCBhcHBlbmQgdG8gJHtzYWZlUGF0aH06IGZpbGUgbm90IGZvdW5kLmApO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNhY2hlZFJlYWQoZXhpc3RpbmcpO1xuICAgICAgICAgIGNvbnN0IHNlcGFyYXRvciA9IGN1cnJlbnQuZW5kc1dpdGgoXCJcXG5cIikgfHwgYWN0aW9uLmNvbnRlbnQuc3RhcnRzV2l0aChcIlxcblwiKSA/IFwiXCIgOiBcIlxcblxcblwiO1xuICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeShleGlzdGluZywgYCR7Y3VycmVudH0ke3NlcGFyYXRvcn0ke2FjdGlvbi5jb250ZW50fWApO1xuICAgICAgICAgIHVwZGF0ZWRGaWxlcyArPSAxO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcImluc2VydF9hZnRlcl9oZWFkaW5nXCIpIHtcbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XG4gICAgICAgICAgaWYgKCEoZXhpc3RpbmcgaW5zdGFuY2VvZiBURmlsZSkpIHtcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKGBDYW5ub3QgaW5zZXJ0IGluICR7c2FmZVBhdGh9OiBmaWxlIG5vdCBmb3VuZC5gKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5jYWNoZWRSZWFkKGV4aXN0aW5nKTtcbiAgICAgICAgICBjb25zdCBlc2NhcGVkSGVhZGluZyA9IGFjdGlvbi5oZWFkaW5nLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKTtcbiAgICAgICAgICBjb25zdCBoZWFkaW5nUmVnZXggPSBuZXcgUmVnRXhwKGBeJHtlc2NhcGVkSGVhZGluZ31cXFxccyokYCwgXCJtXCIpO1xuICAgICAgICAgIGNvbnN0IGhlYWRpbmdNYXRjaCA9IGhlYWRpbmdSZWdleC5leGVjKGN1cnJlbnQpO1xuXG4gICAgICAgICAgaWYgKCFoZWFkaW5nTWF0Y2gpIHtcbiAgICAgICAgICAgIGlmIChhY3Rpb24uY3JlYXRlSWZNaXNzaW5nKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGFwcGVuZGVkID0gYCR7Y3VycmVudH0ke2N1cnJlbnQuZW5kc1dpdGgoXCJcXG5cIikgPyBcIlwiIDogXCJcXG5cXG5cIn0ke2FjdGlvbi5oZWFkaW5nfVxcbiR7YWN0aW9uLmNvbnRlbnR9YDtcbiAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KGV4aXN0aW5nLCBhcHBlbmRlZCk7XG4gICAgICAgICAgICAgIHVwZGF0ZWRGaWxlcyArPSAxO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgc2tpcHBlZCArPSAxO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgaW5zZXJ0SW5kZXggPSBoZWFkaW5nTWF0Y2guaW5kZXggKyBoZWFkaW5nTWF0Y2hbMF0ubGVuZ3RoO1xuICAgICAgICAgIGNvbnN0IHVwZGF0ZWQgPSBgJHtjdXJyZW50LnNsaWNlKDAsIGluc2VydEluZGV4KX1cXG4ke2FjdGlvbi5jb250ZW50fSR7Y3VycmVudC5zbGljZShpbnNlcnRJbmRleCl9YDtcbiAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkoZXhpc3RpbmcsIHVwZGF0ZWQpO1xuICAgICAgICAgIHVwZGF0ZWRGaWxlcyArPSAxO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcInJlcGxhY2VfaW5fZmlsZVwiKSB7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoc2FmZVBhdGgpO1xuICAgICAgICAgIGlmICghKGV4aXN0aW5nIGluc3RhbmNlb2YgVEZpbGUpKSB7XG4gICAgICAgICAgICBlcnJvcnMucHVzaChgQ2Fubm90IHJlcGxhY2UgaW4gJHtzYWZlUGF0aH06IGZpbGUgbm90IGZvdW5kLmApO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNhY2hlZFJlYWQoZXhpc3RpbmcpO1xuICAgICAgICAgIGlmICghY3VycmVudC5pbmNsdWRlcyhhY3Rpb24uZmluZCkpIHtcbiAgICAgICAgICAgIHNraXBwZWQgKz0gMTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHVwZGF0ZWQgPSBhY3Rpb24ucmVwbGFjZUFsbFxuICAgICAgICAgICAgPyBjdXJyZW50LnNwbGl0KGFjdGlvbi5maW5kKS5qb2luKGFjdGlvbi5yZXBsYWNlKVxuICAgICAgICAgICAgOiBjdXJyZW50LnJlcGxhY2UoYWN0aW9uLmZpbmQsIGFjdGlvbi5yZXBsYWNlKTtcbiAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkoZXhpc3RpbmcsIHVwZGF0ZWQpO1xuICAgICAgICAgIHVwZGF0ZWRGaWxlcyArPSAxO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZm9sZGVyUGF0aCA9IHNhZmVQYXRoLmluY2x1ZGVzKFwiL1wiKSA/IHNhZmVQYXRoLnNsaWNlKDAsIHNhZmVQYXRoLmxhc3RJbmRleE9mKFwiL1wiKSkgOiBcIlwiO1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZUZvbGRlckV4aXN0cyhmb2xkZXJQYXRoKTtcblxuICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChzYWZlUGF0aCk7XG4gICAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICAgIGlmICghKGV4aXN0aW5nIGluc3RhbmNlb2YgVEZpbGUpKSB7XG4gICAgICAgICAgICBlcnJvcnMucHVzaChgQ2Fubm90IGNyZWF0ZSBmaWxlICR7c2FmZVBhdGh9OiBhIGZvbGRlciBleGlzdHMgYXQgdGhpcyBwYXRoLmApO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKCFhY3Rpb24ub3ZlcndyaXRlKSB7XG4gICAgICAgICAgICBza2lwcGVkICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkoZXhpc3RpbmcsIGFjdGlvbi5jb250ZW50KTtcbiAgICAgICAgICB1cGRhdGVkRmlsZXMgKz0gMTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNyZWF0ZShzYWZlUGF0aCwgYWN0aW9uLmNvbnRlbnQpO1xuICAgICAgICBjcmVhdGVkRmlsZXMgKz0gMTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcGFydHMgPSBbXG4gICAgICBgQWN0aW9ucyBleGVjdXRlZDogZm9sZGVycyBjcmVhdGVkICR7Y3JlYXRlZEZvbGRlcnN9LCBmaWxlcyBjcmVhdGVkICR7Y3JlYXRlZEZpbGVzfSwgZmlsZXMgdXBkYXRlZCAke3VwZGF0ZWRGaWxlc30sIHNraXBwZWQgJHtza2lwcGVkfWBcbiAgICBdO1xuICAgIGlmIChlcnJvcnMubGVuZ3RoKSB7XG4gICAgICBwYXJ0cy5wdXNoKGBFcnJvcnM6ICR7ZXJyb3JzLmpvaW4oXCIgfCBcIil9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oXCIuIFwiKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVyVGVtcGxhdGUodGVtcGxhdGU6IHN0cmluZywgdmFyaWFibGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogc3RyaW5nIHtcbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgdGVtcGxhdGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgXCJwcm9qZWN0LXBsYW5cIjogW1xuICAgICAgICBcIiMge3t0aXRsZX19XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiQ3JlYXRlZDoge3tjcmVhdGVkfX1cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBHb2FsXCIsXG4gICAgICAgIFwie3tnb2FsfX1cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBNaWxlc3RvbmVzXCIsXG4gICAgICAgIFwiLSB7e21pbGVzdG9uZTF9fVwiLFxuICAgICAgICBcIi0ge3ttaWxlc3RvbmUyfX1cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBSaXNrc1wiLFxuICAgICAgICBcIi0ge3tyaXNrMX19XCJcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgIFwibWVldGluZy1ub3RlXCI6IFtcbiAgICAgICAgXCIjIE1lZXRpbmc6IHt7dGl0bGV9fVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIkRhdGU6IHt7ZGF0ZX19XCIsXG4gICAgICAgIFwiQXR0ZW5kZWVzOiB7e2F0dGVuZGVlc319XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgQWdlbmRhXCIsXG4gICAgICAgIFwiLSBcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBOb3Rlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIEFjdGlvbiBJdGVtc1wiLFxuICAgICAgICBcIi0gWyBdIFwiXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBcIndvcmxkLWxvcmVcIjogW1xuICAgICAgICBcIiMgTG9yZToge3t0aXRsZX19XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgU3VtbWFyeVwiLFxuICAgICAgICBcInt7c3VtbWFyeX19XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgRmFjdGlvbnNcIixcbiAgICAgICAgXCItIFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFRpbWVsaW5lXCIsXG4gICAgICAgIFwiLSBcIlxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJjaGFyYWN0ZXItc2hlZXRcIjogW1xuICAgICAgICBcIiMgQ2hhcmFjdGVyOiB7e25hbWV9fVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFJvbGVcIixcbiAgICAgICAgXCJ7e3JvbGV9fVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFRyYWl0c1wiLFxuICAgICAgICBcIi0gXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgR29hbHNcIixcbiAgICAgICAgXCItIFwiXG4gICAgICBdLmpvaW4oXCJcXG5cIilcbiAgICB9O1xuXG4gICAgY29uc3QgZGVmYXVsdHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICB0aXRsZTogXCJVbnRpdGxlZFwiLFxuICAgICAgZ29hbDogXCJcIixcbiAgICAgIG1pbGVzdG9uZTE6IFwiXCIsXG4gICAgICBtaWxlc3RvbmUyOiBcIlwiLFxuICAgICAgcmlzazE6IFwiXCIsXG4gICAgICBjcmVhdGVkOiBub3csXG4gICAgICBkYXRlOiBub3cuc2xpY2UoMCwgMTApLFxuICAgICAgYXR0ZW5kZWVzOiBcIlwiLFxuICAgICAgc3VtbWFyeTogXCJcIixcbiAgICAgIG5hbWU6IFwiVW5uYW1lZFwiLFxuICAgICAgcm9sZTogXCJcIlxuICAgIH07XG5cbiAgICBjb25zdCBzb3VyY2UgPSB0ZW1wbGF0ZXNbdGVtcGxhdGVdID8/IHRlbXBsYXRlc1tcInByb2plY3QtcGxhblwiXTtcbiAgICByZXR1cm4gc291cmNlLnJlcGxhY2UoL3t7XFxzKihbYS16QS1aMC05X10rKVxccyp9fS9nLCAoX2Z1bGwsIGtleTogc3RyaW5nKSA9PiB7XG4gICAgICByZXR1cm4gdmFyaWFibGVzW2tleV0gPz8gZGVmYXVsdHNba2V5XSA/PyBcIlwiO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB3cml0ZUFuc3dlck5vdGUoXG4gICAgcXVlc3Rpb246IHN0cmluZyxcbiAgICBhbnN3ZXI6IHN0cmluZyxcbiAgICBjaHVua3M6IE5vdGVDaHVua1tdXG4gICk6IFByb21pc2U8VEZpbGU+IHtcbiAgICBjb25zdCBmb2xkZXIgPSB0aGlzLnNldHRpbmdzLmFuc3dlckZvbGRlci50cmltKCk7XG4gICAgaWYgKGZvbGRlciAmJiAhdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGZvbGRlcikpIHtcbiAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNyZWF0ZUZvbGRlcihmb2xkZXIpO1xuICAgIH1cblxuICAgIGNvbnN0IHRpbWVzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKTtcbiAgICBjb25zdCBiYXNlTmFtZSA9IGBSQUcgQW5zd2VyICR7dGltZXN0YW1wfS5tZGA7XG4gICAgY29uc3QgZmlsZVBhdGggPSBmb2xkZXIgPyBgJHtmb2xkZXJ9LyR7YmFzZU5hbWV9YCA6IGJhc2VOYW1lO1xuXG4gICAgY29uc3Qgc291cmNlTGlzdCA9IGNodW5rcy5sZW5ndGhcbiAgICAgID8gY2h1bmtzLm1hcCgoY2h1bmssIGlkeCkgPT4gYC0gWyR7aWR4ICsgMX1dICR7Y2h1bmsuZmlsZVBhdGh9YCkuam9pbihcIlxcblwiKVxuICAgICAgOiBcIi0gTm8gcmVsZXZhbnQgc291cmNlcyBmb3VuZC5cIjtcblxuICAgIGNvbnN0IG5vdGUgPSBbXG4gICAgICBgIyBSQUcgQW5zd2VyYCxcbiAgICAgIFwiXCIsXG4gICAgICBgIyMgUXVlc3Rpb25gLFxuICAgICAgcXVlc3Rpb24sXG4gICAgICBcIlwiLFxuICAgICAgYCMjIEFuc3dlcmAsXG4gICAgICBhbnN3ZXIsXG4gICAgICBcIlwiLFxuICAgICAgYCMjIFNvdXJjZXNgLFxuICAgICAgc291cmNlTGlzdFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIHJldHVybiB0aGlzLmFwcC52YXVsdC5jcmVhdGUoZmlsZVBhdGgsIG5vdGUpO1xuICB9XG5cbiAgZ2V0UmVmZXJlbmNlZEZpbGVzKGFuc3dlcjogc3RyaW5nLCBjaHVua3M6IE5vdGVDaHVua1tdKTogVEZpbGVbXSB7XG4gICAgY29uc3QgcmVmZXJlbmNlZFBhdGhzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgICBmb3IgKGNvbnN0IGNodW5rIG9mIGNodW5rcykge1xuICAgICAgcmVmZXJlbmNlZFBhdGhzLmFkZChjaHVuay5maWxlUGF0aCk7XG4gICAgfVxuXG4gICAgY29uc3QgbWRQYXRoUmVnZXggPSAvKF58W1xccyhcXFtcIiddKSgoPzpbXlxccylcXF1cIiddK1xcLykqW15cXHMpXFxdXCInXStcXC5tZCkoJHxbXFxzKVxcXVwiJy4sOzohP10pL2dpO1xuICAgIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgICB3aGlsZSAoKG1hdGNoID0gbWRQYXRoUmVnZXguZXhlYyhhbnN3ZXIpKSAhPT0gbnVsbCkge1xuICAgICAgY29uc3QgY2FuZGlkYXRlID0gbWF0Y2hbMl0ucmVwbGFjZSgvXlxcLysvLCBcIlwiKTtcbiAgICAgIGlmIChjYW5kaWRhdGUpIHtcbiAgICAgICAgcmVmZXJlbmNlZFBhdGhzLmFkZChjYW5kaWRhdGUpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGZpbGVzOiBURmlsZVtdID0gW107XG4gICAgZm9yIChjb25zdCBwYXRoIG9mIHJlZmVyZW5jZWRQYXRocykge1xuICAgICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcbiAgICAgIGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHtcbiAgICAgICAgZmlsZXMucHVzaChmaWxlKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmaWxlcy5zb3J0KChhLCBiKSA9PiBhLnBhdGgubG9jYWxlQ29tcGFyZShiLnBhdGgpKTtcbiAgICByZXR1cm4gZmlsZXM7XG4gIH1cblxuICBnZXRDaXRhdGlvbkxpbmtzKGFuc3dlcjogc3RyaW5nLCBjaHVua3M6IE5vdGVDaHVua1tdKTogQ2l0YXRpb25MaW5rW10ge1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICBjb25zdCBjaXRhdGlvbnM6IENpdGF0aW9uTGlua1tdID0gW107XG4gICAgY29uc3QgY2l0YXRpb25SZWdleCA9IC9cXFsoXFxkKylcXF0vZztcbiAgICBsZXQgbWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG5cbiAgICB3aGlsZSAoKG1hdGNoID0gY2l0YXRpb25SZWdleC5leGVjKGFuc3dlcikpICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBudW1iZXIgPSBOdW1iZXIucGFyc2VJbnQobWF0Y2hbMV0sIDEwKTtcbiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG51bWJlcikgfHwgbnVtYmVyIDwgMSB8fCBzZWVuLmhhcyhudW1iZXIpKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBjaHVuayA9IGNodW5rc1tudW1iZXIgLSAxXTtcbiAgICAgIGlmICghY2h1bmspIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoY2h1bmsuZmlsZVBhdGgpO1xuICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkge1xuICAgICAgICBzZWVuLmFkZChudW1iZXIpO1xuICAgICAgICBjaXRhdGlvbnMucHVzaCh7IG51bWJlciwgZmlsZSB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gY2l0YXRpb25zO1xuICB9XG5cbiAgcmVzb2x2ZU9ic2lkaWFuVXJpVG9QYXRoKHVyaVRleHQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IHRyaW1tZWQgPSB1cmlUZXh0LnRyaW0oKTtcbiAgICBpZiAoIXRyaW1tZWQudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKFwib2JzaWRpYW46Ly9vcGVuP1wiKSkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgbGV0IHBhcnNlZDogVVJMO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBuZXcgVVJMKHRyaW1tZWQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgdmF1bHROYW1lID0gcGFyc2VkLnNlYXJjaFBhcmFtcy5nZXQoXCJ2YXVsdFwiKSA/PyBcIlwiO1xuICAgIGNvbnN0IGN1cnJlbnRWYXVsdCA9IHRoaXMuYXBwLnZhdWx0LmdldE5hbWUoKTtcbiAgICBpZiAodmF1bHROYW1lICYmIHZhdWx0TmFtZSAhPT0gY3VycmVudFZhdWx0KSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBmaWxlUGFyYW0gPSBwYXJzZWQuc2VhcmNoUGFyYW1zLmdldChcImZpbGVcIik7XG4gICAgaWYgKCFmaWxlUGFyYW0pIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IGRlY29kZWQgPSBkZWNvZGVVUklDb21wb25lbnQoZmlsZVBhcmFtKS5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKS50cmltKCk7XG4gICAgY29uc3Qgc2FmZSA9IHRoaXMuc2FuaXRpemVWYXVsdFBhdGgoZGVjb2RlZCk7XG4gICAgcmV0dXJuIHNhZmU7XG4gIH1cblxuICByZXNvbHZlT2JzaWRpYW5VcmlUb0ZpbGUodXJpVGV4dDogc3RyaW5nKTogVEZpbGUgfCBudWxsIHtcbiAgICBjb25zdCBzYWZlUGF0aCA9IHRoaXMucmVzb2x2ZU9ic2lkaWFuVXJpVG9QYXRoKHVyaVRleHQpO1xuICAgIGlmICghc2FmZVBhdGgpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoc2FmZVBhdGgpO1xuICAgIHJldHVybiBmaWxlIGluc3RhbmNlb2YgVEZpbGUgPyBmaWxlIDogbnVsbDtcbiAgfVxuXG4gIGFzeW5jIHNhdmVDaGF0QXNOb3RlKGNoYXRUaXRsZTogc3RyaW5nLCBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSk6IFByb21pc2U8VEZpbGU+IHtcbiAgICBpZiAoIW1lc3NhZ2VzLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gY2hhdCBtZXNzYWdlcyB0byBzYXZlIHlldC5cIik7XG4gICAgfVxuXG4gICAgY29uc3Qgcm9vdEZvbGRlciA9IHRoaXMuc2V0dGluZ3MuYW5zd2VyRm9sZGVyLnRyaW0oKTtcbiAgICBjb25zdCBjaGF0Rm9sZGVyID0gcm9vdEZvbGRlciA/IGAke3Jvb3RGb2xkZXJ9L1JBRyBDaGF0c2AgOiBcIlJBRyBDaGF0c1wiO1xuICAgIGF3YWl0IHRoaXMuZW5zdXJlRm9sZGVyRXhpc3RzKGNoYXRGb2xkZXIpO1xuXG4gICAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpO1xuICAgIGNvbnN0IHNhZmVUaXRsZSA9IChjaGF0VGl0bGUgfHwgXCJWYXVsdCBDaGF0XCIpXG4gICAgICAucmVwbGFjZSgvW1xcXFwvOio/XCI8PnxdL2csIFwiLVwiKVxuICAgICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgICAudHJpbSgpO1xuICAgIGNvbnN0IGZpbGVOYW1lID0gYCR7c2FmZVRpdGxlfSAke3RpbWVzdGFtcH0ubWRgO1xuICAgIGNvbnN0IGZpbGVQYXRoID0gYCR7Y2hhdEZvbGRlcn0vJHtmaWxlTmFtZX1gO1xuXG4gICAgY29uc3QgdHJhbnNjcmlwdCA9IG1lc3NhZ2VzXG4gICAgICAubWFwKChtc2csIGluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IHJvbGUgPSBtc2cucm9sZSA9PT0gXCJ1c2VyXCIgPyBcIlVzZXJcIiA6IFwiQXNzaXN0YW50XCI7XG4gICAgICAgIHJldHVybiBbYCMjIyAke2luZGV4ICsgMX0uICR7cm9sZX1gLCBcIlwiLCBtc2cuY29udGVudC50cmltKCldLmpvaW4oXCJcXG5cIik7XG4gICAgICB9KVxuICAgICAgLmpvaW4oXCJcXG5cXG5cIik7XG5cbiAgICBjb25zdCBjb250ZW50ID0gW1xuICAgICAgYCMgJHtzYWZlVGl0bGV9YCxcbiAgICAgIFwiXCIsXG4gICAgICBgQ3JlYXRlZDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCxcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRyYW5zY3JpcHRcIixcbiAgICAgIFwiXCIsXG4gICAgICB0cmFuc2NyaXB0XG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgcmV0dXJuIHRoaXMuYXBwLnZhdWx0LmNyZWF0ZShmaWxlUGF0aCwgY29udGVudCk7XG4gIH1cbn1cblxuY2xhc3MgUmFnQ2hhdFNpZGViYXJWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICBwcml2YXRlIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbjtcbiAgcHJpdmF0ZSBtb2RlOiBcInZhdWx0XCIgfCBcIm5vdGVcIiA9IFwidmF1bHRcIjtcbiAgcHJpdmF0ZSBub3RlUGF0aCA9IFwiXCI7XG4gIHByaXZhdGUgbWVzc2FnZXM6IENoYXRNZXNzYWdlW10gPSBbXTtcbiAgcHJpdmF0ZSBwaW5uZWRNZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSA9IFtdO1xuICBwcml2YXRlIGtlZXBUdXJucyA9IDg7XG4gIHByaXZhdGUgc3VtbWFyaXplT2xkVHVybnMgPSB0cnVlO1xuICBwcml2YXRlIGNvbnZlcnNhdGlvblN1bW1hcnkgPSBcIlwiO1xuICBwcml2YXRlIHBlbmRpbmdBY3Rpb25zOiBBZ2VudEFjdGlvbltdID0gW107XG4gIHByaXZhdGUgdHJhbnNjcmlwdEVsITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgaW5wdXRFbCE6IEhUTUxUZXh0QXJlYUVsZW1lbnQ7XG4gIHByaXZhdGUgc2VuZEJ1dHRvbkVsITogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIHByaXZhdGUgc2F2ZUJ1dHRvbkVsITogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIHByaXZhdGUgaXNEcmFnZ2luZ1VyaSA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbikge1xuICAgIHN1cGVyKGxlYWYpO1xuICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICB9XG5cbiAgZ2V0Vmlld1R5cGUoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gUkFHX0NIQVRfVklFV19UWVBFO1xuICB9XG5cbiAgZ2V0RGlzcGxheVRleHQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gXCJSQUcgQ2hhdFwiO1xuICB9XG5cbiAgZ2V0SWNvbigpOiBzdHJpbmcge1xuICAgIHJldHVybiBcIm1lc3NhZ2Utc3F1YXJlXCI7XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc3RhdGUgPSB0aGlzLmxlYWYuZ2V0Vmlld1N0YXRlKCkuc3RhdGUgYXMgeyBtb2RlPzogXCJ2YXVsdFwiIHwgXCJub3RlXCI7IG5vdGVQYXRoPzogc3RyaW5nIH07XG4gICAgdGhpcy5tb2RlID0gc3RhdGU/Lm1vZGUgPT09IFwibm90ZVwiID8gXCJub3RlXCIgOiBcInZhdWx0XCI7XG4gICAgdGhpcy5ub3RlUGF0aCA9IHR5cGVvZiBzdGF0ZT8ubm90ZVBhdGggPT09IFwic3RyaW5nXCIgPyBzdGF0ZS5ub3RlUGF0aCA6IFwiXCI7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIGFzeW5jIG9uQ2xvc2UoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5jb250ZW50RWwuZW1wdHkoKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVyKCk6IHZvaWQge1xuICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xuICAgIGNvbnRlbnRFbC5hZGRDbGFzcyhcInJhZy1vcGVucm91dGVyLWNoYXQtc2lkZWJhclwiKTtcblxuICAgIGNvbnN0IGhlYWRlciA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLWhlYWRlclwiIH0pO1xuICAgIGhlYWRlci5jcmVhdGVFbChcImgzXCIsIHsgdGV4dDogdGhpcy5tb2RlID09PSBcInZhdWx0XCIgPyBcIlZhdWx0IEFnZW50IENoYXRcIiA6IFwiTm90ZSBDaGF0XCIgfSk7XG5cbiAgICBjb25zdCBtb2RlQWN0aW9ucyA9IGhlYWRlci5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLW1vZGUtYWN0aW9uc1wiIH0pO1xuICAgIGNvbnN0IHZhdWx0QnV0dG9uID0gbW9kZUFjdGlvbnMuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIlZhdWx0XCIgfSk7XG4gICAgY29uc3Qgbm90ZUJ1dHRvbiA9IG1vZGVBY3Rpb25zLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHsgdGV4dDogXCJDdXJyZW50IG5vdGVcIiB9KTtcblxuICAgIGlmICh0aGlzLm1vZGUgPT09IFwidmF1bHRcIikge1xuICAgICAgdmF1bHRCdXR0b24uYWRkQ2xhc3MoXCJtb2QtY3RhXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBub3RlQnV0dG9uLmFkZENsYXNzKFwibW9kLWN0YVwiKTtcbiAgICB9XG5cbiAgICB2YXVsdEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5zd2l0Y2hNb2RlKFwidmF1bHRcIik7XG4gICAgfSk7XG5cbiAgICBub3RlQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICAgIGlmICghYWN0aXZlRmlsZSB8fCBhY3RpdmVGaWxlLmV4dGVuc2lvbiAhPT0gXCJtZFwiKSB7XG4gICAgICAgIG5ldyBOb3RpY2UoXCJPcGVuIGEgbWFya2Rvd24gbm90ZSBmaXJzdC5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgYXdhaXQgdGhpcy5zd2l0Y2hNb2RlKFwibm90ZVwiLCBhY3RpdmVGaWxlLnBhdGgpO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NvcGVUZXh0ID1cbiAgICAgIHRoaXMubW9kZSA9PT0gXCJ2YXVsdFwiXG4gICAgICAgID8gXCJTY29wZTogRW50aXJlIHZhdWx0LlwiXG4gICAgICAgIDogdGhpcy5ub3RlUGF0aFxuICAgICAgICAgID8gYFNjb3BlOiAke3RoaXMubm90ZVBhdGh9YFxuICAgICAgICAgIDogXCJTY29wZTogQ3VycmVudCBtYXJrZG93biBub3RlLlwiO1xuXG4gICAgY29udGVudEVsLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW5vdGUtcGF0aFwiLFxuICAgICAgdGV4dDogc2NvcGVUZXh0XG4gICAgfSk7XG5cbiAgICBjb25zdCBtZW1vcnlDb250cm9scyA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLW1lbW9yeS1jb250cm9sc1wiIH0pO1xuICAgIG1lbW9yeUNvbnRyb2xzLmNyZWF0ZURpdih7IHRleHQ6IFwiS2VlcCB0dXJuc1wiIH0pO1xuICAgIGNvbnN0IGtlZXBUdXJuc0lucHV0ID0gbWVtb3J5Q29udHJvbHMuY3JlYXRlRWwoXCJpbnB1dFwiLCB7XG4gICAgICB0eXBlOiBcIm51bWJlclwiLFxuICAgICAgdmFsdWU6IFN0cmluZyh0aGlzLmtlZXBUdXJucylcbiAgICB9KTtcbiAgICBrZWVwVHVybnNJbnB1dC5taW4gPSBcIjJcIjtcbiAgICBrZWVwVHVybnNJbnB1dC5tYXggPSBcIjMwXCI7XG4gICAga2VlcFR1cm5zSW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIucGFyc2VJbnQoa2VlcFR1cm5zSW5wdXQudmFsdWUsIDEwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSkge1xuICAgICAgICB0aGlzLmtlZXBUdXJucyA9IE1hdGgubWF4KDIsIE1hdGgubWluKDMwLCBwYXJzZWQpKTtcbiAgICAgIH1cbiAgICAgIGtlZXBUdXJuc0lucHV0LnZhbHVlID0gU3RyaW5nKHRoaXMua2VlcFR1cm5zKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IHN1bW1hcml6ZVRvZ2dsZVdyYXAgPSBtZW1vcnlDb250cm9scy5jcmVhdGVFbChcImxhYmVsXCIsIHtcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1jaGF0LXNpZGViYXItbWVtb3J5LXRvZ2dsZVwiXG4gICAgfSk7XG4gICAgY29uc3Qgc3VtbWFyaXplVG9nZ2xlID0gc3VtbWFyaXplVG9nZ2xlV3JhcC5jcmVhdGVFbChcImlucHV0XCIsIHsgdHlwZTogXCJjaGVja2JveFwiIH0pO1xuICAgIHN1bW1hcml6ZVRvZ2dsZS5jaGVja2VkID0gdGhpcy5zdW1tYXJpemVPbGRUdXJucztcbiAgICBzdW1tYXJpemVUb2dnbGVXcmFwLmFwcGVuZFRleHQoXCJzdW1tYXJpemUgb2xkXCIpO1xuICAgIHN1bW1hcml6ZVRvZ2dsZS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIHRoaXMuc3VtbWFyaXplT2xkVHVybnMgPSBzdW1tYXJpemVUb2dnbGUuY2hlY2tlZDtcbiAgICB9KTtcblxuICAgIGNvbnN0IHBpbkxhc3RCdXR0b24gPSBtZW1vcnlDb250cm9scy5jcmVhdGVFbChcImJ1dHRvblwiLCB7IHRleHQ6IFwiUGluIGxhc3RcIiB9KTtcbiAgICBwaW5MYXN0QnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICB0aGlzLnBpbkxhc3RNZXNzYWdlKCk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBjbGVhclBpbnNCdXR0b24gPSBtZW1vcnlDb250cm9scy5jcmVhdGVFbChcImJ1dHRvblwiLCB7IHRleHQ6IFwiQ2xlYXIgcGluc1wiIH0pO1xuICAgIGNsZWFyUGluc0J1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgdGhpcy5waW5uZWRNZXNzYWdlcyA9IFtdO1xuICAgICAgbmV3IE5vdGljZShcIlBpbm5lZCBtZXNzYWdlcyBjbGVhcmVkLlwiKTtcbiAgICB9KTtcblxuICAgIG1lbW9yeUNvbnRyb2xzLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItY2hhdC1zaWRlYmFyLW1lbW9yeS1jb3VudFwiLFxuICAgICAgdGV4dDogYFBpbnM6ICR7dGhpcy5waW5uZWRNZXNzYWdlcy5sZW5ndGh9YFxuICAgIH0pO1xuXG4gICAgdGhpcy50cmFuc2NyaXB0RWwgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC10cmFuc2NyaXB0XCIgfSk7XG5cbiAgICBjb25zdCBpbnB1dFdyYXAgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1pbnB1dC13cmFwXCIgfSk7XG4gICAgdGhpcy5pbnB1dEVsID0gaW5wdXRXcmFwLmNyZWF0ZUVsKFwidGV4dGFyZWFcIiwge1xuICAgICAgYXR0cjoge1xuICAgICAgICBwbGFjZWhvbGRlcjpcbiAgICAgICAgICB0aGlzLm1vZGUgPT09IFwidmF1bHRcIlxuICAgICAgICAgICAgPyBcIkFzayBhYm91dCB5b3VyIHZhdWx0IG9yIHJlcXVlc3QgZmlsZS9mb2xkZXIgY3JlYXRpb24uLi5cIlxuICAgICAgICAgICAgOiBcIkFzayBhYm91dCB0aGlzIG5vdGUuLi5cIlxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5zZW5kQnV0dG9uRWwgPSBpbnB1dFdyYXAuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIlNlbmRcIiB9KTtcbiAgICB0aGlzLnNhdmVCdXR0b25FbCA9IGlucHV0V3JhcC5jcmVhdGVFbChcImJ1dHRvblwiLCB7IHRleHQ6IFwiU2F2ZSBDaGF0XCIgfSk7XG5cbiAgICB0aGlzLnNlbmRCdXR0b25FbC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5zZW5kTWVzc2FnZSgpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5zYXZlQnV0dG9uRWwuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMuc2F2ZUNoYXQoKTtcbiAgICB9KTtcblxuICAgIHRoaXMuaW5wdXRFbC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmIChldmVudC5rZXkgPT09IFwiRW50ZXJcIiAmJiAhZXZlbnQuc2hpZnRLZXkpIHtcbiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZW5kTWVzc2FnZSgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5pbnB1dEVsLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnb3ZlclwiLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghZXZlbnQuZGF0YVRyYW5zZmVyKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaGFzVGV4dCA9IEFycmF5LmZyb20oZXZlbnQuZGF0YVRyYW5zZmVyLnR5cGVzKS5zb21lKCh0eXBlKSA9PlxuICAgICAgICB0eXBlID09PSBcInRleHQvcGxhaW5cIiB8fCB0eXBlID09PSBcInRleHQvdXJpLWxpc3RcIlxuICAgICAgKTtcbiAgICAgIGlmICghaGFzVGV4dCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBldmVudC5kYXRhVHJhbnNmZXIuZHJvcEVmZmVjdCA9IFwiY29weVwiO1xuICAgICAgaWYgKCF0aGlzLmlzRHJhZ2dpbmdVcmkpIHtcbiAgICAgICAgdGhpcy5pc0RyYWdnaW5nVXJpID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5pbnB1dEVsLmFkZENsYXNzKFwiaXMtZHJhZy1vdmVyXCIpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5pbnB1dEVsLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnbGVhdmVcIiwgKCkgPT4ge1xuICAgICAgdGhpcy5pc0RyYWdnaW5nVXJpID0gZmFsc2U7XG4gICAgICB0aGlzLmlucHV0RWwucmVtb3ZlQ2xhc3MoXCJpcy1kcmFnLW92ZXJcIik7XG4gICAgfSk7XG5cbiAgICB0aGlzLmlucHV0RWwuYWRkRXZlbnRMaXN0ZW5lcihcImRyb3BcIiwgKGV2ZW50KSA9PiB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgdGhpcy5pc0RyYWdnaW5nVXJpID0gZmFsc2U7XG4gICAgICB0aGlzLmlucHV0RWwucmVtb3ZlQ2xhc3MoXCJpcy1kcmFnLW92ZXJcIik7XG5cbiAgICAgIGNvbnN0IGR0ID0gZXZlbnQuZGF0YVRyYW5zZmVyO1xuICAgICAgaWYgKCFkdCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHVyaUxpc3QgPSBkdC5nZXREYXRhKFwidGV4dC91cmktbGlzdFwiKSB8fCBcIlwiO1xuICAgICAgY29uc3QgcGxhaW5UZXh0ID0gZHQuZ2V0RGF0YShcInRleHQvcGxhaW5cIikgfHwgXCJcIjtcbiAgICAgIGNvbnN0IG1lcmdlZCA9IGAke3VyaUxpc3R9XFxuJHtwbGFpblRleHR9YC50cmltKCk7XG4gICAgICBpZiAoIW1lcmdlZCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGxpbmVzID0gbWVyZ2VkXG4gICAgICAgIC5zcGxpdCgvXFxyP1xcbi8pXG4gICAgICAgIC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuICAgICAgICAuZmlsdGVyKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG4gICAgICBjb25zdCByZWZlcmVuY2VzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLnBsdWdpbi5yZXNvbHZlT2JzaWRpYW5VcmlUb0ZpbGUobGluZSk7XG4gICAgICAgIGlmIChmaWxlKSB7XG4gICAgICAgICAgcmVmZXJlbmNlcy5wdXNoKGBbWyR7ZmlsZS5wYXRofV1dYCk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzYWZlUGF0aCA9IHRoaXMucGx1Z2luLnJlc29sdmVPYnNpZGlhblVyaVRvUGF0aChsaW5lKTtcbiAgICAgICAgaWYgKHNhZmVQYXRoKSB7XG4gICAgICAgICAgcmVmZXJlbmNlcy5wdXNoKGBbWyR7c2FmZVBhdGh9XV1gKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChsaW5lLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoXCIubWRcIikpIHtcbiAgICAgICAgICByZWZlcmVuY2VzLnB1c2goYFtbJHtsaW5lfV1dYCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKCFyZWZlcmVuY2VzLmxlbmd0aCkge1xuICAgICAgICBuZXcgTm90aWNlKFwiRHJvcHBlZCBpdGVtIGRpZCBub3QgY29udGFpbiBhIHN1cHBvcnRlZCBPYnNpZGlhbiBub3RlIGxpbmsuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHByZWZpeCA9IHRoaXMuaW5wdXRFbC52YWx1ZS50cmltKCkgPyBcIlxcblwiIDogXCJcIjtcbiAgICAgIHRoaXMuaW5wdXRFbC52YWx1ZSA9IGAke3RoaXMuaW5wdXRFbC52YWx1ZX0ke3ByZWZpeH0ke3JlZmVyZW5jZXMuam9pbihcIlxcblwiKX1gO1xuICAgICAgdGhpcy5pbnB1dEVsLmZvY3VzKCk7XG4gICAgICBuZXcgTm90aWNlKGBBZGRlZCAke3JlZmVyZW5jZXMubGVuZ3RofSBub3RlIHJlZmVyZW5jZShzKSBmcm9tIGRyb3AuYCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLmlucHV0RWwuZm9jdXMoKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc3dpdGNoTW9kZShtb2RlOiBcInZhdWx0XCIgfCBcIm5vdGVcIiwgbm90ZVBhdGggPSBcIlwiKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5tb2RlID0gbW9kZTtcbiAgICB0aGlzLm5vdGVQYXRoID0gbm90ZVBhdGg7XG4gICAgdGhpcy5tZXNzYWdlcyA9IFtdO1xuICAgIHRoaXMucGVuZGluZ0FjdGlvbnMgPSBbXTtcblxuICAgIGNvbnN0IGN1cnJlbnRTdGF0ZSA9IHRoaXMubGVhZi5nZXRWaWV3U3RhdGUoKTtcbiAgICBhd2FpdCB0aGlzLmxlYWYuc2V0Vmlld1N0YXRlKHtcbiAgICAgIC4uLmN1cnJlbnRTdGF0ZSxcbiAgICAgIHN0YXRlOiB7XG4gICAgICAgIG1vZGU6IHRoaXMubW9kZSxcbiAgICAgICAgbm90ZVBhdGg6IHRoaXMubm90ZVBhdGhcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHRoaXMucmVuZGVyKCk7XG4gIH1cblxuICBwcml2YXRlIHBpbkxhc3RNZXNzYWdlKCk6IHZvaWQge1xuICAgIGNvbnN0IGxhc3QgPSBbLi4udGhpcy5tZXNzYWdlc10ucmV2ZXJzZSgpLmZpbmQoKG1zZykgPT4gbXNnLnJvbGUgPT09IFwidXNlclwiIHx8IG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiKTtcbiAgICBpZiAoIWxhc3QpIHtcbiAgICAgIG5ldyBOb3RpY2UoXCJObyBtZXNzYWdlIHRvIHBpbiB5ZXQuXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMucGlubmVkTWVzc2FnZXMucHVzaCh7IHJvbGU6IGxhc3Qucm9sZSwgY29udGVudDogbGFzdC5jb250ZW50IH0pO1xuICAgIG5ldyBOb3RpY2UoXCJQaW5uZWQgbGFzdCBtZXNzYWdlIGZvciBtZW1vcnkuXCIpO1xuICAgIHRoaXMucmVuZGVyKCk7XG4gIH1cblxuICBwcml2YXRlIGdldEhpc3RvcnlGb3JNb2RlbChoaXN0b3J5QmVmb3JlVHVybjogQ2hhdE1lc3NhZ2VbXSk6IENoYXRNZXNzYWdlW10ge1xuICAgIGNvbnN0IGtlZXBDb3VudCA9IE1hdGgubWF4KDIsIHRoaXMua2VlcFR1cm5zKSAqIDI7XG4gICAgaWYgKCF0aGlzLnN1bW1hcml6ZU9sZFR1cm5zIHx8IGhpc3RvcnlCZWZvcmVUdXJuLmxlbmd0aCA8PSBrZWVwQ291bnQpIHtcbiAgICAgIHJldHVybiBbLi4udGhpcy5waW5uZWRNZXNzYWdlcywgLi4uaGlzdG9yeUJlZm9yZVR1cm4uc2xpY2UoLWtlZXBDb3VudCldO1xuICAgIH1cblxuICAgIHJldHVybiBbLi4udGhpcy5waW5uZWRNZXNzYWdlcywgLi4uaGlzdG9yeUJlZm9yZVR1cm4uc2xpY2UoLWtlZXBDb3VudCldO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBtYXliZVN1bW1hcml6ZUhpc3RvcnkoaGlzdG9yeUJlZm9yZVR1cm46IENoYXRNZXNzYWdlW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBrZWVwQ291bnQgPSBNYXRoLm1heCgyLCB0aGlzLmtlZXBUdXJucykgKiAyO1xuICAgIGlmICghdGhpcy5zdW1tYXJpemVPbGRUdXJucyB8fCBoaXN0b3J5QmVmb3JlVHVybi5sZW5ndGggPD0ga2VlcENvdW50KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgb2xkZXIgPSBoaXN0b3J5QmVmb3JlVHVybi5zbGljZSgwLCAta2VlcENvdW50KTtcbiAgICBpZiAoIW9sZGVyLmxlbmd0aCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHN1bW1hcnkgPSBhd2FpdCB0aGlzLnBsdWdpbi5zdW1tYXJpemVDaGF0TWVzc2FnZXMob2xkZXIpO1xuICAgIGlmICghc3VtbWFyeSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuY29udmVyc2F0aW9uU3VtbWFyeSA9IHRoaXMuY29udmVyc2F0aW9uU3VtbWFyeVxuICAgICAgPyBgJHt0aGlzLmNvbnZlcnNhdGlvblN1bW1hcnl9XFxuLSAke3N1bW1hcnl9YFxuICAgICAgOiBzdW1tYXJ5O1xuICB9XG5cbiAgcHJpdmF0ZSByZW5kZXJDaXRhdGlvbkxpbmtzKHBhcmVudDogSFRNTEVsZW1lbnQsIGFuc3dlcjogc3RyaW5nLCBjaHVua3M6IE5vdGVDaHVua1tdKTogdm9pZCB7XG4gICAgaWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLmNpdGF0aW9uU3R5bGUgIT09IFwiZm9vdGVyXCIpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBjaXRhdGlvbnMgPSB0aGlzLnBsdWdpbi5nZXRDaXRhdGlvbkxpbmtzKGFuc3dlciwgY2h1bmtzKTtcbiAgICBpZiAoIWNpdGF0aW9ucy5sZW5ndGgpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB3cmFwID0gcGFyZW50LmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rc1wiIH0pO1xuICAgIHdyYXAuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy10aXRsZVwiLFxuICAgICAgdGV4dDogXCJDaXRhdGlvbnNcIlxuICAgIH0pO1xuICAgIGNvbnN0IGxpc3QgPSB3cmFwLmNyZWF0ZUVsKFwidWxcIiwgeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtbGlua3MtbGlzdFwiIH0pO1xuICAgIGZvciAoY29uc3QgY2l0YXRpb24gb2YgY2l0YXRpb25zKSB7XG4gICAgICBjb25zdCBsaSA9IGxpc3QuY3JlYXRlRWwoXCJsaVwiKTtcbiAgICAgIGNvbnN0IGxpbmsgPSBsaS5jcmVhdGVFbChcImFcIiwgeyB0ZXh0OiBgWyR7Y2l0YXRpb24ubnVtYmVyfV0gJHtjaXRhdGlvbi5maWxlLnBhdGh9YCwgaHJlZjogXCIjXCIgfSk7XG4gICAgICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYodHJ1ZSkub3BlbkZpbGUoY2l0YXRpb24uZmlsZSk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJlbmRlclJlZmVyZW5jZWRGaWxlcyhwYXJlbnQ6IEhUTUxFbGVtZW50LCBhbnN3ZXI6IHN0cmluZywgY2h1bmtzOiBOb3RlQ2h1bmtbXSk6IHZvaWQge1xuICAgIGNvbnN0IHJlZmVyZW5jZWRGaWxlcyA9IHRoaXMucGx1Z2luLmdldFJlZmVyZW5jZWRGaWxlcyhhbnN3ZXIsIGNodW5rcyk7XG4gICAgaWYgKCFyZWZlcmVuY2VkRmlsZXMubGVuZ3RoKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcmVmc1dyYXAgPSBwYXJlbnQuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLWxpbmtzXCIgfSk7XG4gICAgcmVmc1dyYXAuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy10aXRsZVwiLFxuICAgICAgdGV4dDogXCJSZWZlcmVuY2VkIGZpbGVzXCJcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlZnNMaXN0ID0gcmVmc1dyYXAuY3JlYXRlRWwoXCJ1bFwiLCB7IGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy1saXN0XCIgfSk7XG4gICAgZm9yIChjb25zdCBmaWxlIG9mIHJlZmVyZW5jZWRGaWxlcykge1xuICAgICAgY29uc3QgbGkgPSByZWZzTGlzdC5jcmVhdGVFbChcImxpXCIpO1xuICAgICAgY29uc3QgbGluayA9IGxpLmNyZWF0ZUVsKFwiYVwiLCB7IHRleHQ6IGZpbGUucGF0aCwgaHJlZjogXCIjXCIgfSk7XG4gICAgICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYodHJ1ZSkub3BlbkZpbGUoZmlsZSk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJlbmRlclBlbmRpbmdBY3Rpb25zKHBhcmVudDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucGVuZGluZ0FjdGlvbnMubGVuZ3RoKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcGFuZWwgPSBwYXJlbnQuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLWFjdGlvbi1hcHByb3ZhbFwiIH0pO1xuICAgIHBhbmVsLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtbGlua3MtdGl0bGVcIixcbiAgICAgIHRleHQ6IGBQbGFubmVkIGFjdGlvbnMgKCR7dGhpcy5wZW5kaW5nQWN0aW9ucy5sZW5ndGh9KWBcbiAgICB9KTtcblxuICAgIGNvbnN0IGxpc3QgPSBwYW5lbC5jcmVhdGVFbChcInVsXCIsIHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLWxpbmtzLWxpc3RcIiB9KTtcbiAgICBmb3IgKGNvbnN0IGFjdGlvbiBvZiB0aGlzLnBlbmRpbmdBY3Rpb25zKSB7XG4gICAgICBjb25zdCBsaSA9IGxpc3QuY3JlYXRlRWwoXCJsaVwiKTtcbiAgICAgIGxpLnNldFRleHQodGhpcy5kZXNjcmliZUFjdGlvbihhY3Rpb24pKTtcbiAgICB9XG5cbiAgICBjb25zdCBidXR0b25zID0gcGFuZWwuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLWFjdGlvbi1hcHByb3ZhbC1idXR0b25zXCIgfSk7XG4gICAgY29uc3QgYXBwcm92ZUJ1dHRvbiA9IGJ1dHRvbnMuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIkFwcHJvdmUgYWN0aW9uc1wiIH0pO1xuICAgIGNvbnN0IGRpc2NhcmRCdXR0b24gPSBidXR0b25zLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHsgdGV4dDogXCJEaXNjYXJkXCIgfSk7XG5cbiAgICBhcHByb3ZlQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBhcHByb3ZlQnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgZGlzY2FyZEJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIGNvbnN0IHN1bW1hcnkgPSBhd2FpdCB0aGlzLnBsdWdpbi5hcHBseUFnZW50QWN0aW9ucyh0aGlzLnBlbmRpbmdBY3Rpb25zKTtcbiAgICAgICAgdGhpcy5wZW5kaW5nQWN0aW9ucyA9IFtdO1xuICAgICAgICBwYW5lbC5yZW1vdmUoKTtcbiAgICAgICAgbmV3IE5vdGljZShzdW1tYXJ5KTtcbiAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIFwiQWN0aW9ucyBhcHBsaWVkLlwiLCBzdW1tYXJ5KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGFwcHJvdmVCdXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgZGlzY2FyZEJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBuZXcgTm90aWNlKGBGYWlsZWQgdG8gYXBwbHkgYWN0aW9uczogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBkaXNjYXJkQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICB0aGlzLnBlbmRpbmdBY3Rpb25zID0gW107XG4gICAgICBuZXcgTm90aWNlKFwiUGVuZGluZyBhY3Rpb25zIGRpc2NhcmRlZC5cIik7XG4gICAgICBwYW5lbC5yZW1vdmUoKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgcmVwbGFjZUNpdGF0aW9uTWFya2Vyc1dpdGhXaWtpTGlua3ModGV4dDogc3RyaW5nLCBjaHVua3M6IE5vdGVDaHVua1tdKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGV4dC5yZXBsYWNlKC9cXFsoXFxkKylcXF0vZywgKGZ1bGwsIG51bVRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgaWR4ID0gTnVtYmVyLnBhcnNlSW50KG51bVRleHQsIDEwKTtcbiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkgfHwgaWR4IDwgMSB8fCBpZHggPiBjaHVua3MubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiBmdWxsO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBwYXRoID0gY2h1bmtzW2lkeCAtIDFdPy5maWxlUGF0aDtcbiAgICAgIGlmICghcGF0aCkge1xuICAgICAgICByZXR1cm4gZnVsbDtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGBbWyR7cGF0aH1dXWA7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIHByZXBhcmVBY3Rpb25zV2l0aENpdGF0aW9uTGlua3MoYWN0aW9uczogQWdlbnRBY3Rpb25bXSwgY2h1bmtzOiBOb3RlQ2h1bmtbXSk6IEFnZW50QWN0aW9uW10ge1xuICAgIHJldHVybiBhY3Rpb25zLm1hcCgoYWN0aW9uKSA9PiB7XG4gICAgICBpZiAoYWN0aW9uLnR5cGUgPT09IFwiY3JlYXRlX2ZpbGVcIikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIC4uLmFjdGlvbixcbiAgICAgICAgICBjb250ZW50OiB0aGlzLnJlcGxhY2VDaXRhdGlvbk1hcmtlcnNXaXRoV2lraUxpbmtzKGFjdGlvbi5jb250ZW50LCBjaHVua3MpXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJhcHBlbmRfZmlsZVwiKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4uYWN0aW9uLFxuICAgICAgICAgIGNvbnRlbnQ6IHRoaXMucmVwbGFjZUNpdGF0aW9uTWFya2Vyc1dpdGhXaWtpTGlua3MoYWN0aW9uLmNvbnRlbnQsIGNodW5rcylcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgaWYgKGFjdGlvbi50eXBlID09PSBcImluc2VydF9hZnRlcl9oZWFkaW5nXCIpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAuLi5hY3Rpb24sXG4gICAgICAgICAgY29udGVudDogdGhpcy5yZXBsYWNlQ2l0YXRpb25NYXJrZXJzV2l0aFdpa2lMaW5rcyhhY3Rpb24uY29udGVudCwgY2h1bmtzKVxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBpZiAoYWN0aW9uLnR5cGUgPT09IFwicmVwbGFjZV9pbl9maWxlXCIpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAuLi5hY3Rpb24sXG4gICAgICAgICAgcmVwbGFjZTogdGhpcy5yZXBsYWNlQ2l0YXRpb25NYXJrZXJzV2l0aFdpa2lMaW5rcyhhY3Rpb24ucmVwbGFjZSwgY2h1bmtzKVxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBpZiAoYWN0aW9uLnR5cGUgPT09IFwiY3JlYXRlX2Zyb21fdGVtcGxhdGVcIikge1xuICAgICAgICBjb25zdCB2YXJzID0gYWN0aW9uLnZhcmlhYmxlcyA/PyB7fTtcbiAgICAgICAgY29uc3QgdXBkYXRlZFZhcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFycykpIHtcbiAgICAgICAgICB1cGRhdGVkVmFyc1trZXldID0gdGhpcy5yZXBsYWNlQ2l0YXRpb25NYXJrZXJzV2l0aFdpa2lMaW5rcyh2YWx1ZSwgY2h1bmtzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4uYWN0aW9uLFxuICAgICAgICAgIHZhcmlhYmxlczogdXBkYXRlZFZhcnNcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGFjdGlvbjtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgZGVzY3JpYmVBY3Rpb24oYWN0aW9uOiBBZ2VudEFjdGlvbik6IHN0cmluZyB7XG4gICAgaWYgKGFjdGlvbi50eXBlID09PSBcImNyZWF0ZV9mb2xkZXJcIikge1xuICAgICAgcmV0dXJuIGBjcmVhdGVfZm9sZGVyOiAke2FjdGlvbi5wYXRofWA7XG4gICAgfVxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJjcmVhdGVfZmlsZVwiKSB7XG4gICAgICByZXR1cm4gYGNyZWF0ZV9maWxlOiAke2FjdGlvbi5wYXRofSR7YWN0aW9uLm92ZXJ3cml0ZSA/IFwiIChvdmVyd3JpdGUpXCIgOiBcIlwifWA7XG4gICAgfVxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJhcHBlbmRfZmlsZVwiKSB7XG4gICAgICByZXR1cm4gYGFwcGVuZF9maWxlOiAke2FjdGlvbi5wYXRofWA7XG4gICAgfVxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJpbnNlcnRfYWZ0ZXJfaGVhZGluZ1wiKSB7XG4gICAgICByZXR1cm4gYGluc2VydF9hZnRlcl9oZWFkaW5nOiAke2FjdGlvbi5wYXRofSBhZnRlciAke2FjdGlvbi5oZWFkaW5nfWA7XG4gICAgfVxuICAgIGlmIChhY3Rpb24udHlwZSA9PT0gXCJyZXBsYWNlX2luX2ZpbGVcIikge1xuICAgICAgcmV0dXJuIGByZXBsYWNlX2luX2ZpbGU6ICR7YWN0aW9uLnBhdGh9IGZpbmQgXFxcIiR7YWN0aW9uLmZpbmR9XFxcImA7XG4gICAgfVxuICAgIHJldHVybiBgY3JlYXRlX2Zyb21fdGVtcGxhdGU6ICR7YWN0aW9uLnRlbXBsYXRlfSAtPiAke2FjdGlvbi5wYXRofWA7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGhhbmRsZVNsYXNoQ29tbWFuZChjb21tYW5kVGV4dDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgaWYgKCFjb21tYW5kVGV4dC5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGNvbnN0IFtjb21tYW5kLCAuLi5yZXN0XSA9IGNvbW1hbmRUZXh0LnNsaWNlKDEpLnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuICAgIGNvbnN0IGFyZyA9IHJlc3Quam9pbihcIiBcIikudHJpbSgpO1xuXG4gICAgc3dpdGNoIChjb21tYW5kLnRvTG93ZXJDYXNlKCkpIHtcbiAgICAgIGNhc2UgXCJoZWxwXCI6XG4gICAgICAgIHRoaXMuYWRkTWVzc2FnZShcbiAgICAgICAgICBcImFzc2lzdGFudFwiLFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIFwiU2xhc2ggY29tbWFuZHM6XCIsXG4gICAgICAgICAgICBcIi9oZWxwXCIsXG4gICAgICAgICAgICBcIi9tb2RlbCA8bW9kZWwtaWQ+XCIsXG4gICAgICAgICAgICBcIi9yZWluZGV4XCIsXG4gICAgICAgICAgICBcIi9jbGVhclwiLFxuICAgICAgICAgICAgXCIvc2F2ZVwiLFxuICAgICAgICAgICAgXCIvbW9kZSB2YXVsdHxub3RlXCIsXG4gICAgICAgICAgICBcIi9maW5kIDxxdWVyeT5cIixcbiAgICAgICAgICAgIFwiL3RhZyA8dGFnPlwiLFxuICAgICAgICAgICAgXCIvb3BlbiA8cXVlcnk+XCIsXG4gICAgICAgICAgICBcIi9waW4gPHRleHQ+XCIsXG4gICAgICAgICAgICBcIi9waW5zXCJcbiAgICAgICAgICBdLmpvaW4oXCJcXG5cIilcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICBjYXNlIFwibW9kZWxcIjpcbiAgICAgICAgaWYgKCFhcmcpIHtcbiAgICAgICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgYEN1cnJlbnQgbW9kZWw6ICR7dGhpcy5wbHVnaW4uc2V0dGluZ3MubW9kZWx9YCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MubW9kZWwgPSBhcmc7XG4gICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIGBNb2RlbCBzZXQgdG86ICR7YXJnfWApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSBcInJlaW5kZXhcIjpcbiAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4ucmVidWlsZEluZGV4KCk7XG4gICAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBcIlZhdWx0IGluZGV4IHJlYnVpbHQuXCIpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIGNhc2UgXCJjbGVhclwiOlxuICAgICAgICB0aGlzLm1lc3NhZ2VzID0gW107XG4gICAgICAgIHRoaXMucGVuZGluZ0FjdGlvbnMgPSBbXTtcbiAgICAgICAgdGhpcy5jb252ZXJzYXRpb25TdW1tYXJ5ID0gXCJcIjtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0RWwuZW1wdHkoKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICBjYXNlIFwic2F2ZVwiOlxuICAgICAgICBhd2FpdCB0aGlzLnNhdmVDaGF0KCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSBcIm1vZGVcIjpcbiAgICAgICAgaWYgKGFyZyA9PT0gXCJ2YXVsdFwiKSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zd2l0Y2hNb2RlKFwidmF1bHRcIik7XG4gICAgICAgIH0gZWxzZSBpZiAoYXJnID09PSBcIm5vdGVcIikge1xuICAgICAgICAgIGNvbnN0IGFjdGl2ZUZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgICAgICAgIGlmICghYWN0aXZlRmlsZSB8fCBhY3RpdmVGaWxlLmV4dGVuc2lvbiAhPT0gXCJtZFwiKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiT3BlbiBhIG1hcmtkb3duIG5vdGUgZmlyc3QuXCIpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnN3aXRjaE1vZGUoXCJub3RlXCIsIGFjdGl2ZUZpbGUucGF0aCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBcIlVzYWdlOiAvbW9kZSB2YXVsdHxub3RlXCIpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSBcImZpbmRcIjpcbiAgICAgICAgaWYgKCFhcmcpIHtcbiAgICAgICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgXCJVc2FnZTogL2ZpbmQgPHF1ZXJ5PlwiKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmhhbmRsZUZpbmQoYXJnKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICBjYXNlIFwidGFnXCI6XG4gICAgICAgIGlmICghYXJnKSB7XG4gICAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIFwiVXNhZ2U6IC90YWcgPHRhZz5cIik7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgdGhpcy5oYW5kbGVUYWcoYXJnLnJlcGxhY2UoL14jLywgXCJcIikpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICAgIGlmICghYXJnKSB7XG4gICAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIFwiVXNhZ2U6IC9vcGVuIDxwYXRoLWZyYWdtZW50PlwiKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCB0aGlzLmhhbmRsZU9wZW4oYXJnKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICBjYXNlIFwicGluXCI6XG4gICAgICAgIGlmICghYXJnKSB7XG4gICAgICAgICAgdGhpcy5waW5MYXN0TWVzc2FnZSgpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMucGlubmVkTWVzc2FnZXMucHVzaCh7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBhcmcgfSk7XG4gICAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIGBQaW5uZWQ6ICR7YXJnfWApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSBcInBpbnNcIjpcbiAgICAgICAgdGhpcy5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwiYXNzaXN0YW50XCIsXG4gICAgICAgICAgdGhpcy5waW5uZWRNZXNzYWdlcy5sZW5ndGhcbiAgICAgICAgICAgID8gdGhpcy5waW5uZWRNZXNzYWdlcy5tYXAoKG1zZywgaWR4KSA9PiBgJHtpZHggKyAxfS4gJHttc2cucm9sZX06ICR7bXNnLmNvbnRlbnR9YCkuam9pbihcIlxcblwiKVxuICAgICAgICAgICAgOiBcIk5vIHBpbm5lZCBtZXNzYWdlcy5cIlxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRoaXMuYWRkTWVzc2FnZShcImFzc2lzdGFudFwiLCBgVW5rbm93biBjb21tYW5kOiAvJHtjb21tYW5kfS4gVXNlIC9oZWxwLmApO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZUZpbmQocXVlcnk6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHEgPSBxdWVyeS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IGZpbGVzID0gdGhpcy5hcHAudmF1bHRcbiAgICAgIC5nZXRNYXJrZG93bkZpbGVzKClcbiAgICAgIC5maWx0ZXIoKGZpbGUpID0+IGZpbGUucGF0aC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKVxuICAgICAgLnNsaWNlKDAsIDIwKTtcblxuICAgIGlmICghZmlsZXMubGVuZ3RoKSB7XG4gICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgYE5vIG5vdGVzIGZvdW5kIGZvcjogJHtxdWVyeX1gKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgZmlsZXMubWFwKChmaWxlKSA9PiBgLSAke2ZpbGUucGF0aH1gKS5qb2luKFwiXFxuXCIpKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgaGFuZGxlVGFnKHRhZzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZmlsZXMgPSB0aGlzLmFwcC52YXVsdC5nZXRNYXJrZG93bkZpbGVzKCk7XG4gICAgY29uc3QgbWF0Y2hlczogc3RyaW5nW10gPSBbXTtcblxuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNhY2hlZFJlYWQoZmlsZSk7XG4gICAgICBjb25zdCBoYXNJbmxpbmVUYWcgPSBuZXcgUmVnRXhwKGAoXnxcXFxccykjJHt0YWd9KFxcXFxifFxcXFxzfCQpYCwgXCJpXCIpLnRlc3QodGV4dCk7XG4gICAgICBjb25zdCBoYXNGcm9udG1hdHRlclRhZyA9IG5ldyBSZWdFeHAoYChefFxcXFxuKXRhZ3M6XFxcXHMqKC4qJHt0YWd9LiopJGAsIFwiaW1cIikudGVzdCh0ZXh0KTtcbiAgICAgIGlmIChoYXNJbmxpbmVUYWcgfHwgaGFzRnJvbnRtYXR0ZXJUYWcpIHtcbiAgICAgICAgbWF0Y2hlcy5wdXNoKGZpbGUucGF0aCk7XG4gICAgICB9XG4gICAgICBpZiAobWF0Y2hlcy5sZW5ndGggPj0gMjApIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5hZGRNZXNzYWdlKFxuICAgICAgXCJhc3Npc3RhbnRcIixcbiAgICAgIG1hdGNoZXMubGVuZ3RoID8gbWF0Y2hlcy5tYXAoKHBhdGgpID0+IGAtICR7cGF0aH1gKS5qb2luKFwiXFxuXCIpIDogYE5vIG5vdGVzIGZvdW5kIGZvciB0YWcgIyR7dGFnfWBcbiAgICApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBoYW5kbGVPcGVuKHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBxID0gcXVlcnkudG9Mb3dlckNhc2UoKTtcbiAgICBjb25zdCBmaWxlID0gdGhpcy5hcHAudmF1bHRcbiAgICAgIC5nZXRNYXJrZG93bkZpbGVzKClcbiAgICAgIC5maW5kKChjYW5kaWRhdGUpID0+IGNhbmRpZGF0ZS5wYXRoLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpO1xuXG4gICAgaWYgKCFmaWxlKSB7XG4gICAgICB0aGlzLmFkZE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgYE5vIG1hdGNoaW5nIG5vdGUgdG8gb3BlbiBmb3I6ICR7cXVlcnl9YCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYodHJ1ZSkub3BlbkZpbGUoZmlsZSk7XG4gICAgdGhpcy5hZGRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIGBPcGVuZWQ6ICR7ZmlsZS5wYXRofWApO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRNZXNzYWdlKFxuICAgIHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIixcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgbWV0YVRleHQ/OiBzdHJpbmcsXG4gICAgcmVmZXJlbmNlZEZpbGVzOiBURmlsZVtdID0gW10sXG4gICAgdGhpbmtpbmdUZXh0Pzogc3RyaW5nXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGJ1YmJsZSA9IHRoaXMudHJhbnNjcmlwdEVsLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IGByYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZSByYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS0ke3JvbGV9YFxuICAgIH0pO1xuXG4gICAgYnViYmxlLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2Utcm9sZVwiLFxuICAgICAgdGV4dDogcm9sZSA9PT0gXCJ1c2VyXCIgPyBcIllvdVwiIDogXCJBc3Npc3RhbnRcIlxuICAgIH0pO1xuXG4gICAgY29uc3QgY29udGVudEVsID0gYnViYmxlLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtY29udGVudFwiLFxuICAgICAgdGV4dFxuICAgIH0pO1xuXG4gICAgaWYgKHJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcbiAgICAgIHZvaWQgdGhpcy5yZW5kZXJBc3Npc3RhbnRNYXJrZG93bihjb250ZW50RWwsIHRleHQpO1xuICAgIH1cblxuICAgIGlmIChyb2xlID09PSBcImFzc2lzdGFudFwiICYmIHRoaW5raW5nVGV4dCkge1xuICAgICAgYnViYmxlLmNyZWF0ZURpdih7XG4gICAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS10aGlua2luZ1wiLFxuICAgICAgICB0ZXh0OiB0aGlua2luZ1RleHRcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChtZXRhVGV4dCkge1xuICAgICAgYnViYmxlLmNyZWF0ZURpdih7XG4gICAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1tZXRhXCIsXG4gICAgICAgIHRleHQ6IG1ldGFUZXh0XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAocm9sZSA9PT0gXCJhc3Npc3RhbnRcIiAmJiByZWZlcmVuY2VkRmlsZXMubGVuZ3RoKSB7XG4gICAgICBjb25zdCByZWZzV3JhcCA9IGJ1YmJsZS5jcmVhdGVEaXYoeyBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtbGlua3NcIiB9KTtcbiAgICAgIHJlZnNXcmFwLmNyZWF0ZURpdih7XG4gICAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy10aXRsZVwiLFxuICAgICAgICB0ZXh0OiBcIlJlZmVyZW5jZWQgZmlsZXNcIlxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlZnNMaXN0ID0gcmVmc1dyYXAuY3JlYXRlRWwoXCJ1bFwiLCB7IGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1saW5rcy1saXN0XCIgfSk7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgcmVmZXJlbmNlZEZpbGVzKSB7XG4gICAgICAgIGNvbnN0IGxpID0gcmVmc0xpc3QuY3JlYXRlRWwoXCJsaVwiKTtcbiAgICAgICAgY29uc3QgbGluayA9IGxpLmNyZWF0ZUVsKFwiYVwiLCB7IHRleHQ6IGZpbGUucGF0aCwgaHJlZjogXCIjXCIgfSk7XG4gICAgICAgIGxpbmsuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYodHJ1ZSkub3BlbkZpbGUoZmlsZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMudHJhbnNjcmlwdEVsLnNjcm9sbFRvcCA9IHRoaXMudHJhbnNjcmlwdEVsLnNjcm9sbEhlaWdodDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc2VuZE1lc3NhZ2UoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcXVlc3Rpb24gPSB0aGlzLmlucHV0RWwudmFsdWUudHJpbSgpO1xuICAgIGlmICghcXVlc3Rpb24pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoYXdhaXQgdGhpcy5oYW5kbGVTbGFzaENvbW1hbmQocXVlc3Rpb24pKSB7XG4gICAgICB0aGlzLmlucHV0RWwudmFsdWUgPSBcIlwiO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm1vZGUgPT09IFwibm90ZVwiICYmICF0aGlzLm5vdGVQYXRoKSB7XG4gICAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICAgIGlmICghYWN0aXZlRmlsZSB8fCBhY3RpdmVGaWxlLmV4dGVuc2lvbiAhPT0gXCJtZFwiKSB7XG4gICAgICAgIG5ldyBOb3RpY2UoXCJPcGVuIGEgbWFya2Rvd24gbm90ZSBmaXJzdC5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMubm90ZVBhdGggPSBhY3RpdmVGaWxlLnBhdGg7XG4gICAgfVxuXG4gICAgY29uc3QgaGlzdG9yeUJlZm9yZVR1cm4gPSBbLi4udGhpcy5tZXNzYWdlc107XG4gICAgYXdhaXQgdGhpcy5tYXliZVN1bW1hcml6ZUhpc3RvcnkoaGlzdG9yeUJlZm9yZVR1cm4pO1xuICAgIGNvbnN0IG1vZGVsSGlzdG9yeSA9IHRoaXMuZ2V0SGlzdG9yeUZvck1vZGVsKGhpc3RvcnlCZWZvcmVUdXJuKTtcblxuICAgIGlmICh0aGlzLmNvbnZlcnNhdGlvblN1bW1hcnkpIHtcbiAgICAgIG1vZGVsSGlzdG9yeS51bnNoaWZ0KHtcbiAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgY29udGVudDogYENvbnZlcnNhdGlvbiBzdW1tYXJ5IG1lbW9yeTpcXG4ke3RoaXMuY29udmVyc2F0aW9uU3VtbWFyeX1gXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogcXVlc3Rpb24gfSk7XG4gICAgdGhpcy5hZGRNZXNzYWdlKFwidXNlclwiLCBxdWVzdGlvbik7XG4gICAgdGhpcy5pbnB1dEVsLnZhbHVlID0gXCJcIjtcbiAgICB0aGlzLnNlbmRCdXR0b25FbC5kaXNhYmxlZCA9IHRydWU7XG4gICAgdGhpcy5zYXZlQnV0dG9uRWwuZGlzYWJsZWQgPSB0cnVlO1xuXG4gICAgY29uc3QgYXNzaXN0YW50QnViYmxlID0gdGhpcy50cmFuc2NyaXB0RWwuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZSByYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1hc3Npc3RhbnRcIlxuICAgIH0pO1xuICAgIGFzc2lzdGFudEJ1YmJsZS5jcmVhdGVEaXYoe1xuICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLW5vdGUtY2hhdC1tZXNzYWdlLXJvbGVcIixcbiAgICAgIHRleHQ6IFwiQXNzaXN0YW50XCJcbiAgICB9KTtcbiAgICBjb25zdCBhc3Npc3RhbnRDb250ZW50RWwgPSBhc3Npc3RhbnRCdWJibGUuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1jb250ZW50XCIsXG4gICAgICB0ZXh0OiBcIlwiXG4gICAgfSk7XG4gICAgY29uc3QgYXNzaXN0YW50VGhpbmtpbmdXcmFwID0gYXNzaXN0YW50QnViYmxlLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItdGhpbmtpbmctd3JhcFwiXG4gICAgfSk7XG4gICAgY29uc3QgYXNzaXN0YW50VGhpbmtpbmdUb2dnbGVFbCA9IGFzc2lzdGFudFRoaW5raW5nV3JhcC5jcmVhdGVFbChcImJ1dHRvblwiLCB7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItdGhpbmtpbmctdG9nZ2xlXCIsXG4gICAgICB0ZXh0OiBcIlRoaW5raW5nIChzdHJlYW1pbmcpXCJcbiAgICB9KTtcbiAgICBjb25zdCBhc3Npc3RhbnRUaGlua2luZ0VsID0gYXNzaXN0YW50VGhpbmtpbmdXcmFwLmNyZWF0ZURpdih7XG4gICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbm90ZS1jaGF0LW1lc3NhZ2UtdGhpbmtpbmdcIixcbiAgICAgIHRleHQ6IFwiXCJcbiAgICB9KTtcbiAgICBjb25zdCBhc3Npc3RhbnRNZXRhRWwgPSBhc3Npc3RhbnRCdWJibGUuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogXCJyYWctb3BlbnJvdXRlci1ub3RlLWNoYXQtbWVzc2FnZS1tZXRhXCIsXG4gICAgICB0ZXh0OiBcIlN0cmVhbWluZy4uLlwiXG4gICAgfSk7XG4gICAgY29uc3QgdGhpbmtpbmdWaWV3ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MudGhpbmtpbmdWaWV3O1xuXG4gICAgbGV0IHN0cmVhbWVkQW5zd2VyID0gXCJcIjtcbiAgICBsZXQgc3RyZWFtZWRUaGlua2luZyA9IFwiXCI7XG4gICAgbGV0IHRoaW5raW5nRXhwYW5kZWQgPSB0cnVlO1xuXG4gICAgY29uc3Qgc2V0VGhpbmtpbmdFeHBhbmRlZCA9IChleHBhbmRlZDogYm9vbGVhbiwgc3RyZWFtaW5nOiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgICB0aGlua2luZ0V4cGFuZGVkID0gZXhwYW5kZWQ7XG4gICAgICBhc3Npc3RhbnRUaGlua2luZ1dyYXAudG9nZ2xlQ2xhc3MoXCJpcy1jb2xsYXBzZWRcIiwgIXRoaW5raW5nRXhwYW5kZWQpO1xuICAgICAgaWYgKHN0cmVhbWVkVGhpbmtpbmcpIHtcbiAgICAgICAgaWYgKHN0cmVhbWluZykge1xuICAgICAgICAgIGFzc2lzdGFudFRoaW5raW5nVG9nZ2xlRWwuc2V0VGV4dChcbiAgICAgICAgICAgIHRoaW5raW5nRXhwYW5kZWQgPyBcIlRoaW5raW5nIChzdHJlYW1pbmcpXCIgOiBcIlRoaW5raW5nIChzdHJlYW1pbmcsIGNvbGxhcHNlZClcIlxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYXNzaXN0YW50VGhpbmtpbmdUb2dnbGVFbC5zZXRUZXh0KHRoaW5raW5nRXhwYW5kZWQgPyBcIlRoaW5raW5nXCIgOiBcIlRoaW5raW5nIChjb2xsYXBzZWQpXCIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcblxuICAgIGFzc2lzdGFudFRoaW5raW5nVG9nZ2xlRWwuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIHNldFRoaW5raW5nRXhwYW5kZWQoIXRoaW5raW5nRXhwYW5kZWQsIGZhbHNlKTtcbiAgICB9KTtcblxuICAgIHRyeSB7XG4gICAgICBpZiAodGhpcy5tb2RlID09PSBcIm5vdGVcIikge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnBsdWdpbi5zdHJlYW1DaGF0V2l0aE5vdGUodGhpcy5ub3RlUGF0aCwgcXVlc3Rpb24sIG1vZGVsSGlzdG9yeSwge1xuICAgICAgICAgIG9uQW5zd2VyRGVsdGE6IChkZWx0YSkgPT4ge1xuICAgICAgICAgICAgc3RyZWFtZWRBbnN3ZXIgKz0gZGVsdGE7XG4gICAgICAgICAgICBhc3Npc3RhbnRDb250ZW50RWwuc2V0VGV4dChzdHJlYW1lZEFuc3dlcik7XG4gICAgICAgICAgICB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxUb3AgPSB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxIZWlnaHQ7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBvblRoaW5raW5nRGVsdGE6IChkZWx0YSkgPT4ge1xuICAgICAgICAgICAgaWYgKHRoaW5raW5nVmlldyA9PT0gXCJoaWRkZW5cIikge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHN0cmVhbWVkVGhpbmtpbmcgKz0gZGVsdGE7XG4gICAgICAgICAgICBhc3Npc3RhbnRUaGlua2luZ0VsLnNldFRleHQoc3RyZWFtZWRUaGlua2luZyk7XG4gICAgICAgICAgICBzZXRUaGlua2luZ0V4cGFuZGVkKHRydWUsIHRydWUpO1xuICAgICAgICAgICAgdGhpcy50cmFuc2NyaXB0RWwuc2Nyb2xsVG9wID0gdGhpcy50cmFuc2NyaXB0RWwuc2Nyb2xsSGVpZ2h0O1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudDogcmVzdWx0LmFuc3dlciB9KTtcbiAgICAgICAgY29uc3Qgc291cmNlTWV0YSA9XG4gICAgICAgICAgcmVzdWx0LmNodW5rcy5sZW5ndGggPiAwXG4gICAgICAgICAgICA/IGBTb3VyY2VzIGZyb20gdGhpcyBub3RlOiAke3Jlc3VsdC5jaHVua3MubGVuZ3RofWBcbiAgICAgICAgICAgIDogXCJObyBtYXRjaGluZyBjaHVua3MgZm91bmQgaW4gdGhpcyBub3RlLlwiO1xuXG4gICAgICAgIGF3YWl0IHRoaXMucmVuZGVyQXNzaXN0YW50TWFya2Rvd24oYXNzaXN0YW50Q29udGVudEVsLCByZXN1bHQuYW5zd2VyLCByZXN1bHQuY2h1bmtzKTtcbiAgICAgICAgYXNzaXN0YW50TWV0YUVsLnNldFRleHQoc291cmNlTWV0YSk7XG4gICAgICAgIHRoaXMucmVuZGVyQ2l0YXRpb25MaW5rcyhhc3Npc3RhbnRCdWJibGUsIHJlc3VsdC5hbnN3ZXIsIHJlc3VsdC5jaHVua3MpO1xuICAgICAgICB0aGlzLnJlbmRlclJlZmVyZW5jZWRGaWxlcyhhc3Npc3RhbnRCdWJibGUsIHJlc3VsdC5hbnN3ZXIsIHJlc3VsdC5jaHVua3MpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5wbHVnaW4uc3RyZWFtQ2hhdFdpdGhWYXVsdChxdWVzdGlvbiwgbW9kZWxIaXN0b3J5LCB7XG4gICAgICAgICAgb25BbnN3ZXJEZWx0YTogKGRlbHRhKSA9PiB7XG4gICAgICAgICAgICBzdHJlYW1lZEFuc3dlciArPSBkZWx0YTtcbiAgICAgICAgICAgIGFzc2lzdGFudENvbnRlbnRFbC5zZXRUZXh0KHN0cmVhbWVkQW5zd2VyKTtcbiAgICAgICAgICAgIHRoaXMudHJhbnNjcmlwdEVsLnNjcm9sbFRvcCA9IHRoaXMudHJhbnNjcmlwdEVsLnNjcm9sbEhlaWdodDtcbiAgICAgICAgICB9LFxuICAgICAgICAgIG9uVGhpbmtpbmdEZWx0YTogKGRlbHRhKSA9PiB7XG4gICAgICAgICAgICBpZiAodGhpbmtpbmdWaWV3ID09PSBcImhpZGRlblwiKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3RyZWFtZWRUaGlua2luZyArPSBkZWx0YTtcbiAgICAgICAgICAgIGFzc2lzdGFudFRoaW5raW5nRWwuc2V0VGV4dChzdHJlYW1lZFRoaW5raW5nKTtcbiAgICAgICAgICAgIHNldFRoaW5raW5nRXhwYW5kZWQodHJ1ZSwgdHJ1ZSk7XG4gICAgICAgICAgICB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxUb3AgPSB0aGlzLnRyYW5zY3JpcHRFbC5zY3JvbGxIZWlnaHQ7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlOiBcImFzc2lzdGFudFwiLCBjb250ZW50OiByZXN1bHQuYW5zd2VyIH0pO1xuICAgICAgICBjb25zdCBtZXRhUGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIG1ldGFQYXJ0cy5wdXNoKFxuICAgICAgICAgIHJlc3VsdC5jaHVua3MubGVuZ3RoID4gMFxuICAgICAgICAgICAgPyBgVmF1bHQgc291cmNlcyB1c2VkOiAke3Jlc3VsdC5jaHVua3MubGVuZ3RofWBcbiAgICAgICAgICAgIDogXCJObyBtYXRjaGluZyB2YXVsdCBjaHVua3MgZm91bmQuXCJcbiAgICAgICAgKTtcblxuICAgICAgICBhd2FpdCB0aGlzLnJlbmRlckFzc2lzdGFudE1hcmtkb3duKGFzc2lzdGFudENvbnRlbnRFbCwgcmVzdWx0LmFuc3dlciwgcmVzdWx0LmNodW5rcyk7XG4gICAgICAgIGFzc2lzdGFudE1ldGFFbC5zZXRUZXh0KG1ldGFQYXJ0cy5qb2luKFwiIHwgXCIpKTtcblxuICAgICAgICB0aGlzLnBlbmRpbmdBY3Rpb25zID0gdGhpcy5wcmVwYXJlQWN0aW9uc1dpdGhDaXRhdGlvbkxpbmtzKHJlc3VsdC5wZW5kaW5nQWN0aW9ucywgcmVzdWx0LmNodW5rcyk7XG5cbiAgICAgICAgdGhpcy5yZW5kZXJDaXRhdGlvbkxpbmtzKGFzc2lzdGFudEJ1YmJsZSwgcmVzdWx0LmFuc3dlciwgcmVzdWx0LmNodW5rcyk7XG4gICAgICAgIHRoaXMucmVuZGVyUmVmZXJlbmNlZEZpbGVzKGFzc2lzdGFudEJ1YmJsZSwgcmVzdWx0LmFuc3dlciwgcmVzdWx0LmNodW5rcyk7XG4gICAgICAgIHRoaXMucmVuZGVyUGVuZGluZ0FjdGlvbnMoYXNzaXN0YW50QnViYmxlKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaW5raW5nVmlldyA9PT0gXCJoaWRkZW5cIiB8fCAhc3RyZWFtZWRUaGlua2luZykge1xuICAgICAgICBhc3Npc3RhbnRUaGlua2luZ1dyYXAucmVtb3ZlKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZXRUaGlua2luZ0V4cGFuZGVkKHRoaW5raW5nVmlldyA9PT0gXCJleHBhbmRlZFwiLCBmYWxzZSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGFzc2lzdGFudE1ldGFFbC5zZXRUZXh0KFwiRmFpbGVkXCIpO1xuICAgICAgY29uc29sZS5lcnJvcihcIlNpZGViYXIgY2hhdCBmYWlsZWRcIiwgZXJyb3IpO1xuICAgICAgbmV3IE5vdGljZShgQ2hhdCBmYWlsZWQ6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLnNlbmRCdXR0b25FbC5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgdGhpcy5zYXZlQnV0dG9uRWwuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuaW5wdXRFbC5mb2N1cygpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc2F2ZUNoYXQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRpdGxlID0gdGhpcy5tb2RlID09PSBcIm5vdGVcIiA/IFwiU2lkZWJhciBOb3RlIENoYXRcIiA6IFwiU2lkZWJhciBWYXVsdCBBZ2VudCBDaGF0XCI7XG4gICAgICBjb25zdCBmaWxlID0gYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZUNoYXRBc05vdGUodGl0bGUsIHRoaXMubWVzc2FnZXMpO1xuICAgICAgbmV3IE5vdGljZShgQ2hhdCBzYXZlZDogJHtmaWxlLnBhdGh9YCk7XG4gICAgICBhd2FpdCB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZih0cnVlKS5vcGVuRmlsZShmaWxlKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbmV3IE5vdGljZShgRmFpbGVkIHRvIHNhdmUgY2hhdDogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBub3JtYWxpemVBc3Npc3RhbnRNYXJrZG93bih0ZXh0OiBzdHJpbmcsIGNodW5rczogTm90ZUNodW5rW10gPSBbXSk6IHN0cmluZyB7XG4gICAgY29uc3QgdmF1bHROYW1lID0gdGhpcy5hcHAudmF1bHQuZ2V0TmFtZSgpO1xuICAgIGxldCBvdXRwdXQgPSB0ZXh0O1xuICAgIGNvbnN0IHN0eWxlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MuY2l0YXRpb25TdHlsZTtcblxuICAgIC8vIE5vcm1hbGl6ZSBtb2RlbC1zcGVjaWZpYyBjaXRhdGlvbiB0b2tlbnMgbGlrZSBbNFx1MjAyMEwxMy1MMTZdIC0+IFs0XVxuICAgIG91dHB1dCA9IG91dHB1dC5yZXBsYWNlKC9cXFsoXFxkKylcXHMqXHUyMDIwW15cXF1dKlxcXS9nLCBcIlskMV1cIik7XG5cbiAgICBjb25zdCBjaXRhdGlvblVyaSA9IChudW1UZXh0OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+IHtcbiAgICAgIGNvbnN0IGlkeCA9IE51bWJlci5wYXJzZUludChudW1UZXh0LCAxMCk7XG4gICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpIHx8IGlkeCA8IDEgfHwgaWR4ID4gY2h1bmtzLmxlbmd0aCkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGF0aCA9IGNodW5rc1tpZHggLSAxXT8uZmlsZVBhdGg7XG4gICAgICBpZiAoIXBhdGgpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBgb2JzaWRpYW46Ly9vcGVuP3ZhdWx0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHZhdWx0TmFtZSl9JmZpbGU9JHtlbmNvZGVVUklDb21wb25lbnQocGF0aCl9YDtcbiAgICB9O1xuXG4gICAgaWYgKHN0eWxlID09PSBcInBocmFzZVwiKSB7XG4gICAgICAvLyBUdXJuIGJvbGQgY2l0ZWQgcGhyYXNlcyBpbnRvIGNsaWNrYWJsZSBwaHJhc2UgbGlua3M6ICoqUmVnaXN0cnkgUmV3cml0ZSoqIFsxXVxuICAgICAgb3V0cHV0ID0gb3V0cHV0LnJlcGxhY2UoXG4gICAgICAgIC9cXCpcXCooW14qXFxuXVteKlxcbl17MCwxMjB9PylcXCpcXCpcXHMqXFxbKFxcZCspXFxdL2csXG4gICAgICAgIChmdWxsLCBwaHJhc2U6IHN0cmluZywgbnVtVGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgY29uc3QgdXJpID0gY2l0YXRpb25VcmkobnVtVGV4dCk7XG4gICAgICAgICAgaWYgKCF1cmkpIHtcbiAgICAgICAgICAgIHJldHVybiBmdWxsO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBgKipbJHtwaHJhc2UudHJpbSgpfV0oJHt1cml9KSoqYDtcbiAgICAgICAgfVxuICAgICAgKTtcblxuICAgICAgLy8gVHVybiBwbGFpbiBjaXRlZCBwaHJhc2VzIGludG8gY2xpY2thYmxlIHBocmFzZSBsaW5rczogUmVnaXN0cnkgUmV3cml0ZSBbMV1cbiAgICAgIG91dHB1dCA9IG91dHB1dC5yZXBsYWNlKFxuICAgICAgICAvKF58W1xccyg+XFwtXHUyMDIyXSkoW0EtWmEtel1bQS1aYS16MC05J1x1MjAxOVxcLV17MSwzMH0oPzpcXHMrW0EtWmEtejAtOSdcdTIwMTlcXC1dezEsMzB9KXswLDV9KVxccypcXFsoXFxkKylcXF0vZ20sXG4gICAgICAgIChmdWxsLCBwcmVmaXg6IHN0cmluZywgcGhyYXNlOiBzdHJpbmcsIG51bVRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgICAgIGNvbnN0IHVyaSA9IGNpdGF0aW9uVXJpKG51bVRleHQpO1xuICAgICAgICAgIGlmICghdXJpKSB7XG4gICAgICAgICAgICByZXR1cm4gZnVsbDtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gYCR7cHJlZml4fVske3BocmFzZS50cmltKCl9XSgke3VyaX0pYDtcbiAgICAgICAgfVxuICAgICAgKTtcblxuICAgICAgb3V0cHV0ID0gb3V0cHV0LnJlcGxhY2UoL1xcWyhcXGQrKVxcXS9nLCAoZnVsbCwgbnVtVGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGNvbnN0IHVyaSA9IGNpdGF0aW9uVXJpKG51bVRleHQpO1xuICAgICAgICBpZiAoIXVyaSkge1xuICAgICAgICAgIHJldHVybiBmdWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGBbc291cmNlICR7bnVtVGV4dH1dKCR7dXJpfSlgO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gb3V0cHV0O1xuICAgIH1cblxuICAgIGlmIChzdHlsZSA9PT0gXCJzb3VyY2VcIikge1xuICAgICAgb3V0cHV0ID0gb3V0cHV0LnJlcGxhY2UoL1xcWyhcXGQrKVxcXS9nLCAoZnVsbCwgbnVtVGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGNvbnN0IHVyaSA9IGNpdGF0aW9uVXJpKG51bVRleHQpO1xuICAgICAgICBpZiAoIXVyaSkge1xuICAgICAgICAgIHJldHVybiBmdWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGBbc291cmNlICR7bnVtVGV4dH1dKCR7dXJpfSlgO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gb3V0cHV0O1xuICAgIH1cblxuICAgIC8vIGZvb3RlciBtb2RlOiByZW1vdmUgaW5saW5lIGNpdGF0aW9uIG1hcmtlcnMgYW5kIHJlbHkgb24gZm9vdGVyIGNpdGF0aW9ucyBsaXN0LlxuICAgIG91dHB1dCA9IG91dHB1dC5yZXBsYWNlKC9cXFsoXFxkKylcXF0vZywgXCJcIik7XG4gICAgb3V0cHV0ID0gb3V0cHV0LnJlcGxhY2UoL1xcc3syLH0vZywgXCIgXCIpO1xuICAgIG91dHB1dCA9IG91dHB1dC5yZXBsYWNlKC9cXHMrKFsuLDs6IT9dKS9nLCBcIiQxXCIpO1xuXG4gICAgcmV0dXJuIG91dHB1dDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVuZGVyQXNzaXN0YW50TWFya2Rvd24oXG4gICAgdGFyZ2V0OiBIVE1MRWxlbWVudCxcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgY2h1bmtzOiBOb3RlQ2h1bmtbXSA9IFtdXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRhcmdldC5lbXB0eSgpO1xuICAgIGNvbnN0IG1hcmtkb3duID0gdGhpcy5ub3JtYWxpemVBc3Npc3RhbnRNYXJrZG93bih0ZXh0LCBjaHVua3MpO1xuICAgIGF3YWl0IE1hcmtkb3duUmVuZGVyZXIucmVuZGVyTWFya2Rvd24obWFya2Rvd24sIHRhcmdldCwgdGhpcy5ub3RlUGF0aCB8fCBcIlwiLCB0aGlzKTtcbiAgfVxufVxuXG5jbGFzcyBBc2tRdWVzdGlvbk1vZGFsIGV4dGVuZHMgTW9kYWwge1xuICBwcml2YXRlIG9uU3VibWl0OiAocXVlc3Rpb246IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgb25TdWJtaXQ6IChxdWVzdGlvbjogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+KSB7XG4gICAgc3VwZXIoYXBwKTtcbiAgICB0aGlzLm9uU3VibWl0ID0gb25TdWJtaXQ7XG4gIH1cblxuICBvbk9wZW4oKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgY29udGVudEVsLmVtcHR5KCk7XG4gICAgY29udGVudEVsLmFkZENsYXNzKFwicmFnLW9wZW5yb3V0ZXItbW9kYWxcIik7XG5cbiAgICBjb250ZW50RWwuY3JlYXRlRWwoXCJoMlwiLCB7IHRleHQ6IFwiQXNrIFdpdGggVmF1bHQgQ29udGV4dFwiIH0pO1xuXG4gICAgY29uc3QgaW5wdXQgPSBjb250ZW50RWwuY3JlYXRlRWwoXCJ0ZXh0YXJlYVwiLCB7XG4gICAgICBhdHRyOiB7IHBsYWNlaG9sZGVyOiBcIkFzayBhIHF1ZXN0aW9uIGFib3V0IHlvdXIgbm90ZXMuLi5cIiB9XG4gICAgfSk7XG5cbiAgICBjb25zdCBidXR0b24gPSBjb250ZW50RWwuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIkFza1wiIH0pO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMub25TdWJtaXQoaW5wdXQudmFsdWUpO1xuICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgICAgICAgbmV3IE5vdGljZShgUmVxdWVzdCBmYWlsZWQ6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgYnV0dG9uLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpbnB1dC5mb2N1cygpO1xuICB9XG5cbiAgb25DbG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRlbnRFbC5lbXB0eSgpO1xuICB9XG59XG5cbmNsYXNzIE1vZGVsU2VhcmNoTW9kYWwgZXh0ZW5kcyBNb2RhbCB7XG4gIHByaXZhdGUgcGx1Z2luOiBSYWdPcGVuUm91dGVyUGx1Z2luO1xuICBwcml2YXRlIG9uU2VsZWN0TW9kZWw6IChtb2RlbElkOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG4gIHByaXZhdGUgbW9kZWxzOiBPcGVuUm91dGVyTW9kZWxbXSA9IFtdO1xuICBwcml2YXRlIHF1ZXJ5ID0gXCJcIjtcbiAgcHJpdmF0ZSBzdGF0dXNFbCE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIGxpc3RFbCE6IEhUTUxFbGVtZW50O1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGFwcDogQXBwLFxuICAgIHBsdWdpbjogUmFnT3BlblJvdXRlclBsdWdpbixcbiAgICBvblNlbGVjdE1vZGVsOiAobW9kZWxJZDogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+XG4gICkge1xuICAgIHN1cGVyKGFwcCk7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gICAgdGhpcy5vblNlbGVjdE1vZGVsID0gb25TZWxlY3RNb2RlbDtcbiAgfVxuXG4gIG9uT3BlbigpOiB2b2lkIHtcbiAgICBjb25zdCB7IGNvbnRlbnRFbCB9ID0gdGhpcztcbiAgICBjb250ZW50RWwuZW1wdHkoKTtcbiAgICBjb250ZW50RWwuYWRkQ2xhc3MoXCJyYWctb3BlbnJvdXRlci1tb2RlbC1zZWFyY2gtbW9kYWxcIik7XG5cbiAgICBjb250ZW50RWwuY3JlYXRlRWwoXCJoMlwiLCB7IHRleHQ6IFwiU2VhcmNoIE9wZW5Sb3V0ZXIgTW9kZWxzXCIgfSk7XG5cbiAgICBjb25zdCBjb250cm9sc0VsID0gY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1tb2RlbC1zZWFyY2gtY29udHJvbHNcIiB9KTtcblxuICAgIGNvbnN0IGlucHV0ID0gY29udHJvbHNFbC5jcmVhdGVFbChcImlucHV0XCIsIHtcbiAgICAgIHR5cGU6IFwic2VhcmNoXCIsXG4gICAgICBwbGFjZWhvbGRlcjogXCJTZWFyY2ggbW9kZWwgaWQsIGZvciBleGFtcGxlIG52aWRpYS9uZW1vdHJvbi0zLXN1cGVyLTEyMGItYTEyYjpmcmVlXCJcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlZnJlc2hCdXR0b24gPSBjb250cm9sc0VsLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHsgdGV4dDogXCJSZWZyZXNoXCIgfSk7XG5cbiAgICB0aGlzLnN0YXR1c0VsID0gY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1tb2RlbC1zZWFyY2gtc3RhdHVzXCIgfSk7XG4gICAgdGhpcy5saXN0RWwgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiBcInJhZy1vcGVucm91dGVyLW1vZGVsLXNlYXJjaC1yZXN1bHRzXCIgfSk7XG5cbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKCkgPT4ge1xuICAgICAgdGhpcy5xdWVyeSA9IGlucHV0LnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgdGhpcy5yZW5kZXJNb2RlbExpc3QoKTtcbiAgICB9KTtcblxuICAgIHJlZnJlc2hCdXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMubG9hZE1vZGVscyh0cnVlKTtcbiAgICB9KTtcblxuICAgIHZvaWQgdGhpcy5sb2FkTW9kZWxzKGZhbHNlKTtcbiAgICBpbnB1dC5mb2N1cygpO1xuICB9XG5cbiAgb25DbG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRlbnRFbC5lbXB0eSgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsb2FkTW9kZWxzKGZvcmNlUmVmcmVzaDogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuc3RhdHVzRWwuc2V0VGV4dChcIkxvYWRpbmcgbW9kZWxzLi4uXCIpO1xuICAgIHRoaXMubGlzdEVsLmVtcHR5KCk7XG5cbiAgICB0cnkge1xuICAgICAgdGhpcy5tb2RlbHMgPSBhd2FpdCB0aGlzLnBsdWdpbi5nZXRPcGVuUm91dGVyTW9kZWxzKGZvcmNlUmVmcmVzaCk7XG4gICAgICB0aGlzLnJlbmRlck1vZGVsTGlzdCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiRmFpbGVkIHRvIGxvYWQgT3BlblJvdXRlciBtb2RlbHNcIiwgZXJyb3IpO1xuICAgICAgdGhpcy5zdGF0dXNFbC5zZXRUZXh0KFxuICAgICAgICBgRmFpbGVkIHRvIGxvYWQgbW9kZWxzOiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVyTW9kZWxMaXN0KCk6IHZvaWQge1xuICAgIHRoaXMubGlzdEVsLmVtcHR5KCk7XG5cbiAgICBjb25zdCBmaWx0ZXJlZE1vZGVscyA9IHRoaXMubW9kZWxzLmZpbHRlcigobW9kZWwpID0+IHtcbiAgICAgIGNvbnN0IG1vZGVsSWQgPSBtb2RlbC5pZC50b0xvd2VyQ2FzZSgpO1xuICAgICAgcmV0dXJuICF0aGlzLnF1ZXJ5IHx8IG1vZGVsSWQuaW5jbHVkZXModGhpcy5xdWVyeSk7XG4gICAgfSk7XG5cbiAgICB0aGlzLnN0YXR1c0VsLnNldFRleHQoYFNob3dpbmcgJHtmaWx0ZXJlZE1vZGVscy5sZW5ndGh9IG9mICR7dGhpcy5tb2RlbHMubGVuZ3RofSBtb2RlbHNgKTtcblxuICAgIGlmICghZmlsdGVyZWRNb2RlbHMubGVuZ3RoKSB7XG4gICAgICB0aGlzLmxpc3RFbC5jcmVhdGVEaXYoe1xuICAgICAgICBjbHM6IFwicmFnLW9wZW5yb3V0ZXItbW9kZWwtc2VhcmNoLWVtcHR5XCIsXG4gICAgICAgIHRleHQ6IFwiTm8gbW9kZWxzIG1hdGNoIHlvdXIgc2VhcmNoLlwiXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG1vZGVsIG9mIGZpbHRlcmVkTW9kZWxzLnNsaWNlKDAsIDIwMCkpIHtcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMubGlzdEVsLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHtcbiAgICAgICAgY2xzOiBcInJhZy1vcGVucm91dGVyLW1vZGVsLXJvd1wiXG4gICAgICB9KTtcblxuICAgICAgcm93LmNyZWF0ZURpdih7IGNsczogXCJyYWctb3BlbnJvdXRlci1tb2RlbC1pZFwiLCB0ZXh0OiBtb2RlbC5pZCB9KTtcblxuICAgICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5vblNlbGVjdE1vZGVsKG1vZGVsLmlkKTtcbiAgICAgICAgICBuZXcgTm90aWNlKGBTZWxlY3RlZCBtb2RlbDogJHttb2RlbC5pZH1gKTtcbiAgICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcIkZhaWxlZCB0byBzZXQgbW9kZWxcIiwgZXJyb3IpO1xuICAgICAgICAgIG5ldyBOb3RpY2UoYEZhaWxlZCB0byBzZXQgbW9kZWw6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuY2xhc3MgUmFnT3BlblJvdXRlclNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgcGx1Z2luOiBSYWdPcGVuUm91dGVyUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFJhZ09wZW5Sb3V0ZXJQbHVnaW4pIHtcbiAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBkaXNwbGF5KCk6IHZvaWQge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKFwiaDJcIiwgeyB0ZXh0OiBcIlJBRyBPcGVuUm91dGVyIE5vdGVzIFNldHRpbmdzXCIgfSk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiT3BlblJvdXRlciBBUEkga2V5XCIpXG4gICAgICAuc2V0RGVzYyhcIlVzZWQgdG8gY2FsbCBPcGVuUm91dGVyIGNoYXQgY29tcGxldGlvbiBBUEkuXCIpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcihcInNrLW9yLXYxLS4uLlwiKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vcGVuUm91dGVyQXBpS2V5KVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm9wZW5Sb3V0ZXJBcGlLZXkgPSB2YWx1ZS50cmltKCk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJNb2RlbFwiKVxuICAgICAgLnNldERlc2MoXCJPcGVuUm91dGVyIG1vZGVsIHNsdWcsIGZvciBleGFtcGxlIG9wZW5haS9ncHQtNG8tbWluaS5cIilcbiAgICAgIC5hZGRUZXh0KCh0ZXh0KSA9PlxuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKFwib3BlbmFpL2dwdC00by1taW5pXCIpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsID0gdmFsdWUudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MubW9kZWw7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmFkZEJ1dHRvbigoYnV0dG9uKSA9PlxuICAgICAgICBidXR0b24uc2V0QnV0dG9uVGV4dChcIlNlYXJjaFwiKS5vbkNsaWNrKCgpID0+IHtcbiAgICAgICAgICBuZXcgTW9kZWxTZWFyY2hNb2RhbCh0aGlzLmFwcCwgdGhpcy5wbHVnaW4sIGFzeW5jIChtb2RlbElkKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5tb2RlbCA9IG1vZGVsSWQ7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheSgpO1xuICAgICAgICAgIH0pLm9wZW4oKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiTWF4IHJldHJpZXZlZCBjaHVua3NcIilcbiAgICAgIC5zZXREZXNjKFwiTnVtYmVyIG9mIG5vdGUgY2h1bmtzIHNlbnQgYXMgY29udGV4dC5cIilcbiAgICAgIC5hZGRTbGlkZXIoKHNsaWRlcikgPT5cbiAgICAgICAgc2xpZGVyXG4gICAgICAgICAgLnNldExpbWl0cygxLCAxMiwgMSlcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MubWF4Q2h1bmtzKVxuICAgICAgICAgIC5zZXREeW5hbWljVG9vbHRpcCgpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MubWF4Q2h1bmtzID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJDaHVuayBzaXplXCIpXG4gICAgICAuc2V0RGVzYyhcIkFwcHJveGltYXRlIG51bWJlciBvZiBjaGFyYWN0ZXJzIHBlciBpbmRleGVkIGNodW5rLlwiKVxuICAgICAgLmFkZFNsaWRlcigoc2xpZGVyKSA9PlxuICAgICAgICBzbGlkZXJcbiAgICAgICAgICAuc2V0TGltaXRzKDMwMCwgMjAwMCwgNTApXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmNodW5rU2l6ZSlcbiAgICAgICAgICAuc2V0RHluYW1pY1Rvb2x0aXAoKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmNodW5rU2l6ZSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiQW5zd2VyIGZvbGRlclwiKVxuICAgICAgLnNldERlc2MoXCJGb2xkZXIgd2hlcmUgZ2VuZXJhdGVkIGFuc3dlciBub3RlcyBhcmUgc3RvcmVkLlwiKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+XG4gICAgICAgIHRleHRcbiAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoXCJSQUcgQW5zd2Vyc1wiKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5hbnN3ZXJGb2xkZXIpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuYW5zd2VyRm9sZGVyID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiQ2l0YXRpb24gc3R5bGVcIilcbiAgICAgIC5zZXREZXNjKFwiSG93IGNpdGF0aW9ucyBhcHBlYXIgaW4gYXNzaXN0YW50IGFuc3dlcnMuXCIpXG4gICAgICAuYWRkRHJvcGRvd24oKGRyb3Bkb3duKSA9PlxuICAgICAgICBkcm9wZG93blxuICAgICAgICAgIC5hZGRPcHRpb24oXCJwaHJhc2VcIiwgXCJQaHJhc2UgbGlua3NcIilcbiAgICAgICAgICAuYWRkT3B0aW9uKFwic291cmNlXCIsIFwiU291cmNlIGxpbmtzXCIpXG4gICAgICAgICAgLmFkZE9wdGlvbihcImZvb3RlclwiLCBcIkZvb3RlciBvbmx5XCIpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmNpdGF0aW9uU3R5bGUpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZTogXCJwaHJhc2VcIiB8IFwic291cmNlXCIgfCBcImZvb3RlclwiKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5jaXRhdGlvblN0eWxlID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJUaGlua2luZyB2aWV3XCIpXG4gICAgICAuc2V0RGVzYyhcIkhvdyBtb2RlbCB0aGlua2luZyBpcyBkaXNwbGF5ZWQgaW4gY2hhdCBhbnN3ZXJzLlwiKVxuICAgICAgLmFkZERyb3Bkb3duKChkcm9wZG93bikgPT5cbiAgICAgICAgZHJvcGRvd25cbiAgICAgICAgICAuYWRkT3B0aW9uKFwiY29sbGFwc2VkXCIsIFwiQ29sbGFwc2VkXCIpXG4gICAgICAgICAgLmFkZE9wdGlvbihcImV4cGFuZGVkXCIsIFwiRXhwYW5kZWRcIilcbiAgICAgICAgICAuYWRkT3B0aW9uKFwiaGlkZGVuXCIsIFwiSGlkZGVuXCIpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnRoaW5raW5nVmlldylcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlOiBcImNvbGxhcHNlZFwiIHwgXCJleHBhbmRlZFwiIHwgXCJoaWRkZW5cIikgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudGhpbmtpbmdWaWV3ID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJSZS1pbmRleCBub3Rlc1wiKVxuICAgICAgLnNldERlc2MoXCJSdW4gaW5kZXhpbmcgYWZ0ZXIgY2hhbmdpbmcgY2h1bmsgc2V0dGluZ3Mgb3Igbm90ZSBjb250ZW50LlwiKVxuICAgICAgLmFkZEJ1dHRvbigoYnV0dG9uKSA9PlxuICAgICAgICBidXR0b24uc2V0QnV0dG9uVGV4dChcIlJlYnVpbGQgaW5kZXhcIikub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4ucmVidWlsZEluZGV4KCk7XG4gICAgICAgIH0pXG4gICAgICApO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLHNCQWFPO0FBK0VQLElBQU0sbUJBQWdEO0FBQUEsRUFDcEQsa0JBQWtCO0FBQUEsRUFDbEIsT0FBTztBQUFBLEVBQ1AsV0FBVztBQUFBLEVBQ1gsV0FBVztBQUFBLEVBQ1gsY0FBYztBQUFBLEVBQ2QsZUFBZTtBQUFBLEVBQ2YsY0FBYztBQUNoQjtBQUVBLElBQU0scUJBQXFCO0FBRTNCLElBQXFCLHNCQUFyQixjQUFpRCx1QkFBTztBQUFBLEVBQXhEO0FBQUE7QUFFRSxxQkFBeUIsQ0FBQztBQUMxQiwrQkFBOEMsQ0FBQztBQUMvQywwQkFBeUI7QUFDekIsU0FBUSxhQUFnQyxDQUFDO0FBQ3pDLFNBQVEsc0JBQXNCO0FBQUE7QUFBQSxFQUU5QixNQUFNLFNBQXdCO0FBQzVCLFVBQU0sS0FBSyxhQUFhO0FBRXhCLFNBQUs7QUFBQSxNQUNIO0FBQUEsTUFDQSxDQUFDLFNBQVMsSUFBSSxtQkFBbUIsTUFBTSxJQUFJO0FBQUEsSUFDN0M7QUFFQSxTQUFLLGNBQWMsSUFBSSx3QkFBd0IsS0FBSyxLQUFLLElBQUksQ0FBQztBQUU5RCxTQUFLLFdBQVc7QUFBQSxNQUNkLElBQUk7QUFBQSxNQUNKLE1BQU07QUFBQSxNQUNOLFVBQVUsWUFBWTtBQUNwQixjQUFNLEtBQUssYUFBYTtBQUFBLE1BQzFCO0FBQUEsSUFDRixDQUFDO0FBRUQsU0FBSyxXQUFXO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixVQUFVLE1BQU07QUFDZCxZQUFJLGlCQUFpQixLQUFLLEtBQUssT0FBTyxhQUFhO0FBQ2pELGdCQUFN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Q3BCLFFBQVEsZUFBZSxFQUN2QixRQUFRLGtEQUFrRCxFQUMxRDtBQUFBLE1BQVksQ0FBQyxhQUNaLFNBQ0csVUFBVSxhQUFhLFdBQVcsRUFDbEMsVUFBVSxZQUFZLFVBQVUsRUFDaEMsVUFBVSxVQUFVLFFBQVEsRUFDNUIsU0FBUyxLQUFLLE9BQU8sU0FBUyxZQUFZLEVBQzFDLFNBQVMsT0FBTyxVQUErQztBQUM5RCxhQUFLLE9BQU8sU0FBUyxlQUFlO0FBQ3BDLGNBQU0sS0FBSyxPQUFPLGFBQWE7QUFBQSxNQUNqQyxDQUFDO0FBQUEsSUFDTDtBQUVGLFFBQUksd0JBQVEsV0FBVyxFQUNwQixRQUFRLGdCQUFnQixFQUN4QixRQUFRLDZEQUE2RCxFQUNyRTtBQUFBLE1BQVUsQ0FBQyxXQUNWLE9BQU8sY0FBYyxlQUFlLEVBQUUsUUFBUSxZQUFZO0FBQ3hELGNBQU0sS0FBSyxPQUFPLGFBQWE7QUFBQSxNQUNqQyxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0o7QUFDRjsiLAogICJuYW1lcyI6IFsiZXhpc3RpbmciLCAiZm9sZGVyUGF0aCJdCn0K
