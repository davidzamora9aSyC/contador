const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');

const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, '..', 'data', 'visit-count.json');
const LEGACY_ROUTE_NAME = 'general';
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const MAX_DAILY_HISTORY_DAYS = 366;
const RANGE_PRESETS = { week: 7, '30d': 30, year: 365 };
const DAILY_SEED_RANGE_DAYS = 7;
const RANGE_ALIASES = {
  week: 'week',
  semana: 'week',
  'esta-semana': 'week',
  'esta_semana': 'week',
  'ultimos-7-dias': 'week',
  '7d': 'week',
  '30d': '30d',
  '30-dias': '30d',
  '30dias': '30d',
  'ultimos-30-dias': '30d',
  'ultimo-mes': '30d',
  'ultimo_mes': '30d',
  year: 'year',
  anual: 'year',
  'ultimo-ano': 'year',
  'ultimo-año': 'year',
  'ultimo_ano': 'year',
  'ultimo_año': 'year',
  'ultimos-12-meses': 'year',
};
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

let visitStats = createEmptyStats();

function createEmptyStats() {
  return { total: 0, routes: {}, daily: {} };
}

async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(createEmptyStats(), null, 2));
  }
}

async function loadCount() {
  await ensureDataFile();
  try {
    const fileContents = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(fileContents);
    visitStats = normalizeStats(parsed);
    let seededDaily = false;
    if (!Object.keys(visitStats.daily || {}).length && Object.keys(visitStats.routes || {}).length) {
      seededDaily = seedDailyStatsFromRoutes();
    }
    pruneDailyStats();
    if (seededDaily) {
      await persistCount();
    }
    console.log(
      `[contador-api] Conteo inicial cargado: total=${visitStats.total}, rutas=${Object.keys(visitStats.routes).length}`
    );
  } catch (error) {
    console.error('[contador-api] No fue posible leer el archivo, iniciando en 0.', error);
    visitStats = createEmptyStats();
  }
}

async function persistCount() {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(visitStats, null, 2));
  } catch (error) {
    console.error('[contador-api] Error guardando el contador, los incrementos pueden perderse.', error);
  }
}

function normalizeStats(raw) {
  if (!raw || typeof raw !== 'object') {
    return createEmptyStats();
  }

  const normalizedRoutes = {};
  if (raw.routes && typeof raw.routes === 'object') {
    for (const [routeName, value] of Object.entries(raw.routes)) {
      const visits = Number(value) || 0;
      if (visits > 0 && routeName) {
        normalizedRoutes[routeName] = visits;
      }
    }
  }

  let totalFromRoutes = Object.values(normalizedRoutes).reduce((sum, value) => sum + value, 0);
  let total = Number(raw.total);
  if (!Number.isFinite(total) || total < totalFromRoutes) {
    total = totalFromRoutes;
  }

  if (!Object.keys(normalizedRoutes).length && typeof raw.count === 'number') {
    const legacyCount = Number(raw.count) || 0;
    if (legacyCount > 0) {
      normalizedRoutes[LEGACY_ROUTE_NAME] = legacyCount;
      totalFromRoutes = legacyCount;
      total = legacyCount;
    }
  }

  const normalizedDaily = normalizeDailyStats(raw.daily);

  return { total, routes: normalizedRoutes, daily: normalizedDaily };
}

function sanitizeRoute(route) {
  if (typeof route !== 'string') {
    return '';
  }

  return route.trim();
}

function resolveRangeKey(rawRange) {
  if (!rawRange) {
    return 'week';
  }

  const normalized = String(rawRange).toLowerCase();
  if (RANGE_PRESETS[normalized]) {
    return normalized;
  }

  const alias = RANGE_ALIASES[normalized];
  if (alias && RANGE_PRESETS[alias]) {
    return alias;
  }

  return null;
}

function normalizeDailyStats(rawDaily) {
  if (!rawDaily || typeof rawDaily !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [dateKey, routes] of Object.entries(rawDaily)) {
    if (!isValidDateKey(dateKey) || !routes || typeof routes !== 'object') {
      continue;
    }

    const normalizedRoutes = {};
    for (const [routeName, value] of Object.entries(routes)) {
      const sanitized = sanitizeRoute(routeName);
      const visits = Number(value) || 0;
      if (sanitized && visits > 0) {
        normalizedRoutes[sanitized] = visits;
      }
    }

    if (Object.keys(normalizedRoutes).length) {
      normalized[dateKey] = normalizedRoutes;
    }
  }

  return normalized;
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function getTodayKey() {
  return formatDateKey(new Date());
}

function getDateKeyNDaysAgo(daysAgo, referenceDate = new Date()) {
  const date = new Date(referenceDate);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return formatDateKey(date);
}

function buildRecentDateKeys(days, referenceDate = new Date()) {
  const limit = Math.max(1, Math.min(days, MAX_DAILY_HISTORY_DAYS));
  const keys = [];
  for (let i = limit - 1; i >= 0; i -= 1) {
    keys.push(getDateKeyNDaysAgo(i, referenceDate));
  }
  return keys;
}

function isValidDateKey(dateKey) {
  return DATE_KEY_REGEX.test(dateKey) && Number.isFinite(Date.parse(dateKey));
}

function getTimestampForDateKey(dateKey) {
  const parsed = Date.parse(dateKey);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function pruneDailyStats(referenceDate = new Date()) {
  if (!visitStats.daily) {
    visitStats.daily = {};
    return;
  }

  const todayTimestamp = getTimestampForDateKey(formatDateKey(referenceDate));
  if (!Number.isFinite(todayTimestamp)) {
    return;
  }
  const cutoffTimestamp = todayTimestamp - (MAX_DAILY_HISTORY_DAYS - 1) * DAY_IN_MS;

  for (const dateKey of Object.keys(visitStats.daily)) {
    const dateTimestamp = getTimestampForDateKey(dateKey);
    if (!Number.isFinite(dateTimestamp) || dateTimestamp < cutoffTimestamp) {
      delete visitStats.daily[dateKey];
    }
  }
}

function seedDailyStatsFromRoutes(referenceDate = new Date()) {
  if (!visitStats || !visitStats.routes) {
    return false;
  }

  const routeEntries = Object.entries(visitStats.routes);
  if (!routeEntries.length) {
    return false;
  }

  const dateKeys = buildRecentDateKeys(DAILY_SEED_RANGE_DAYS, referenceDate);
  if (!dateKeys.length) {
    return false;
  }

  const seededDaily = {};
  for (const dateKey of dateKeys) {
    seededDaily[dateKey] = {};
  }

  const numDays = dateKeys.length;
  for (const [routeName, value] of routeEntries) {
    const sanitizedRoute = sanitizeRoute(routeName);
    const visits = Number(value) || 0;
    if (!sanitizedRoute || visits <= 0) {
      continue;
    }

    const base = Math.floor(visits / numDays);
    const remainder = visits % numDays;
    for (let index = 0; index < numDays; index += 1) {
      const amount = base + (index < remainder ? 1 : 0);
      if (!amount) {
        continue;
      }

      const dateKey = dateKeys[index];
      seededDaily[dateKey][sanitizedRoute] = (seededDaily[dateKey][sanitizedRoute] || 0) + amount;
    }
  }

  visitStats.daily = Object.fromEntries(
    Object.entries(seededDaily).filter(([, routes]) => Object.keys(routes).length)
  );

  return Object.keys(visitStats.daily).length > 0;
}

function incrementDailyCount(route, dateKey = getTodayKey()) {
  if (!visitStats.daily) {
    visitStats.daily = {};
  }

  if (!visitStats.daily[dateKey]) {
    visitStats.daily[dateKey] = {};
  }

  if (!visitStats.daily[dateKey][route]) {
    visitStats.daily[dateKey][route] = 0;
  }

  visitStats.daily[dateKey][route] += 1;
}

function collectDailyVisits(rangeKey) {
  const days = RANGE_PRESETS[rangeKey];
  if (!days) {
    return null;
  }

  const todayKey = getTodayKey();
  const todayTimestamp = getTimestampForDateKey(todayKey);
  if (!Number.isFinite(todayTimestamp)) {
    return [];
  }
  const startTimestamp = todayTimestamp - (days - 1) * DAY_IN_MS;

  if (!visitStats.daily || !Object.keys(visitStats.daily).length) {
    return [];
  }

  return Object.entries(visitStats.daily)
    .map(([dateKey, routes]) => ({
      dateKey,
      routes,
      timestamp: getTimestampForDateKey(dateKey),
    }))
    .filter((entry) => Number.isFinite(entry.timestamp) && entry.timestamp >= startTimestamp)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(({ dateKey, routes }) => ({
      date: dateKey,
      routes: { ...routes },
      total: Object.values(routes).reduce((sum, value) => sum + value, 0),
    }));
}

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/visits', (req, res) => {
  res.json(visitStats);
});

app.get('/api/visits/daily', (req, res) => {
  const rangeKey = resolveRangeKey(req.query.range || 'week');

  if (!rangeKey) {
    return res.status(400).json({ message: 'La query "range" debe ser week, 30d o year.' });
  }

  const days = collectDailyVisits(rangeKey);
  res.json({ range: rangeKey, days, availableRanges: Object.keys(RANGE_PRESETS) });
});

app.post('/api/visits', async (req, res, next) => {
  try {
    const sanitizedRoute = sanitizeRoute(req.body?.route);

    if (!sanitizedRoute) {
      return res.status(400).json({ message: 'La propiedad "route" es obligatoria.' });
    }

    if (!visitStats.routes[sanitizedRoute]) {
      visitStats.routes[sanitizedRoute] = 0;
    }

    visitStats.routes[sanitizedRoute] += 1;
    visitStats.total += 1;
    incrementDailyCount(sanitizedRoute);
    pruneDailyStats();
    await persistCount();
    res.json(visitStats);
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  console.error('[contador-api] Error inesperado:', err);
  res.status(500).json({ message: 'Error interno' });
});

async function bootstrap() {
  await loadCount();
  app.listen(PORT, () => {
    console.log(`[contador-api] Servidor escuchando en puerto ${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error('[contador-api] No fue posible iniciar el servidor:', error);
  process.exit(1);
});
