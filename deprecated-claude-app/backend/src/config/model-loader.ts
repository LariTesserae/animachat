import { readFile } from 'fs/promises';
import { join } from 'path';
import { Model, UserDefinedModel } from '@deprecated-claude/shared';
import type { Database } from '../database/index.js';

export class ModelLoader {
  private static instance: ModelLoader;
  private models: Model[] | null = null;
  private modelConfigPath: string;
  private db: Database | null = null;

  private constructor() {
    // Look for models config in these locations (in order):
    // 1. Environment variable MODELS_CONFIG_PATH
    // 2. Same directory as main config
    this.modelConfigPath = process.env.MODELS_CONFIG_PATH || 
      (process.env.NODE_ENV === 'production' 
        ? '/etc/claude-app/models.json'
        : join(process.cwd(), 'config', 'models.json'));
  }

  static getInstance(): ModelLoader {
    if (!ModelLoader.instance) {
      ModelLoader.instance = new ModelLoader();
    }
    return ModelLoader.instance;
  }

  setDatabase(db: Database): void {
    this.db = db;
  }

  /**
   * Overlay file for models added at runtime (admin "Census" panel).
   * Kept beside models.json but NOT shipped by CI, so additions made on the
   * server survive a deploy that overwrites models.json from the repo.
   */
  get localModelsPath(): string {
    return process.env.MODELS_LOCAL_CONFIG_PATH ||
      this.modelConfigPath.replace(/models\.json$/, 'models.local.json');
  }

  private async readLocalFile(): Promise<{ models: Model[]; overrides: Record<string, Partial<Model>> }> {
    try {
      const data = await readFile(this.localModelsPath, 'utf-8');
      const parsed = JSON.parse(data);
      return { models: parsed.models || [], overrides: parsed.overrides || {} };
    } catch {
      return { models: [], overrides: {} };
    }
  }

  private async writeLocalFile(local: { models: Model[]; overrides: Record<string, Partial<Model>> }): Promise<void> {
    const { writeFile } = await import('fs/promises');
    await writeFile(this.localModelsPath, JSON.stringify(local, null, 2), 'utf-8');
  }

  async loadLocalModels(): Promise<Model[]> {
    return (await this.readLocalFile()).models;
  }

  /** Per-model overrides (today: hidden) that survive a deploy. Models are
   *  never removed from models.json: participants in existing conversations
   *  are identified by model id. */
  async loadLocalOverrides(): Promise<Record<string, Partial<Model>>> {
    return (await this.readLocalFile()).overrides;
  }

  async setLocalOverride(id: string, patch: Partial<Model>): Promise<void> {
    const local = await this.readLocalFile();
    local.overrides[id] = { ...(local.overrides[id] || {}), ...patch };
    await this.writeLocalFile(local);
    await this.reloadModels();
  }

  async loadModels(): Promise<Model[]> {
    if (this.models) {
      return this.models;
    }

    try {
      const modelsData = await readFile(this.modelConfigPath, 'utf-8');
      const parsed = JSON.parse(modelsData);
      const base: Model[] = parsed.models || [];
      const { models: local, overrides } = await this.readLocalFile();
      const seen = new Set(base.map(m => m.id));
      const merged = base.map(m => overrides[m.id] ? { ...m, ...overrides[m.id] } : m);
      for (const m of local) {
        if (seen.has(m.id)) {
          console.warn(`models.local.json: id ${m.id} already in models.json — overlay entry ignored`);
          continue;
        }
        seen.add(m.id);
        merged.push(m);
      }
      this.models = merged;
      console.log(`Loaded ${base.length} models from ${this.modelConfigPath}` +
        (local.length ? ` + ${local.length} local from ${this.localModelsPath}` : ''));
      return this.models || [];
    } catch (error) {
      console.error(`Failed to load models from ${this.modelConfigPath}:`, error);
      // Return empty array as fallback
      return [];
    }
  }

  /** Append models to the overlay file and reload. Returns the ids added. */
  async addLocalModels(entries: Model[]): Promise<string[]> {
    const existing = await this.loadModels();
    const ids = new Set(existing.map(m => m.id));
    const local = await this.readLocalFile();
    const added: string[] = [];
    for (const e of entries) {
      if (ids.has(e.id)) continue;
      local.models.push(e);
      ids.add(e.id);
      added.push(e.id);
    }
    await this.writeLocalFile(local);
    await this.reloadModels();
    return added;
  }

  /** Remove a model from the overlay file (models.json entries are never
   *  removed — see loadLocalOverrides). */
  async removeLocalModel(id: string): Promise<boolean> {
    const local = await this.readLocalFile();
    const next = local.models.filter(m => m.id !== id);
    if (next.length === local.models.length) return false;
    local.models = next;
    await this.writeLocalFile(local);
    await this.reloadModels();
    return true;
  }

  /**
   * Get all available models, including user-defined models if userId provided
   */
  async getAllModels(userId?: string): Promise<Model[]> {
    const systemModels = await this.loadModels();
    
    if (!userId || !this.db) {
      return systemModels;
    }

    // Get user's custom models and convert to Model format
    const userModels = await this.db.getUserModels(userId);
    const userModelsAsModels: Model[] = userModels.map((um: UserDefinedModel) => ({
      id: um.id,
      providerModelId: um.providerModelId,
      displayName: um.displayName,
      shortName: um.shortName,
      provider: um.provider,
      hidden: um.hidden,
      contextWindow: um.contextWindow,
      outputTokenLimit: um.outputTokenLimit,
      supportsThinking: um.supportsThinking,
      // User-defined models always accept general credits
      currencies: { credit: true },
      // Include auto-detected capabilities
      capabilities: um.capabilities,
      settings: {
        temperature: {
          min: 0,
          max: 2,
          default: um.settings.temperature,
          step: 0.1
        },
        maxTokens: {
          min: 1,
          max: um.outputTokenLimit,
          default: um.settings.maxTokens
        },
        topP: um.settings.topP ? {
          min: 0,
          max: 1,
          default: um.settings.topP,
          step: 0.01
        } : undefined,
        topK: um.settings.topK ? {
          min: 1,
          max: 500,
          default: um.settings.topK,
          step: 1
        } : undefined
      },
      // Preserve customEndpoint for OpenAI-compatible models
      ...(um.customEndpoint ? { customEndpoint: um.customEndpoint } : {})
    } as Model));

    return [...systemModels, ...userModelsAsModels];
  }

  /**
   * Get models for a specific provider
   */
  async getModelsByProvider(provider: string): Promise<Model[]> {
    const models = await this.loadModels();
    return models.filter(m => m.provider === provider);
  }

  /**
   * Get a specific model by ID (checks both system and user models)
   */
  async getModelById(modelId: string, userId?: string): Promise<Model | null> {
    const models = await this.getAllModels(userId);
    return models.find(m => m.id === modelId) || null;
  }

  /**
   * Check if a model exists and get its provider
   */
  async getModelProvider(modelId: string): Promise<string | null> {
    const model = await this.getModelById(modelId);
    return model?.provider || null;
  }

  /**
   * Reload models from disk
   */
  async reloadModels(): Promise<void> {
    this.models = null;
    await this.loadModels();
  }
}
