import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { Database } from '../database/index.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { ConfigLoader } from '../config/loader.js';
import { ModelLoader } from '../config/model-loader.js';

// Admin-only middleware - checks for admin capability
function requireAdmin(db: Database) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const isAdmin = await db.userHasActiveGrantCapability(req.userId, 'admin');
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  };
}

const GrantCapabilitySchema = z.object({
  capability: z.enum(['admin', 'mint', 'send', 'overspend', 'researcher']),
  action: z.enum(['grant', 'revoke'])
});

const GrantCreditsSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(1).max(50),
  reason: z.string().max(200).optional()
});

export interface UserWithStats {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  lastActive?: string;
  conversationCount: number;
  messageCount: number;
  capabilities: string[];
  balances: Record<string, number>;
}

export function adminRouter(db: Database): Router {
  const router = Router();

  // All admin routes require authentication + admin capability
  router.use(authenticateToken);
  router.use(requireAdmin(db));

  // GET /admin/users - List all users with stats
  router.get('/users', async (req: AuthRequest, res) => {
    try {
      const users = await db.getAllUsersWithStats();
      res.json({ users });
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // GET /admin/users/:id - Get detailed user info
  router.get('/users/:id', async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const user = await db.getUserById(id);
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const stats = await db.getUserStats(id);
      const grantSummary = await db.getUserGrantSummary(id);

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt
        },
        stats,
        grants: grantSummary
      });
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  // POST /admin/users/:id/capabilities - Grant or revoke a capability
  router.post('/users/:id/capabilities', async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const { capability, action } = GrantCapabilitySchema.parse(req.body);

      const user = await db.getUserById(id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      await db.recordGrantCapability({
        id: uuidv4(),
        time: new Date().toISOString(),
        userId: id,
        action: action === 'grant' ? 'granted' : 'revoked',
        capability: capability as any,
        grantedByUserId: req.userId!
      });

      // Invalidate user cache so changes take effect immediately
      await db.invalidateUserCache(id);

      res.json({ 
        success: true, 
        message: `Capability '${capability}' ${action}ed for user ${user.email}` 
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid request', details: error.errors });
      }
      console.error('Error updating capability:', error);
      res.status(500).json({ error: 'Failed to update capability' });
    }
  });

  // POST /admin/users/:id/credits - Grant credits to a user
  router.post('/users/:id/credits', async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const { amount, currency, reason } = GrantCreditsSchema.parse(req.body);

      const user = await db.getUserById(id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      await db.recordGrantInfo({
        id: uuidv4(),
        time: new Date().toISOString(),
        type: 'mint',
        amount,
        toUserId: id,
        reason: reason || `Admin grant by ${req.userId}`,
        currency
      });

      res.json({ 
        success: true, 
        message: `Granted ${amount} ${currency} to ${user.email}` 
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid request', details: error.errors });
      }
      console.error('Error granting credits:', error);
      res.status(500).json({ error: 'Failed to grant credits' });
    }
  });

  // POST /admin/users/:id/reload - Force reload user data from disk
  router.post('/users/:id/reload', async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      
      const user = await db.getUserById(id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      await db.invalidateUserCache(id);
      
      res.json({ 
        success: true, 
        message: `Reloaded user data for ${user.email}` 
      });
    } catch (error) {
      console.error('Error reloading user:', error);
      res.status(500).json({ error: 'Failed to reload user' });
    }
  });

  // GET /admin/stats - Get system-wide statistics
  router.get('/stats', async (req: AuthRequest, res) => {
    try {
      const stats = await db.getSystemStats();
      res.json(stats);
    } catch (error) {
      console.error('Error fetching system stats:', error);
      res.status(500).json({ error: 'Failed to fetch system stats' });
    }
  });

  // GET /admin/usage/user/:id - Get token usage stats for a specific user
  router.get('/usage/user/:id', async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const days = parseInt(req.query.days as string) || 30;
      
      const user = await db.getUserById(id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const usage = await db.getUserUsageStats(id, days);
      res.json(usage);
    } catch (error) {
      console.error('Error fetching user usage:', error);
      res.status(500).json({ error: 'Failed to fetch user usage stats' });
    }
  });

  // GET /admin/usage/system - Get system-wide token usage stats
  router.get('/usage/system', async (req: AuthRequest, res) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const usage = await db.getSystemUsageStats(days);
      res.json(usage);
    } catch (error) {
      console.error('Error fetching system usage:', error);
      res.status(500).json({ error: 'Failed to fetch system usage stats' });
    }
  });

  // GET /admin/usage/model/:modelId - Get usage stats for a specific model
  router.get('/usage/model/:modelId', async (req: AuthRequest, res) => {
    try {
      const { modelId } = req.params;
      const days = parseInt(req.query.days as string) || 30;
      const usage = await db.getModelUsageStats(modelId, days);
      res.json(usage);
    } catch (error) {
      console.error('Error fetching model usage:', error);
      res.status(500).json({ error: 'Failed to fetch model usage stats' });
    }
  });

  // ============================================================================
  // Config Management Routes
  // ============================================================================

  const configPath = process.env.CONFIG_PATH || 
    (process.env.NODE_ENV === 'production' 
      ? '/etc/claude-app/config.json'
      : './config/config.json');

  // GET /admin/config - Get editable config (sanitized - no API keys)
  router.get('/config', async (req: AuthRequest, res) => {
    try {
      const configData = await readFile(configPath, 'utf-8');
      const config = JSON.parse(configData);
      
      // Return only the editable parts, sanitize API keys
      const sanitizedProviders: Record<string, any[]> = {};
      for (const [provider, profiles] of Object.entries(config.providers || {})) {
        sanitizedProviders[provider] = (profiles as any[]).map(profile => ({
          id: profile.id,
          name: profile.name,
          description: profile.description,
          priority: profile.priority,
          modelCosts: profile.modelCosts || [],
          allowedModels: profile.allowedModels,
          // Don't include credentials!
        }));
      }

      res.json({
        providers: sanitizedProviders,
        defaultModel: config.defaultModel,
        groupChatSuggestedModels: config.groupChatSuggestedModels || [],
        initialGrants: config.initialGrants || {},
        currencies: config.currencies || {}
      });
    } catch (error) {
      console.error('Error reading config:', error);
      res.status(500).json({ error: 'Failed to read config' });
    }
  });

  // GET /admin/models - Get all available models for reference
  router.get('/models', async (req: AuthRequest, res) => {
    try {
      const modelLoader = ModelLoader.getInstance();
      const models = await modelLoader.loadModels();
      res.json({ models: models.map(m => ({
        id: m.id,
        providerModelId: m.providerModelId,
        displayName: m.displayName,
        provider: m.provider,
        hidden: m.hidden
      }))});
    } catch (error) {
      console.error('Error fetching models:', error);
      res.status(500).json({ error: 'Failed to fetch models' });
    }
  });

  // PATCH /admin/models/:modelId/visibility - Update model visibility
  router.patch('/models/:modelId/visibility', async (req: AuthRequest, res) => {
    try {
      const { modelId } = req.params;
      const { hidden } = req.body;

      if (typeof hidden !== 'boolean') {
        return res.status(400).json({ error: 'hidden must be a boolean' });
      }

      // Read models.json
      const modelsPath = process.env.MODELS_CONFIG_PATH || 
        (process.env.NODE_ENV === 'production' 
          ? '/etc/claude-app/models.json'
          : join(process.cwd(), 'config', 'models.json'));
      
      const modelsData = await readFile(modelsPath, 'utf-8');
      const modelsConfig = JSON.parse(modelsData);

      // Find and update the model
      const modelIndex = modelsConfig.models.findIndex((m: any) => m.id === modelId);
      if (modelIndex === -1) {
        return res.status(404).json({ error: 'Model not found' });
      }

      modelsConfig.models[modelIndex].hidden = hidden;

      // Write back
      await writeFile(modelsPath, JSON.stringify(modelsConfig, null, 2), 'utf-8');

      // Reload models in memory
      const modelLoader = ModelLoader.getInstance();
      await modelLoader.reloadModels();

      res.json({ success: true, modelId, hidden });
    } catch (error) {
      console.error('Error updating model visibility:', error);
      res.status(500).json({ error: 'Failed to update model visibility' });
    }
  });

  // PATCH /admin/config - Update specific config fields
  router.patch('/config', async (req: AuthRequest, res) => {
    try {
      const { 
        defaultModel, 
        groupChatSuggestedModels, 
        initialGrants,
        providerModelCosts // { providerId: profileId, modelCosts: [...] }
      } = req.body;

      // Read current config
      const configData = await readFile(configPath, 'utf-8');
      const config = JSON.parse(configData);

      // Update fields if provided
      if (defaultModel !== undefined) {
        config.defaultModel = defaultModel;
      }

      if (groupChatSuggestedModels !== undefined) {
        config.groupChatSuggestedModels = groupChatSuggestedModels;
      }

      if (initialGrants !== undefined) {
        config.initialGrants = initialGrants;
      }

      // Update model costs for a specific provider profile
      if (providerModelCosts) {
        const { provider, profileId, modelCosts } = providerModelCosts;
        const profiles = config.providers[provider];
        if (profiles) {
          const profile = profiles.find((p: any) => p.id === profileId);
          if (profile) {
            profile.modelCosts = modelCosts;
          }
        }
      }

      // Write back to file
      await writeFile(configPath, JSON.stringify(config, null, 2));

      // Reload config in memory
      const configLoader = ConfigLoader.getInstance();
      await configLoader.reloadConfig();

      res.json({ success: true, message: 'Config updated and reloaded' });
    } catch (error) {
      console.error('Error updating config:', error);
      res.status(500).json({ error: 'Failed to update config' });
    }
  });

  // ---- Census: add models from the model census beacon ------------------
  // The census (a separate service) publishes every model it can see, with
  // per-provider "doors" and a probe verdict. This panel diffs that list
  // against the models this app already serves and lets an admin add the
  // missing ones as system models (written to models.local.json, which a
  // deploy does not overwrite).
  const CENSUS_URL = process.env.CENSUS_BEACON_URL ||
    'https://census-production-e5bd.up.railway.app/api/v2/models.json';
  const CENSUS_SOURCE_TO_PROVIDER: Record<string, string> = {
    anthropic_direct: 'anthropic',
    openrouter: 'openrouter',
    bedrock_foundation_models: 'bedrock',
  };
  let censusCache: { at: number; data: any } | null = null;

  async function fetchCensus(): Promise<any> {
    if (censusCache && Date.now() - censusCache.at < 10 * 60 * 1000) return censusCache.data;
    const r = await fetch(CENSUS_URL, { headers: { 'User-Agent': 'arc-chat-admin/1' } });
    if (!r.ok) throw new Error(`census beacon ${r.status}`);
    const data = await r.json();
    censusCache = { at: Date.now(), data };
    return data;
  }

  const slug = (s: string) => s.toLowerCase().replace(/^anthropic\//, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  const stripRegion = (s: string) => s.replace(/^(us|eu|apac|global)\./, '');

  // GET /admin/census - census minds with a callable door on a provider we
  // speak, marked with which legs already exist here
  router.get('/census', async (req: AuthRequest, res) => {
    try {
      const census = await fetchCensus();
      const have = await ModelLoader.getInstance().loadModels();
      const byLeg = new Map<string, string>(); // provider|providerModelId -> model id
      for (const m of have) {
        byLeg.set(`${m.provider}|${stripRegion(m.providerModelId).toLowerCase()}`, m.id);
      }
      const out: any[] = [];
      for (const [mindId, m] of Object.entries<any>(census.models || {})) {
        const legs: any[] = [];
        for (const d of m.doors || []) {
          const provider = CENSUS_SOURCE_TO_PROVIDER[d.source];
          if (!provider || !d.listed_now) continue;
          if (/:batch$/.test(d.id)) continue;
          const ping = d.ping || {};
          legs.push({
            provider,
            providerModelId: d.id,
            regions: d.regions || null,
            maxOut: d.max_out || null,
            state: ping.state || null,
            existingId: byLeg.get(`${provider}|${stripRegion(d.id).toLowerCase()}`) || null,
          });
        }
        if (!legs.length) continue;
        out.push({
          mindId,
          display: m.display,
          role: m.role || null,
          io: m.io || null,
          reach: m.reach || null,
          firstSeen: m.first_seen || null,
          legs,
          anyExisting: legs.some(l => l.existingId),
          allExisting: legs.every(l => l.existingId),
        });
      }
      out.sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || ''));

      // Served legs the census cannot see any more: door gone from its catalog,
      // or probed dead. Never deleted (conversation participants reference
      // these ids) — the admin can hide them.
      const doorIndex = new Map<string, any>();
      for (const m of Object.values<any>(census.models || {})) {
        for (const d of m.doors || []) {
          const provider = CENSUS_SOURCE_TO_PROVIDER[d.source];
          if (provider) doorIndex.set(`${provider}|${stripRegion(d.id).toLowerCase()}`, d);
        }
      }
      const stale: any[] = [];
      for (const m of have) {
        if (!['anthropic', 'openrouter', 'bedrock'].includes(m.provider)) continue;
        const d = doorIndex.get(`${m.provider}|${stripRegion(m.providerModelId).toLowerCase()}`);
        let why: string | null = null;
        if (!d) why = 'door never seen by the census (scans since 2026-06-24)';
        else if (!d.listed_now) why = `not listed now (last seen ${(d.last_seen || '').slice(0, 10)})`;
        else if ((d.ping || {}).state === 'dead') why = 'listed but probe hard-fails';
        if (why) stale.push({ id: m.id, provider: m.provider, providerModelId: m.providerModelId,
                              displayName: m.displayName, hidden: m.hidden, why });
      }
      res.json({ source: CENSUS_URL, generatedAt: census.generated_at, minds: out, stale });
    } catch (error) {
      console.error('Error reading census:', error);
      res.status(502).json({ error: `Census beacon unavailable: ${(error as Error).message}` });
    }
  });

  const ImportSchema = z.object({
    items: z.array(z.object({
      mindId: z.string(),
      provider: z.enum(['anthropic', 'openrouter', 'bedrock']),
      providerModelId: z.string().min(1),
      displayName: z.string().optional(),
      shortName: z.string().optional(),
      currencies: z.record(z.boolean()).optional(),
      contextWindow: z.number().optional(),
      outputTokenLimit: z.number().optional(),
    })).min(1),
  });

  // POST /admin/models/import - add census legs as system models (overlay file)
  router.post('/models/import', async (req: AuthRequest, res) => {
    try {
      const { items } = ImportSchema.parse(req.body);
      const census = await fetchCensus();
      const entries: any[] = [];
      for (const it of items) {
        const mind = (census.models || {})[it.mindId] || {};
        const door = (mind.doors || []).find((d: any) => d.id === it.providerModelId) || {};
        const display = it.displayName || mind.display || it.providerModelId;
        const canonicalId = slug(mind.display || it.providerModelId);
        const isAnthropic = it.provider === 'anthropic';
        const id = isAnthropic ? canonicalId : `${canonicalId}-${it.provider}`;
        const outputTokenLimit = it.outputTokenLimit || door.max_out || 8192;
        const io = mind.io || { in: [], out: [] };
        entries.push({
          id,
          providerModelId: it.providerModelId,
          canonicalId,
          displayName: isAnthropic ? display : `${display} (${it.provider === 'openrouter' ? 'OpenRouter' : 'Bedrock'})`,
          shortName: it.shortName || display.split('/').pop(),
          provider: it.provider,
          hidden: false,
          contextWindow: it.contextWindow || 128000,
          outputTokenLimit,
          supportsPrefill: false,
          capabilities: {
            imageInput: (io.in || []).includes('image'),
            pdfInput: (io.in || []).includes('file') || (io.in || []).includes('pdf'),
            audioInput: (io.in || []).includes('audio'),
            videoInput: (io.in || []).includes('video'),
          },
          currencies: it.currencies || { 'models-2025': true, credit: true },
          settings: {
            temperature: { min: 0, max: isAnthropic ? 1 : 2, default: 1, step: 0.1 },
            maxTokens: { min: 1, max: outputTokenLimit, default: Math.min(8096, outputTokenLimit) },
            topP: { min: 0, max: 1, default: 1, step: 0.01 },
          },
          censusMindId: it.mindId,
          censusAddedAt: new Date().toISOString(),
        });
      }
      const added = await ModelLoader.getInstance().addLocalModels(entries);
      res.json({ added, skipped: entries.map(e => e.id).filter(i => !added.includes(i)) });
    } catch (error) {
      console.error('Error importing census models:', error);
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // POST /admin/models/local/override - per-model override kept in the overlay
  // (survives deploys, unlike PATCH /models/:id/visibility which edits models.json)
  router.post('/models/local/override', async (req: AuthRequest, res) => {
    try {
      const { id, hidden } = z.object({ id: z.string(), hidden: z.boolean() }).parse(req.body);
      await ModelLoader.getInstance().setLocalOverride(id, { hidden });
      res.json({ success: true, id, hidden });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // GET /admin/models/local - models living in the overlay file
  router.get('/models/local', async (req: AuthRequest, res) => {
    const local = await ModelLoader.getInstance().loadLocalModels();
    res.json({ path: ModelLoader.getInstance().localModelsPath, models: local });
  });

  // DELETE /admin/models/local/:id - remove an overlay model
  router.delete('/models/local/:id', async (req: AuthRequest, res) => {
    const ok = await ModelLoader.getInstance().removeLocalModel(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not a local model' });
    res.json({ success: true });
  });

  // POST /admin/config/reload - Reload config from disk without changes
  router.post('/config/reload', async (req: AuthRequest, res) => {
    try {
      const configLoader = ConfigLoader.getInstance();
      await configLoader.reloadConfig();
      
      const modelLoader = ModelLoader.getInstance();
      await modelLoader.reloadModels();

      res.json({ success: true, message: 'Config and models reloaded from disk' });
    } catch (error) {
      console.error('Error reloading config:', error);
      res.status(500).json({ error: 'Failed to reload config' });
    }
  });

  // POST /admin/verify-legacy-users - Verify emails for all users registered before a date
  // This is a temporary endpoint for migrating pre-email-verification users
  router.post('/verify-legacy-users', async (req: AuthRequest, res) => {
    try {
      const beforeDate = req.body.beforeDate ? new Date(req.body.beforeDate) : new Date('2025-12-08T00:00:00Z');
      
      const users = await db.getAllUsers();
      console.log(`[Admin] verify-legacy-users: Found ${users.length} total users, checking against date ${beforeDate.toISOString()}`);
      
      let verifiedCount = 0;
      const verifiedUsers: string[] = [];
      const skippedUsers: { email: string; reason: string }[] = [];
      
      for (const user of users) {
        const createdAt = user.createdAt instanceof Date ? user.createdAt : new Date(user.createdAt);
        
        if (createdAt >= beforeDate) {
          skippedUsers.push({ email: user.email, reason: `created ${createdAt.toISOString()} >= ${beforeDate.toISOString()}` });
        } else if (user.emailVerified) {
          skippedUsers.push({ email: user.email, reason: 'already verified' });
        } else {
          await db.verifyUserManually(user.id);
          verifiedCount++;
          verifiedUsers.push(user.email);
        }
      }
      
      console.log(`[Admin] verify-legacy-users: Verified ${verifiedCount}, skipped:`, skippedUsers);
      
      res.json({ 
        success: true, 
        message: `Verified ${verifiedCount} legacy user${verifiedCount !== 1 ? 's' : ''}`,
        verifiedUsers,
        debug: { totalUsers: users.length, skipped: skippedUsers }
      });
    } catch (error) {
      console.error('Error verifying legacy users:', error);
      res.status(500).json({ error: 'Failed to verify legacy users' });
    }
  });

  // POST /admin/set-all-age-verified - Set age verified flag for all users
  // For migrating users who registered before age gate was added
  router.post('/set-all-age-verified', async (req: AuthRequest, res) => {
    try {
      const users = await db.getAllUsers();
      console.log(`[Admin] set-all-age-verified: Found ${users.length} total users`);
      
      let updatedCount = 0;
      const updatedUsers: string[] = [];
      
      for (const user of users) {
        if (!user.ageVerified) {
          await db.setAgeVerified(user.id);
          updatedCount++;
          updatedUsers.push(user.email);
        }
      }
      
      console.log(`[Admin] set-all-age-verified: Updated ${updatedCount} users`);
      
      res.json({ 
        success: true, 
        message: `Set age verified for ${updatedCount} user${updatedCount !== 1 ? 's' : ''}`,
        updatedCount,
        updatedUsers
      });
    } catch (error) {
      console.error('Error setting age verified:', error);
      res.status(500).json({ error: 'Failed to set age verified' });
    }
  });

  // POST /admin/set-all-tos-accepted - Set ToS accepted flag for all users
  // For migrating users who registered before ToS gate was added
  router.post('/set-all-tos-accepted', async (req: AuthRequest, res) => {
    try {
      const users = await db.getAllUsers();
      console.log(`[Admin] set-all-tos-accepted: Found ${users.length} total users`);
      
      let updatedCount = 0;
      const updatedUsers: string[] = [];
      
      for (const user of users) {
        if (!user.tosAccepted) {
          await db.setTosAccepted(user.id);
          updatedCount++;
          updatedUsers.push(user.email);
        }
      }
      
      console.log(`[Admin] set-all-tos-accepted: Updated ${updatedCount} users`);
      
      res.json({ 
        success: true, 
        message: `Set ToS accepted for ${updatedCount} user${updatedCount !== 1 ? 's' : ''}`,
        updatedCount,
        updatedUsers
      });
    } catch (error) {
      console.error('Error setting ToS accepted:', error);
      res.status(500).json({ error: 'Failed to set ToS accepted' });
    }
  });

  // GET /admin/conversation-size/:id - Get conversation data size for debugging
  // Useful for diagnosing browser crashes from large images
  router.get('/conversation-size/:id', async (req: AuthRequest, res) => {
    try {
      const conversationId = req.params.id;
      
      // Get conversation data as admin (bypass normal access control for diagnosis)
      const messages = await db.getConversationMessagesAdmin(conversationId);
      
      if (!messages || messages.length === 0) {
        return res.status(404).json({ error: 'Conversation not found or no messages' });
      }
      
      // Analyze size
      let totalContentLength = 0;
      let totalImageDataLength = 0;
      let imageCount = 0;
      const messageStats: any[] = [];
      
      for (const message of messages) {
        for (const branch of message.branches) {
          totalContentLength += branch.content?.length || 0;
          
          if (branch.contentBlocks) {
            for (const block of branch.contentBlocks) {
              if ((block as any).type === 'image' && (block as any).data) {
                imageCount++;
                const dataLen = (block as any).data.length;
                totalImageDataLength += dataLen;
                messageStats.push({
                  messageId: message.id.slice(0, 8),
                  branchId: branch.id.slice(0, 8),
                  imageSize: `${(dataLen / 1024 / 1024).toFixed(2)} MB`,
                  mimeType: (block as any).mimeType
                });
              }
            }
          }
        }
      }
      
      const totalJson = JSON.stringify(messages);
      
      res.json({
        conversationId,
        messageCount: messages.length,
        totalJsonSize: `${(totalJson.length / 1024 / 1024).toFixed(2)} MB`,
        totalContentLength: `${(totalContentLength / 1024).toFixed(2)} KB`,
        totalImageDataLength: `${(totalImageDataLength / 1024 / 1024).toFixed(2)} MB`,
        imageCount,
        images: messageStats,
        warning: totalJson.length > 10 * 1024 * 1024 ? '⚠️ VERY LARGE - may crash browsers!' : null
      });
    } catch (error) {
      console.error('Error getting conversation size:', error);
      res.status(500).json({ error: 'Failed to get conversation size' });
    }
  });

  return router;
}

