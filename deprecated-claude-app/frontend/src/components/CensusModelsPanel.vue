<template>
  <v-card class="mb-6">
    <v-card-title class="d-flex align-center">
      <v-icon class="mr-2">mdi-map-search</v-icon>
      Models from the census
      <v-spacer />
      <v-btn size="small" variant="text" :loading="loading" @click="load">
        <v-icon start>mdi-refresh</v-icon>Refresh
      </v-btn>
    </v-card-title>
    <v-card-subtitle v-if="generatedAt">
      Census beacon published {{ generatedAt.slice(0, 16).replace('T', ' ') }} UTC ·
      {{ rows.length }} models with a callable door · {{ localCount }} added here so far
    </v-card-subtitle>
    <v-card-text>
      <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>

      <div class="d-flex flex-wrap ga-4 align-center mb-4">
        <v-text-field v-model="q" label="Filter" density="compact" variant="outlined" hide-details style="max-width: 260px" />
        <v-select v-model="roleF" :items="roles" label="Role" density="compact" variant="outlined" hide-details style="max-width: 160px" />
        <v-select v-model="stateF" :items="states" label="Door state" density="compact" variant="outlined" hide-details style="max-width: 160px" />
        <v-checkbox v-model="hideExisting" label="Hide models already here" density="compact" hide-details />
        <v-spacer />
        <v-btn color="primary" :disabled="!selected.length || importing" :loading="importing" @click="importSelected">
          Add {{ selected.length || '' }} selected
        </v-btn>
      </div>

      <v-alert v-if="lastResult" type="success" variant="tonal" class="mb-4" closable @click:close="lastResult = null">
        Added: {{ lastResult.added.join(', ') || 'nothing' }}<span v-if="lastResult.skipped.length"> · already present: {{ lastResult.skipped.join(', ') }}</span>
      </v-alert>

      <v-table density="compact">
        <thead>
          <tr>
            <th>Model</th>
            <th>Role</th>
            <th>Doors (tick to add)</th>
            <th>Seen</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in filtered" :key="m.mindId">
            <td>
              <div class="font-weight-medium">{{ m.display }}</div>
              <div class="text-caption text-grey">{{ (m.io?.in || []).join('+') }} → {{ (m.io?.out || []).join('+') }}</div>
            </td>
            <td><v-chip size="x-small" :color="m.role === 'chat' ? 'primary' : 'grey'" variant="tonal">{{ m.role || '?' }}</v-chip></td>
            <td>
              <div v-for="l in m.legs" :key="l.provider + l.providerModelId" class="d-flex align-center">
                <v-checkbox
                  v-if="!l.existingId"
                  :model-value="isSelected(m, l)"
                  @update:model-value="toggle(m, l, $event)"
                  density="compact" hide-details class="mr-1"
                />
                <v-icon v-else size="small" color="success" class="mr-2" title="already here">mdi-check</v-icon>
                <span class="text-caption">
                  <b>{{ l.provider }}</b> · {{ l.providerModelId }}
                  <v-chip size="x-small" class="ml-1" :color="stateColor(l.state)" variant="tonal">{{ l.state || 'no probe' }}</v-chip>
                  <span v-if="l.existingId" class="text-grey"> = {{ l.existingId }}</span>
                </span>
              </div>
            </td>
            <td class="text-caption text-grey">{{ (m.firstSeen || '').slice(0, 10) }}</td>
          </tr>
        </tbody>
      </v-table>
      <div v-if="!filtered.length && !loading" class="text-grey text-center py-6">Nothing matches.</div>

      <template v-if="stale.length">
        <v-divider class="my-6" />
        <div class="d-flex align-center mb-2">
          <v-icon class="mr-2" color="warning">mdi-door-closed</v-icon>
          <span class="text-subtitle-1">Served models whose door the census cannot see ({{ stale.length }})</span>
        </div>
        <p class="text-caption text-grey mb-3">
          Never deleted — participants in existing conversations are identified by these ids. Hide them from the selector instead; the switch is kept in models.local.json and survives deploys.
        </p>
        <v-table density="compact">
          <thead><tr><th>Model</th><th>Door</th><th>Why</th><th>Hidden</th></tr></thead>
          <tbody>
            <tr v-for="s in stale" :key="s.id">
              <td>{{ s.displayName }} <span class="text-caption text-grey">{{ s.id }}</span></td>
              <td class="text-caption">{{ s.provider }} · {{ s.providerModelId }}</td>
              <td class="text-caption">{{ s.why }}</td>
              <td><v-switch :model-value="s.hidden" density="compact" hide-details color="warning" @update:model-value="setHidden(s, $event)" /></td>
            </tr>
          </tbody>
        </v-table>
      </template>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../services/api';

interface Leg { provider: string; providerModelId: string; state: string | null; existingId: string | null; maxOut: number | null; }
interface Mind { mindId: string; display: string; role: string | null; io: { in: string[]; out: string[] } | null; firstSeen: string | null; legs: Leg[]; allExisting: boolean; }

interface Stale { id: string; provider: string; providerModelId: string; displayName: string; hidden: boolean; why: string; }
const rows = ref<Mind[]>([]);
const stale = ref<Stale[]>([]);
const generatedAt = ref<string>('');
const localCount = ref(0);
const loading = ref(false);
const importing = ref(false);
const error = ref('');
const lastResult = ref<{ added: string[]; skipped: string[] } | null>(null);
const q = ref('');
const roleF = ref('chat');
const stateF = ref('live');
const hideExisting = ref(true);
const selected = ref<{ mindId: string; provider: string; providerModelId: string }[]>([]);

const roles = [
  { title: 'chat (writes text)', value: 'chat' }, { title: 'all', value: '' },
  { title: 'guard', value: 'guard' }, { title: 'image-gen', value: 'image-gen' }, { title: 'audio', value: 'audio' },
];
const states = [{ title: 'live', value: 'live' }, { title: 'any', value: '' }];

const filtered = computed(() => rows.value.filter(m => {
  if (roleF.value && (m.role || '') !== roleF.value) return false;
  if (hideExisting.value && m.allExisting) return false;
  if (stateF.value && !m.legs.some(l => l.state === stateF.value)) return false;
  if (q.value && !JSON.stringify(m).toLowerCase().includes(q.value.toLowerCase())) return false;
  return true;
}));

function stateColor(s: string | null) {
  return s === 'live' ? 'success' : s === 'dead' ? 'error' : s === 'transient' ? 'warning' : 'grey';
}
function isSelected(m: Mind, l: Leg) {
  return selected.value.some(x => x.mindId === m.mindId && x.provider === l.provider && x.providerModelId === l.providerModelId);
}
function toggle(m: Mind, l: Leg, on: boolean | null) {
  const key = { mindId: m.mindId, provider: l.provider, providerModelId: l.providerModelId };
  selected.value = selected.value.filter(x => !(x.mindId === key.mindId && x.provider === key.provider && x.providerModelId === key.providerModelId));
  if (on) selected.value.push(key);
}
async function load() {
  loading.value = true; error.value = '';
  try {
    const [c, l] = await Promise.all([api.get('/admin/census'), api.get('/admin/models/local')]);
    rows.value = c.data.minds; stale.value = c.data.stale || []; generatedAt.value = c.data.generatedAt || ''; localCount.value = (l.data.models || []).length;
  } catch (e: any) {
    error.value = e?.response?.data?.error || e.message;
  } finally { loading.value = false; }
}
async function importSelected() {
  importing.value = true; error.value = '';
  try {
    const r = await api.post('/admin/models/import', { items: selected.value });
    lastResult.value = r.data; selected.value = [];
    await load();
  } catch (e: any) {
    error.value = e?.response?.data?.error || e.message;
  } finally { importing.value = false; }
}
async function setHidden(s: Stale, hidden: boolean | null) {
  try {
    await api.post('/admin/models/local/override', { id: s.id, hidden: !!hidden });
    s.hidden = !!hidden;
  } catch (e: any) {
    error.value = e?.response?.data?.error || e.message;
  }
}
onMounted(load);
</script>
