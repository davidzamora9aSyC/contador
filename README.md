# Contador API

Servicio HTTP mínimo para contar visitas. Cada vez que el front haga una petición `POST /api/visits`, el contador aumenta para la ruta indicada y se persiste en `data/visit-count.json`, lo que evita perder los números si el proceso se reinicia.

## Requisitos

- Node.js 18+ (la misma versión utilizada en el front funciona perfecto).

## Scripts

```bash
npm install        # instala dependencias
npm run dev        # arranca con recarga automática (nodemon)
npm start          # arranca en modo producción
```

Puedes definir el puerto con la variable de entorno `PORT` (por defecto 4000).

## Endpoints

- `GET /api/visits` → devuelve el estado completo del contador: `{ "total": number, "routes": { [route: string]: number } }`.
- `POST /api/visits` → incrementa el total y la ruta indicada. Espera un cuerpo JSON con `{ "route": "inicio" }` y responde el mismo formato del `GET`.

## Flujo típico de despliegue (EC2)

1. Copia la carpeta `contador-api` al servidor (o haz git pull del repo completo).
2. Instala dependencias: `cd contador-api && npm install`.
3. Establece un puerto abierto (por ejemplo `PORT=8080`) y ejecuta `npm start`.
4. Opcional: usa un process manager (`pm2`, `systemd`, etc.) para reinicios automáticos.
5. Expone el puerto con Nginx/ALB o consume el endpoint directamente desde el front configurando la URL del API.

El archivo `data/visit-count.json` debe quedar en el mismo servidor para conservar el historial de visitas.
