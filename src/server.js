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
const COLOMBIA_UTC_OFFSET_MS = -5 * 60 * 60 * 1000; // Colombia timezone (UTC-5)
const MAX_TRACKABLE_DURATION_MS = 24 * 60 * 60 * 1000; // Ignore sessions longer than 24 hours
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
const DEFAULT_SITE = 'losandes';
const SITE_ALIASES = {
  losandes: 'losandes',
  'los-andes': 'losandes',
  'los_andes': 'losandes',
  andes: 'losandes',
  endomedicos: 'endomedicos',
  'endo-medicos': 'endomedicos',
  'endo_medicos': 'endomedicos',
  'endomédicos': 'endomedicos',
};

let visitStatsBySite = { [DEFAULT_SITE]: createEmptyStats() };

function createEmptyStats() {
  return { total: 0, routes: {}, daily: {}, sessionDurations: {}, routeDurations: {} };
}

function resolveSiteKey(rawSite) {
  if (rawSite === undefined || rawSite === null || rawSite === '') {
    return DEFAULT_SITE;
  }
  const normalized = String(rawSite).trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_SITE;
  }
  return SITE_ALIASES[normalized] || null;
}

function getSiteStats(siteKey = DEFAULT_SITE) {
  const resolved = resolveSiteKey(siteKey);
  if (!resolved) {
    return null;
  }
  if (!visitStatsBySite[resolved]) {
    visitStatsBySite[resolved] = createEmptyStats();
  }
  return visitStatsBySite[resolved];
}

function normalizeSitesStore(raw) {
  if (raw && typeof raw === 'object' && raw.sites && typeof raw.sites === 'object') {
    const normalizedSites = {};
    for (const [siteName, stats] of Object.entries(raw.sites)) {
      const resolved = resolveSiteKey(siteName);
      if (!resolved) {
        continue;
      }
      normalizedSites[resolved] = normalizeStats(stats);
    }
    if (!Object.keys(normalizedSites).length) {
      normalizedSites[DEFAULT_SITE] = createEmptyStats();
    }
    return normalizedSites;
  }

  return { [DEFAULT_SITE]: normalizeStats(raw) };
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
    visitStatsBySite = normalizeSitesStore(parsed);
    Object.values(visitStatsBySite).forEach((stats) => pruneDailyStats(stats));
    const summary = Object.entries(visitStatsBySite)
      .map(([siteName, stats]) => `${siteName}: total=${stats.total}, rutas=${Object.keys(stats.routes).length}`)
      .join(' | ');
    console.log(`[contador-api] Conteos iniciales cargados → ${summary}`);
  } catch (error) {
    console.error('[contador-api] No fue posible leer el archivo, iniciando en 0.', error);
    visitStatsBySite = { [DEFAULT_SITE]: createEmptyStats() };
  }
}

async function persistCount() {
  try {
    const payload = { version: 2, sites: visitStatsBySite };
    await fs.writeFile(DATA_FILE, JSON.stringify(payload, null, 2));
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
      const sanitized = sanitizeRoute(routeName);
      const visits = Number(value) || 0;
      if (visits > 0 && sanitized) {
        normalizedRoutes[sanitized] = (normalizedRoutes[sanitized] || 0) + visits;
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
      const legacyRoute = sanitizeRoute(LEGACY_ROUTE_NAME) || LEGACY_ROUTE_NAME;
      normalizedRoutes[legacyRoute] = legacyCount;
      totalFromRoutes = legacyCount;
      total = legacyCount;
    }
  }

  const normalizedDaily = normalizeDailyStats(raw.daily);
  const normalizedSessionDurations = normalizeSessionDurationMap(raw.sessionDurations);
  const normalizedRouteDurations = normalizeRouteDurationMap(raw.routeDurations);

  return {
    total,
    routes: normalizedRoutes,
    daily: normalizedDaily,
    sessionDurations: normalizedSessionDurations,
    routeDurations: normalizedRouteDurations,
  };
}

function sanitizeRoute(route) {
  if (typeof route !== 'string') {
    return '';
  }

  const trimmed = route.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }

  const [path = ''] = trimmed.split(/[?#]/);
  const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/+/g, '/');
  return normalized;
}

function sanitizeDurationValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  const clamped = Math.min(parsed, MAX_TRACKABLE_DURATION_MS);
  return Math.round(clamped);
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
        normalizedRoutes[sanitized] = (normalizedRoutes[sanitized] || 0) + visits;
      }
    }

    if (Object.keys(normalizedRoutes).length) {
      normalized[dateKey] = normalizedRoutes;
    }
  }

  return normalized;
}

function normalizeDurationSummary(rawSummary) {
  if (!rawSummary || typeof rawSummary !== 'object') {
    return null;
  }

  const count = Number(rawSummary.count) || 0;
  const totalDuration = Number(rawSummary.totalDuration) || 0;

  if (!count || totalDuration <= 0) {
    return null;
  }

  const average = totalDuration / count;
  const normalizedMin = sanitizeDurationValue(Number(rawSummary.min)) ?? sanitizeDurationValue(average);
  const normalizedMax = sanitizeDurationValue(Number(rawSummary.max)) ?? sanitizeDurationValue(average);

  if (!normalizedMin || !normalizedMax) {
    return null;
  }

  const min = Math.min(normalizedMin, normalizedMax);
  const max = Math.max(normalizedMin, normalizedMax);

  const minPossibleTotal = min * count;
  const maxPossibleTotal = max * count;
  let sanitizedTotal = Math.round(totalDuration);
  if (!Number.isFinite(sanitizedTotal) || sanitizedTotal <= 0) {
    sanitizedTotal = minPossibleTotal;
  }
  sanitizedTotal = Math.min(Math.max(sanitizedTotal, minPossibleTotal), maxPossibleTotal);

  return {
    min,
    max,
    count,
    totalDuration: sanitizedTotal,
  };
}

function mergeDurationSummaries(base, addition) {
  if (!base) {
    return addition;
  }
  if (!addition) {
    return base;
  }

  return {
    min: Math.min(base.min, addition.min),
    max: Math.max(base.max, addition.max),
    count: base.count + addition.count,
    totalDuration: base.totalDuration + addition.totalDuration,
  };
}

function normalizeSessionDurationMap(rawSessions) {
  if (!rawSessions || typeof rawSessions !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [dateKey, summary] of Object.entries(rawSessions)) {
    if (!isValidDateKey(dateKey)) {
      continue;
    }

    const normalizedSummary = normalizeDurationSummary(summary);
    if (normalizedSummary) {
      normalized[dateKey] = normalizedSummary;
    }
  }

  return normalized;
}

function normalizeRouteDurationMap(rawRoutes) {
  if (!rawRoutes || typeof rawRoutes !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [dateKey, routes] of Object.entries(rawRoutes)) {
    if (!isValidDateKey(dateKey) || !routes || typeof routes !== 'object') {
      continue;
    }

    const normalizedRoutes = {};
    for (const [routeName, summary] of Object.entries(routes)) {
      const sanitized = sanitizeRoute(routeName);
      if (!sanitized) {
        continue;
      }
      const normalizedSummary = normalizeDurationSummary(summary);
      if (normalizedSummary) {
        normalizedRoutes[sanitized] = mergeDurationSummaries(normalizedRoutes[sanitized], normalizedSummary);
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

function getColombiaDate(referenceDate = new Date()) {
  return new Date(referenceDate.getTime() + COLOMBIA_UTC_OFFSET_MS);
}

function getTodayKey(referenceDate = new Date()) {
  return formatDateKey(getColombiaDate(referenceDate));
}

function isValidDateKey(dateKey) {
  return DATE_KEY_REGEX.test(dateKey) && Number.isFinite(Date.parse(dateKey));
}

function getTimestampForDateKey(dateKey) {
  const parsed = Date.parse(dateKey);
  return Number.isFinite(parsed) ? parsed - COLOMBIA_UTC_OFFSET_MS : NaN;
}

function pruneDailyStats(stats, referenceDate = new Date()) {
  if (!stats) {
    return;
  }
  if (!stats.daily) {
    stats.daily = {};
  }
  if (!stats.sessionDurations) {
    stats.sessionDurations = {};
  }
  if (!stats.routeDurations) {
    stats.routeDurations = {};
  }

  const todayTimestamp = getTimestampForDateKey(getTodayKey(referenceDate));
  if (!Number.isFinite(todayTimestamp)) {
    return;
  }
  const cutoffTimestamp = todayTimestamp - (MAX_DAILY_HISTORY_DAYS - 1) * DAY_IN_MS;

  pruneDateMap(stats.daily, cutoffTimestamp);
  pruneDateMap(stats.sessionDurations, cutoffTimestamp);
  pruneDateMap(stats.routeDurations, cutoffTimestamp);
}

function pruneDateMap(store, cutoffTimestamp) {
  if (!store || typeof store !== 'object') {
    return;
  }

  for (const dateKey of Object.keys(store)) {
    const dateTimestamp = getTimestampForDateKey(dateKey);
    if (!Number.isFinite(dateTimestamp) || dateTimestamp < cutoffTimestamp) {
      delete store[dateKey];
    }
  }
}

function incrementDailyCount(stats, route, dateKey = getTodayKey()) {
  if (!stats.daily) {
    stats.daily = {};
  }

  if (!stats.daily[dateKey]) {
    stats.daily[dateKey] = {};
  }

  if (!stats.daily[dateKey][route]) {
    stats.daily[dateKey][route] = 0;
  }

  stats.daily[dateKey][route] += 1;
}

function createDurationSummary(durationMs) {
  return {
    min: durationMs,
    max: durationMs,
    totalDuration: durationMs,
    count: 1,
  };
}

function updateSessionDurationMetrics(stats, durationMs, dateKey = getTodayKey()) {
  if (!stats.sessionDurations) {
    stats.sessionDurations = {};
  }

  if (!stats.sessionDurations[dateKey]) {
    stats.sessionDurations[dateKey] = createDurationSummary(durationMs);
    return stats.sessionDurations[dateKey];
  }

  const summary = stats.sessionDurations[dateKey];
  summary.count = (Number(summary.count) || 0) + 1;
  summary.totalDuration = (Number(summary.totalDuration) || 0) + durationMs;
  summary.min = typeof summary.min === 'number' ? Math.min(summary.min, durationMs) : durationMs;
  summary.max = typeof summary.max === 'number' ? Math.max(summary.max, durationMs) : durationMs;
  return summary;
}

function updateRouteDurationMetrics(stats, route, durationMs, dateKey = getTodayKey()) {
  if (!stats.routeDurations) {
    stats.routeDurations = {};
  }

  if (!stats.routeDurations[dateKey]) {
    stats.routeDurations[dateKey] = {};
  }

  if (!stats.routeDurations[dateKey][route]) {
    stats.routeDurations[dateKey][route] = createDurationSummary(durationMs);
    return stats.routeDurations[dateKey][route];
  }

  const summary = stats.routeDurations[dateKey][route];
  summary.count = (Number(summary.count) || 0) + 1;
  summary.totalDuration = (Number(summary.totalDuration) || 0) + durationMs;
  summary.min = typeof summary.min === 'number' ? Math.min(summary.min, durationMs) : durationMs;
  summary.max = typeof summary.max === 'number' ? Math.max(summary.max, durationMs) : durationMs;
  return summary;
}

function buildDurationSummaryResponse(summary) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const count = Number(summary.count) || 0;
  const totalDuration = Number(summary.totalDuration) || 0;
  const average = count ? Math.round((totalDuration / count) * 100) / 100 : 0;

  return {
    min: summary.min,
    max: summary.max,
    count,
    totalDuration,
    average,
  };
}

function collectDailyVisits(stats, rangeKey) {
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

  if (!stats.daily || !Object.keys(stats.daily).length) {
    return [];
  }

  return Object.entries(stats.daily)
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

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (!ALLOWED_ORIGINS.length) {
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origen ${origin} no permitido por CORS`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

app.get('/api/visits', (req, res) => {
  const siteKey = resolveSiteKey(req.query.site);
  if (!siteKey) {
    return res.status(400).json({ message: 'El parámetro "site" no es válido. Usa losandes o endomedicos.' });
  }
  const stats = getSiteStats(siteKey);
  res.json(stats);
});

app.get('/api/visits/daily', (req, res) => {
  const siteKey = resolveSiteKey(req.query.site);
  if (!siteKey) {
    return res.status(400).json({ message: 'El parámetro "site" no es válido. Usa losandes o endomedicos.' });
  }
  const stats = getSiteStats(siteKey);
  const rangeKey = resolveRangeKey(req.query.range || 'week');

  if (!rangeKey) {
    return res.status(400).json({ message: 'La query "range" debe ser week, 30d o year.' });
  }

  const days = collectDailyVisits(stats, rangeKey);
  res.json({ range: rangeKey, days, availableRanges: Object.keys(RANGE_PRESETS) });
});

app.post('/api/visits', async (req, res, next) => {
  try {
    const siteKey = resolveSiteKey(req.body?.site);
    if (!siteKey) {
      return res.status(400).json({ message: 'La propiedad "site" es inválida. Usa losandes o endomedicos.' });
    }
    const stats = getSiteStats(siteKey);
    const sanitizedRoute = sanitizeRoute(req.body?.route);

    if (!sanitizedRoute) {
      return res.status(400).json({ message: 'La propiedad "route" es obligatoria.' });
    }

    if (!stats.routes[sanitizedRoute]) {
      stats.routes[sanitizedRoute] = 0;
    }

    stats.routes[sanitizedRoute] += 1;
    stats.total += 1;
    incrementDailyCount(stats, sanitizedRoute);
    pruneDailyStats(stats);
    await persistCount();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

app.post('/api/visits/durations', async (req, res, next) => {
  try {
    const siteKey = resolveSiteKey(req.body?.site);
    if (!siteKey) {
      return res.status(400).json({ message: 'La propiedad "site" es inválida. Usa losandes o endomedicos.' });
    }
    const stats = getSiteStats(siteKey);
    const scopeRaw = typeof req.body?.scope === 'string' ? req.body.scope.trim().toLowerCase() : '';
    if (scopeRaw !== 'session' && scopeRaw !== 'route') {
      return res.status(400).json({ message: 'La propiedad "scope" debe ser "session" o "route".' });
    }

    const durationMs = sanitizeDurationValue(req.body?.durationMs);
    if (!durationMs) {
      return res.status(400).json({ message: 'La propiedad "durationMs" debe ser un número mayor que 0.' });
    }

    const dateKey = getTodayKey();
    pruneDailyStats(stats);

    if (scopeRaw === 'route') {
      const sanitizedRoute = sanitizeRoute(req.body?.route);
      if (!sanitizedRoute) {
        return res.status(400).json({ message: 'La propiedad "route" es obligatoria cuando scope es "route".' });
      }

      const summary = updateRouteDurationMetrics(stats, sanitizedRoute, durationMs, dateKey);
      await persistCount();
      return res.json({
        scope: scopeRaw,
        date: dateKey,
        route: sanitizedRoute,
        summary: buildDurationSummaryResponse(summary),
      });
    }

    const summary = updateSessionDurationMetrics(stats, durationMs, dateKey);
    await persistCount();
    res.json({
      scope: scopeRaw,
      date: dateKey,
      summary: buildDurationSummaryResponse(summary),
    });
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
