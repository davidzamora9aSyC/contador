const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');

const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, '..', 'data', 'visit-count.json');
const LEGACY_ROUTE_NAME = 'general';

let visitStats = { total: 0, routes: {} };

async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify({ total: 0, routes: {} }, null, 2));
  }
}

async function loadCount() {
  await ensureDataFile();
  try {
    const fileContents = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(fileContents);
    visitStats = normalizeStats(parsed);
    console.log(
      `[contador-api] Conteo inicial cargado: total=${visitStats.total}, rutas=${Object.keys(visitStats.routes).length}`
    );
  } catch (error) {
    console.error('[contador-api] No fue posible leer el archivo, iniciando en 0.', error);
    visitStats = { total: 0, routes: {} };
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
    return { total: 0, routes: {} };
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

  return { total, routes: normalizedRoutes };
}

function sanitizeRoute(route) {
  if (typeof route !== 'string') {
    return '';
  }

  return route.trim();
}

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/visits', (req, res) => {
  res.json(visitStats);
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
