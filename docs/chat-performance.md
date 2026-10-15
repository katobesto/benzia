# Fluidez del chat

Revisión del 15 de octubre de 2026. Se conserva JavaScript nativo: el trabajo
repetido de renderizado, resaltado y estimación era el coste observable. Introducir
un framework no elimina por sí mismo esos costes y exigiría migrar las funciones
existentes.

## Cambios

- Se conservan los nodos de los mensajes que no cambian, incluso al enviar,
  investigar o terminar una respuesta. Los índices incluyen correctamente los
  mensajes de sistema del historial.
- El streaming se agrupa con `requestAnimationFrame`, sin la espera fija de
  100 ms. El Markdown en curso se analiza en un worker, con una sola operación
  pendiente y la actualización más reciente agrupada. Los bloques ya terminados
  mantienen sus nodos, selección de texto y botones.
- Otro worker resalta únicamente código terminado y cercano al área visible.
  La caché se limita a 80 entradas y dos millones de caracteres de claves y HTML.
  Se conservan los alias de lenguajes, la copia y la vista previa HTML. Si el
  navegador bloquea los workers, se usan las librerías locales en la interfaz.
- Todo el HTML continúa pasando por DOMPurify antes de insertarse, también el
  resultado del worker. Los workers solo cargan recursos del mismo origen.
- La estimación de tokens inspecciona cada fragmento una vez. Sus resultados
  coinciden con la estimación anterior, incluidas las reglas de espacios y Unicode.
  Las estadísticas visibles se actualizan con su temporizador independiente.
- Los guardados se agrupan para ejecutarse cuando el navegador queda libre,
  con un plazo de 500 ms; se fuerzan al ocultar/cerrar la página y antes de
  reconectar. Se mantienen el formato y las claves de `localStorage`, sin migrar
  ni borrar conversaciones, adjuntos, instrucciones o credenciales.
- Se construye el cuerpo de Chat Completions solo cuando se usa ese protocolo.
  Si Responses devuelve 404/405/501 y Chat Completions acepta el turno, se recuerda
  esa compatibilidad durante cinco minutos en memoria; reconectar la reinicia.
  Los errores 400/422 no establecen esa preferencia.
- El lector SSE comparte la lógica entre investigación y respuesta; admite UTF-8
  fragmentado, CRLF, datos multilínea y un evento final sin separador. Los errores
  de investigación se propagan y cierran la lectura.
- La respuesta sigue el final mientras el usuario está cerca de él, y respeta
  que vuelva arriba. El salto explícito al final conserva su desplazamiento suave.
- La cabecera y el compositor caben desde 320 px con búsqueda web y esfuerzo
  activos. La altura responde a `visualViewport` para adaptarse al área disponible
  con teclado; se permite el zoom y se mantiene la preferencia de movimiento reducido.

## Comparación local

Chromium de escritorio, viewport de 1440 × 900, mismo equipo y un proveedor
simulado con fragmentos cada 12 ms. Historial de 120 mensajes con Markdown y código;
respuesta de 82 fragmentos. La versión anterior incluye los cambios locales que
ya existían al empezar esta revisión.

| Medida | Antes | Después |
| --- | ---: | ---: |
| Apertura hasta interfaz lista y dos frames de asentamiento | 348 ms | 229 ms |
| Clic en enviar hasta primer texto visible | 345 ms | 112 ms |
| Parseos Markdown en el hilo de la interfaz durante el turno | 377 | 4 |
| Tiempo de esos parseos | 22 ms | 6 ms |
| Tareas largas observadas durante el turno (>50 ms) | 2 (137 y 77 ms) | 0 |
| Mayor intervalo entre frames durante el turno | 134 ms | 50 ms |
| Primer nodo del historial conservado | No | Sí |

Es una muestra local orientativa, no una garantía de latencia. El contador de
parseos excluye el trabajo trasladado al worker. Se mide la interfaz, no la
velocidad del modelo, su prefill, su cola, la red o Cloudflare. La comprobación de
área reducida simula el cambio de viewport; no sustituye probar un teclado físico
en Safari/iOS y Android.

## Verificación

`npm test` ejecuta las pruebas de servidor y las pruebas puras nuevas de SSE,
estimación y workers. `npm run test:chat-ui` usa Playwright con Chromium y un servidor
aislado, sin claves reales, sin consultar un proveedor y sin modificar datos del
usuario. Requiere Playwright instalado o `PLAYWRIGHT_MODULE_PATH` apuntando a su
`index.mjs`; `PLAYWRIGHT_EXECUTABLE_PATH` permite usar un Chromium existente.

Las pruebas de navegador cubren historial largo con mensajes de sistema, DOM
estable durante streaming, adjuntos multimodales y documentos, instrucciones,
esfuerzo de razonamiento, sanitización, resaltado, copia de código, guardado y
recarga, cancelación, regeneración, compatibilidad entre protocolos, ausencia de
workers, investigación y citas, dossier temporal y controles en pantallas de
320/390/768/1024/1440 px y un viewport de 390 × 400.

Los cambios de interfaz se aplican al recargar `/chat`; no requieren cambiar
proveedores, datos ni configuración del modelo.
