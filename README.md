# benzIA — gateway multiusuario para Proveedor IA Local

benzIA pone una capa compatible con la API de OpenAI delante del servidor local de Proveedor IA Local. Entrega claves independientes y revocables, contabiliza tokens por identidad, mide latencia y aciertos de caché, y ofrece un panel web sin enviar prompts ni respuestas a servicios externos.

## Puesta en marcha

Requisitos: Node.js 20 o superior y el servidor local de Proveedor IA Local activo (o otro openai compatible).

```powershell
npm install
Copy-Item .env.example .env
```

Edite `.env` y cambie como mínimo `ADMIN_TOKEN`. Después:

```powershell
npm start
```

- Panel administrativo: `http://localhost:3400`
- Endpoint para usuarios: `http://IP-DEL-EQUIPO:3401/v1`
- Panel a través del gateway: `http://IP-DEL-EQUIPO:3401/dashboard`
- Chat para usuarios: `http://IP-DEL-EQUIPO:3401/chat`
- Proveedor IA Local esperado: `http://127.0.0.1:1234`

El panel sólo escucha en `127.0.0.1` por defecto. El gateway escucha en todas las interfaces para que otros equipos puedan acceder. Abra el puerto 3401 en el firewall únicamente para las redes necesarias.

## Uso desde un cliente OpenAI

Primero cree una clave con nombre desde el panel. El secreto se muestra una sola vez.

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://IP-DEL-EQUIPO:3401/v1",
  apiKey: "lmg_token_generado"
});

const response = await client.chat.completions.create({
  model: "nombre-del-modelo-cargado",
  messages: [{ role: "user", content: "Hola" }]
});
```

También se admite `x-api-key`. Todas las rutas `/v1/*` se reenvían a Proveedor IA Local, por lo que funcionan `/v1/models`, completions, embeddings y otros endpoints compatibles.

## Chat web para usuarios

`/chat` ofrece una interfaz de conversación para probar los modelos cargados en Proveedor IA Local. Cada usuario debe introducir una clave activa creada en **Claves API**. La pantalla valida esa clave antes de consultar `/v1/models` y cada respuesta se solicita a `/v1/chat/completions` usando el endpoint público configurado en el dashboard.

Las conversaciones y el modelo seleccionado se conservan en `localStorage` del navegador; el token sólo permanece en `sessionStorage` hasta cerrar la pestaña. En cada turno se reenvía el historial de la conversación activa para conservar el contexto. El servidor mantiene su política de privacidad: no persiste mensajes ni respuestas, únicamente las métricas de uso ya descritas.

El chat web usa `/v1/responses` con `store: false`: conserva el historial únicamente en el navegador y permite que Proveedor IA Local reporte los tokens reutilizados por su prompt cache. Los clientes externos pueden seguir usando todos los endpoints OpenAI-compatible del gateway.

Las respuestas se interpretan como Markdown con `marked` (GFM) y se sanean con `DOMPurify` antes de mostrarse. Se admiten encabezados, listas, enlaces, citas, tablas, tareas, código en línea y bloques de código copiables sin confiar en el HTML devuelto por el modelo.

El compositor permite adjuntar hasta cuatro archivos mediante el selector, arrastrando o pegando imágenes. JPEG, PNG, WebP y GIF se optimizan localmente y se envían a Proveedor IA Local como contenido visual compatible con OpenAI; para interpretarlas, el modelo seleccionado debe ser multimodal o de visión. PDF, DOCX, TXT, Markdown, CSV y JSON se procesan temporalmente en memoria, se convierten a texto y se incorporan al contexto con su nombre. Los documentos admiten hasta 6 MB y 120.000 caracteres extraídos; nunca se escriben en disco. Las imágenes y el texto extraído forman parte del historial local del navegador para conservar el contexto de la conversación.

La extracción usa el endpoint protegido `POST /chat/api/attachments/extract`, por lo que también exige una clave de usuario activa. El navegador reduce cada imagen a un máximo de 1,3 MB antes de almacenarla y enviarla. Si `localStorage` se llena, la interfaz avisa para que se eliminen chats antiguos.

## Métricas y caché

- Cuando Proveedor IA Local entrega `usage`, benzIA conserva sus contadores exactos.
- Si no entrega `usage`, se usa una estimación y la traza queda marcada internamente como `estimated`.
- En streaming se solicita `stream_options.include_usage`, se reenvía el SSE sin esperar a que termine y se registra el bloque final de uso/estadísticas.
- La caché sólo se aplica a inferencias `POST` no streaming exitosas. Su clave es el hash de la ruta y del cuerpo completo.
- `HIT` y `MISS` describen exclusivamente la caché de respuestas de benzIA. Los streams, las rutas no cacheables, la caché desactivada y `Cache-Control: no-cache` se registran como `BYPASS`.
- La caché de prompt/KV de Proveedor IA Local se contabiliza aparte cuando el upstream devuelve `cached_tokens` (por ejemplo, en `/v1/responses`). Si el endpoint no lo incluye, el panel lo indica como no reportado.
- Durante una respuesta en streaming, el dashboard muestra el estado de emisión y una velocidad aproximada. Al terminar se conserva `tokens_per_second` si Proveedor IA Local lo reporta; en caso contrario se calcula con los tokens de salida y el tiempo de generación observado.
- Las mediciones estimadas antiguas se recalculan de forma conservadora usando la duración completa de la petición; las nuevas incluyen también los fragmentos de razonamiento para no inflar la velocidad.
- La caché vive en memoria. Las métricas, claves y ajustes persisten en `data/gateway.sqlite`, con SQLite en modo WAL e índices por fecha, clave y estado de caché.
- Al arrancar por primera vez con SQLite, benzIA importa automáticamente el antiguo `gateway.json` y conserva una copia `gateway.json.migrated` como respaldo.

No se guardan prompts, mensajes, embeddings ni respuestas. Cada métrica contiene identidad, endpoint, modelo, fecha, estado, latencia, tokens, rendimiento y estados de caché.

## Puertos y configuración

| Variable | Predeterminado | Función |
|---|---:|---|
| `ADMIN_HOST` | `127.0.0.1` | Interfaz del panel |
| `ADMIN_PORT` | `3400` | Puerto del panel |
| `GATEWAY_HOST` | `0.0.0.0` | Interfaz pública del gateway |
| `GATEWAY_PORT` | `3401` | Puerto compatible con OpenAI |
| `PUBLIC_GATEWAY_URL` | `http://localhost:3401` | URL mostrada en el panel |
| `LM_STUDIO_BASE_URL` | `http://127.0.0.1:1234` | Servidor de Proveedor IA Local |
| `CACHE_TTL_SECONDS` | `300` | Caducidad de respuestas |
| `CACHE_MAX_ENTRIES` | `250` | Máximo LRU en memoria |
| `METRICS_RETENTION_DAYS` | `30` | Retención de telemetría |
| `REQUEST_TIMEOUT_MS` | `300000` | Timeout de inferencia |

Cambiar los puertos requiere reiniciar el proceso. La URL y clave upstream, además de la URL pública que ven los clientes, se pueden actualizar en caliente desde el panel.

### Subdominio HTTPS de Cloudflare

En **Configuración → Acceso público** puede indicar una URL como `https://llm.example.com`. benzIA la mostrará como endpoint de conexión para los clientes. Este ajuste no crea el DNS ni el túnel: en Cloudflare debe apuntar ese hostname al origen `http://localhost:3401`, normalmente mediante Cloudflare Tunnel, y mantener el panel administrativo fuera de la ruta pública.

El mismo origen publica el panel en `/dashboard` y el chat en `/chat`. Las carcasas HTML/CSS/JS se sirven sin autenticación, pero no contienen datos administrativos ni acceso al modelo. Todas las consultas y operaciones de `/admin/api/*` requieren `ADMIN_TOKEN`; `/chat/api/*` y `/v1/*` requieren una clave de usuario activa. Se recomienda añadir además una política de Cloudflare Access para `/dashboard`, `/keys`, `/activity`, `/settings` y `/admin/api/*`.

## Docker

Copie `.env.example` como `.env`, cambie el token administrativo y ejecute:

```powershell
docker compose up -d --build
```

El compose expone el panel sólo en localhost y usa `host.docker.internal` para llegar a Proveedor IA Local en el host.

## Producción

benzIA está pensado para redes de confianza. Para acceso por Internet, colóquelo detrás de Caddy, nginx o un túnel con TLS; limite el panel a localhost/VPN; proteja y copie el volumen `data`; y no reutilice `ADMIN_TOKEN` como clave de usuario.

Ejecute las pruebas con `npm test`.
