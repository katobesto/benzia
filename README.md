# benzIA — gateway multiusuario para Proveedor IA Local

benzIA pone una capa compatible con la API de OpenAI delante del servidor local de Proveedor IA Local. Entrega claves independientes, pausables y revocables, contabiliza tokens por identidad, mide latencia y reutilización de contexto del motor, y ofrece un panel web sin enviar prompts ni respuestas a servicios externos.

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
- Entrada pública: `http://IP-DEL-EQUIPO:3401/` (redirige al chat)
- Panel a través del gateway: `http://IP-DEL-EQUIPO:3401/dashboard`
- Estado del servicio: `http://IP-DEL-EQUIPO:3401/status`
- Chat para usuarios: `http://IP-DEL-EQUIPO:3401/chat`
- Proveedor IA Local esperado: `http://127.0.0.1:1234`

El panel sólo escucha en `127.0.0.1` por defecto. El gateway escucha en todas las interfaces para que otros equipos puedan acceder. Abra el puerto 3401 en el firewall únicamente para las redes necesarias.

## Uso desde un cliente OpenAI

Primero cree una clave con nombre desde el panel. El secreto se muestra una sola vez.

Una clave puede pausarse temporalmente desde **Claves API** y reanudarse conservando el mismo token. La revocación es definitiva. Al pausar se puede definir un aviso personalizado de hasta 500 caracteres y editarlo después; si queda vacío se usa el mensaje administrativo predeterminado. Una clave pausada puede abrir el chat y consultar la lista de modelos, pero sus inferencias no llegan al proveedor: benzIA devuelve el aviso como respuesta de asistente compatible, también en streaming. Así aparece como contestación tanto en el chat como en clientes como OpenCode. Una clave inválida o revocada recibe HTTP `401`.

Si una clave está en **Permitir externos**, aparece un botón **Proveedores** que abre un diálogo con todos los proveedores externos configurados para marcar cuáles serán visibles para esa clave. La marca actúa como filtro: en `/v1/models` solo se muestran los proveedores marcados que estén realmente disponibles en ese momento (si un proveedor está apagado simplemente no aparece), y las peticiones a un proveedor no marcado se rechazan con HTTP `403`.

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

### Proveedores externos

En **Configuración → Proveedores externos** se pueden registrar hasta 20 servidores OpenAI-compatible con un nombre, un prefijo, su URL base y un token opcional. benzIA consulta dinámicamente el endpoint `/v1/models` de cada origen cuando un cliente solicita la lista de modelos. Los modelos locales conservan su identificador original y los externos se publican como `proveedor/modelo`; al usarlos, benzIA retira el prefijo y reenvía la petición y las credenciales al proveedor correspondiente.

Cada clave de benzIA tiene un permiso independiente: **Solo proveedor local** o **Permitir proveedores externos**. Por seguridad, las claves existentes y las nuevas usan sólo el proveedor local de forma predeterminada. El permiso puede elegirse al crear la clave o cambiarse después desde **Claves API**. Los tokens de proveedores externos se almacenan únicamente en el servidor y nunca se devuelven al navegador.

### Capacidades de modelo en `/v1/models`

Los endpoints `/v1/models` de Proveedor IA Local no anuncian qué modalidades de entrada acepta cada modelo (texto, imagen…). benzIA rellena ese hueco con una referencia declarada por el operador: `data/model-capabilities.json` (vea `model-capabilities.example.json`). Cada entrada nombra el ID público del modelo — el ID original para modelos locales o `proveedor/modelo` para externos; también se acepta el ID sin prefijo — y declara `input` (modalidades de entrada; por defecto `["text"]`) y `output` (por defecto `["text"]`). Las modalidades admitidas son `text` y `image`.

```json
{
  "unsloth/qwen3.8-27b-gguf/qwen3.8-27b-ud-q4_k_s.gguf": { "input": ["text"], "output": ["text"] },
  "qwen2.5-vl-7b-instruct-q4_k_m.gguf": { "input": ["text", "image"], "output": ["text"] },
  "cloud/mi-modelo-externo": { "input": ["text", "image"] }
}
```

Cuando un modelo aparece en el mapa, `GET /v1/models` le añade `input_modalities` y `output_modalities`; los modelos sin declaración se devuelven intactos. El archivo se lee en cada consulta, por lo que los cambios aplican sin reiniciar. También se puede administrar por API con `GET /admin/api/model-capabilities` y `PUT /admin/api/model-capabilities` (cuerpo `{ "capabilities": { … } }`), que valida y reescribe el archivo.

Declarar `input: ["text"]` en un modelo que no ve es intencionado: avisa a los clientes de que no deben enviarle imágenes. Y tenga en cuenta que algunos clientes (por ejemplo DSH) resuelven las modalidades desde su propia configuración de proveedor, no desde el endpoint, así que en ellos declare además la capacidad en su fichero de configuración (p. ej. `input: [text, image]` en la definición del modelo).

## Chat web para usuarios

`/chat` ofrece una interfaz de conversación para probar los modelos cargados en Proveedor IA Local. Cada usuario debe introducir una clave activa creada en **Claves API**. La pantalla valida esa clave antes de consultar `/v1/models` y cada respuesta se solicita a `/v1/responses` usando el endpoint público configurado en el dashboard.

Las conversaciones, el modelo seleccionado y el token de acceso se conservan en `localStorage` del navegador. El token administrativo del dashboard se almacena del mismo modo. Ambos permanecen en ese navegador y origen hasta usar **Cerrar sesión** o **Cambiar token**; no se comparten entre `localhost` y un dominio público distinto. En cada turno se reenvía el historial de la conversación activa para conservar el contexto. El servidor mantiene su política de privacidad: no persiste mensajes ni respuestas, únicamente las métricas de uso ya descritas.

El chat web usa `/v1/responses` con `store: false`: conserva el historial únicamente en el navegador y permite que Proveedor IA Local reporte los tokens reutilizados por su prompt cache. Los clientes externos pueden seguir usando todos los endpoints OpenAI-compatible del gateway.

Las respuestas se interpretan como Markdown con `marked` (GFM) y se sanean con `DOMPurify` antes de mostrarse. Se admiten encabezados, listas, enlaces, citas, tablas, tareas, código en línea y bloques de código copiables sin confiar en el HTML devuelto por el modelo.

El compositor permite adjuntar hasta cuatro archivos mediante el selector, arrastrando o pegando imágenes. JPEG, PNG, WebP y GIF se optimizan localmente y se envían a Proveedor IA Local como contenido visual compatible con OpenAI; para interpretarlas, el modelo seleccionado debe ser multimodal o de visión. PDF, DOCX, TXT, Markdown, CSV y JSON se procesan temporalmente en memoria, se convierten a texto y se incorporan al contexto con su nombre. Los documentos admiten hasta 6 MB y 120.000 caracteres extraídos; nunca se escriben en disco. Las imágenes y el texto extraído forman parte del historial local del navegador para conservar el contexto de la conversación.

La extracción usa el endpoint protegido `POST /chat/api/attachments/extract`, por lo que también exige una clave de usuario activa. El navegador reduce cada imagen a un máximo de 1,3 MB antes de almacenarla y enviarla. Si `localStorage` se llena, la interfaz avisa para que se eliminen chats antiguos.

### Contexto web con Brave Search

Desde **Configuración → Contexto web · Brave Search** puede guardar el token de [Brave Search](https://api.search.brave.com/api-reference/web/search/get). El secreto se conserva en SQLite sólo en el servidor y nunca se entrega al navegador ni al proveedor local. Una vez configurado, el chat muestra el botón **Web**: al activarlo para un mensaje, benzIA consulta la API Web estándar de Brave, incorpora hasta seis fuentes con sus extractos sólo a esa respuesta, y muestra las fuentes al usuario.

El contexto recuperado se marca como contenido externo no confiable antes de llegar al modelo; no se persiste junto a las conversaciones ni forma parte del siguiente turno. El endpoint protegido `POST /chat/api/web-search` requiere una clave de usuario válida. Brave limita la consulta a 400 caracteres/50 palabras, usa búsqueda segura moderada y aplica un timeout de 30 segundos. Puede cambiar el endpoint HTTPS desde el panel si Brave ofrece una ruta distinta; el predeterminado es `https://api.search.brave.com/res/v1/web/search`.

Al usar el botón **Web**, el chat inicia una investigación visible: el backend entrega al modelo local una ventana de hasta 12 mensajes para decidir primero si la web aporta valor. Si hace falta, genera entre una y tres consultas autónomas, ejecuta esas búsquedas de Brave en paralelo, descarta URLs repetidas y construye un dossier de hasta ocho fuentes; si no, continúa directamente con la respuesta y lo comunica en la interfaz. El navegador recibe eventos SSE de planificación, búsquedas, selección de evidencia y respuesta final; muestra esos pasos y las fuentes, pero nunca el razonamiento interno ni los prompts de sistema. Las citas `[n]` que el modelo incluya en la respuesta se convierten en enlaces a esas fuentes. Si el planificador no devuelve JSON válido o falla, benzIA usa una consulta contextual de respaldo en lugar de interrumpir el turno. La llamada de planificación queda registrada como telemetría atribuida al token; la respuesta final continúa atravesando el gateway normal.

## Métricas y caché del proveedor

- Cuando Proveedor IA Local entrega `usage`, benzIA conserva sus contadores exactos.
- Si no entrega `usage`, se usa una estimación y la traza queda marcada internamente como `estimated`.
- En streaming se solicita `stream_options.include_usage`, se reenvía el SSE sin esperar a que termine y se registra el bloque final de uso/estadísticas.
- benzIA no almacena respuestas ni implementa una caché propia: cada petición autenticada llega al proveedor configurado.
- La caché de prompt/KV del proveedor se contabiliza cuando el upstream devuelve `usage.input_tokens_details.cached_tokens` o un campo compatible. Si el endpoint no lo incluye, el panel lo indica como **no reportado**, que no equivale a un 0 % de reutilización.
- El dashboard muestra tokens de entrada reutilizados, tokens procesados (`input_tokens - cached_tokens`) y el porcentaje de reutilización. Esta métrica es proporcional por tokens, no un estado binario `HIT`/`MISS` por petición.
- Durante una respuesta en streaming, el dashboard muestra el estado de emisión y una velocidad aproximada. Al terminar se conserva `tokens_per_second` si Proveedor IA Local lo reporta; en caso contrario se calcula con los tokens de salida y el tiempo de generación observado.
- Las mediciones estimadas antiguas se recalculan de forma conservadora usando la duración completa de la petición; las nuevas incluyen también los fragmentos de razonamiento para no inflar la velocidad.
- Las métricas, claves y ajustes persisten en `data/gateway.sqlite`, con SQLite en modo WAL e índices de consulta.
- Al arrancar por primera vez con SQLite, benzIA importa automáticamente el antiguo `gateway.json` y conserva una copia `gateway.json.migrated` como respaldo.

No se guardan prompts, mensajes, embeddings ni respuestas. Cada métrica contiene identidad, endpoint, modelo, fecha, estado, latencia, tokens, rendimiento y, cuando el proveedor lo informa, los tokens de entrada reutilizados por su caché.

## Puertos y configuración

| Variable | Predeterminado | Función |
|---|---:|---|
| `ADMIN_HOST` | `127.0.0.1` | Interfaz del panel |
| `ADMIN_PORT` | `3400` | Puerto del panel |
| `GATEWAY_HOST` | `0.0.0.0` | Interfaz pública del gateway |
| `GATEWAY_PORT` | `3401` | Puerto compatible con OpenAI |
| `PUBLIC_GATEWAY_URL` | `http://localhost:3401` | URL mostrada en el panel |
| `LM_STUDIO_BASE_URL` | `http://127.0.0.1:1234` | Servidor de Proveedor IA Local |
| `BRAVE_SEARCH_ENDPOINT` | `https://api.search.brave.com/res/v1/web/search` | Endpoint opcional de contexto web de Brave |
| `BRAVE_SEARCH_API_KEY` | — | Clave opcional de Brave Search; también configurable desde el panel |
| `METRICS_RETENTION_DAYS` | `30` | Retención de telemetría |
| `REQUEST_TIMEOUT_MS` | `300000` | Timeout de inferencia |

Cambiar los puertos requiere reiniciar el proceso. La URL y clave upstream, además de la URL pública que ven los clientes, se pueden actualizar en caliente desde el panel.

### Subdominio HTTPS de Cloudflare

En **Configuración → Acceso público** puede indicar una URL como `https://llm.example.com`. benzIA la mostrará como endpoint de conexión para los clientes. Este ajuste no crea el DNS ni el túnel: en Cloudflare debe apuntar ese hostname al origen `http://localhost:3401`, normalmente mediante Cloudflare Tunnel, y mantener el panel administrativo fuera de la ruta pública.

El mismo origen publica el panel en `/dashboard` y el chat en `/chat`. Las carcasas HTML/CSS/JS se sirven sin autenticación, pero no contienen datos administrativos ni acceso al modelo. Todas las consultas y operaciones de `/admin/api/*` requieren `ADMIN_TOKEN`; `/chat/api/*` y `/v1/*` requieren una clave de usuario activa. Se recomienda añadir además una política de Cloudflare Access para `/dashboard`, `/keys`, `/activity`, `/settings` y `/admin/api/*`.

`/status` es la vista de estado para usuarios y funciona igual que `/chat`: la página se abre sin autenticación y solicita una clave de acceso benzIA (las creadas en **Claves API** del panel). Con una clave válida da acceso únicamente al dashboard en modo solo lectura, sin menú lateral ni acceso a utilidades, configuración, servidor o gestión de claves. Una clave pausada puede abrir la página pero ve su aviso de pausa en lugar del dashboard; las revocadas son rechazadas.

## Docker

Copie `.env.example` como `.env`, cambie el token administrativo y ejecute:

```powershell
docker compose up -d --build
```

El compose expone el panel sólo en localhost y usa `host.docker.internal` para llegar a Proveedor IA Local en el host.

### Despliegue en Coolify / VPS

El `Dockerfile` está preparado para desplegar benzIA como una aplicación Docker en Coolify:

1. Cree una aplicación desde el repositorio Git y seleccione **Dockerfile** como método de build.
2. Use el puerto público interno `3401`.
3. Añada un volumen persistente montado en `/app/data`; ahí se guarda `gateway.sqlite` y la configuración persistente.
4. Configure las variables de entorno, como mínimo:

   ```text
   ADMIN_TOKEN=<secreto-largo-y-unico>
   GATEWAY_HOST=0.0.0.0
   GATEWAY_PORT=3401
   ADMIN_HOST=127.0.0.1
   DATA_DIR=/app/data
   LM_STUDIO_BASE_URL=https://<endpoint-del-proveedor-compatible>
   PUBLIC_GATEWAY_URL=https://<dominio-publico>
   ```

5. Configure el dominio y TLS desde Coolify. Los clientes usarán `https://<dominio-publico>/v1` y el panel autenticado estará en `https://<dominio-publico>/dashboard`.

En un VPS no se debe usar `127.0.0.1:1234` para `LM_STUDIO_BASE_URL` salvo que el proveedor esté dentro del mismo contenedor. Use la IP privada, el nombre DNS interno o una red Docker compartida. No publique el puerto 3400: el panel administrativo queda ligado al contenedor y se accede mediante `/dashboard` en el gateway autenticado.

## Producción

benzIA está pensado para redes de confianza. Para acceso por Internet, colóquelo detrás de Caddy, nginx o un túnel con TLS; limite el panel a localhost/VPN; proteja y copie el volumen `data`; y no reutilice `ADMIN_TOKEN` como clave de usuario.

Ejecute las pruebas con `npm test`.
