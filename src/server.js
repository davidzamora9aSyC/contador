const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');

const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, '..', 'data', 'visit-count.json');

let visitCount = 0;

async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify({ count: 0 }, null, 2));
  }
}

async function loadCount() {
  await ensureDataFile();
  try {
    const fileContents = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(fileContents);
    visitCount = Number(parsed.count) || 0;
    console.log(`[contador-api] Conteo inicial cargado: ${visitCount}`);
  } catch (error) {
    console.error('[contador-api] No fue posible leer el archivo, iniciando en 0.', error);
    visitCount = 0;
  }
}

async function persistCount() {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify({ count: visitCount }, null, 2));
  } catch (error) {
    console.error('[contador-api] Error guardando el contador, los incrementos pueden perderse.', error);
  }
}

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/visits', (req, res) => {
  res.json({ count: visitCount });
});

app.post('/api/visits', async (req, res, next) => {
  try {
    visitCount += 1;
    await persistCount();
    res.json({ count: visitCount });
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
