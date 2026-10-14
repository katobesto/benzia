# Verificación de la caché KV

Revisión del 13/10/2026 tras detectar prefill lento en benzIA con Qwen 3.8 27B.

## Resultado y alcance

Las optimizaciones recientes del proxy preservan el historial y los campos de identidad/continuidad de caché que reciben del cliente. Se han añadido siete pruebas de regresión y se ha ejecutado la suite completa: **106 pruebas correctas, cero fallos**.

Esto verifica el transporte y la contabilidad de benzIA. No garantiza un acierto KV del motor para cualquier conversación: depende también del historial construido por el cliente, la plantilla, el estado residente y la política de checkpoints del backend. La causa concreta de cada pérdida de prefijo no queda determinada sin comparar las peticiones correspondientes.

## Comprobaciones del proxy

`test/proxy-kv-cache.test.js` comprueba:

- Igualdad byte a byte del JSON enviado al proveedor en una conversación local, con espacios, Unicode, contenido multimodal, razonamiento histórico y argumentos de herramientas como cadenas JSON.
- Conservación del prefijo al añadir nuevos mensajes, sin llamadas auxiliares de inferencia.
- Conservación de `cache_prompt`, `prompt_cache_key`, `prompt_cache_retention`, `id_slot`, `n_keep`, `session_id`, `preserve_thinking`, `chat_template_kwargs`, `reasoning_effort`, límites de salida y herramientas.
- Conservación en Responses de `instructions`, `input`, elementos de razonamiento, `previous_response_id` y `store`, sin convertir el protocolo.
- Enrutado externo que modifica únicamente el identificador público del modelo.
- Reintento de `include_usage` que conserva el resto del cuerpo; un error de contexto no duplica la inferencia.
- Reenvío idéntico del SSE, incluso con caracteres UTF-8 fragmentados, y conservación de `cached_tokens` cuando después llega un evento de cierre sin uso.

La caché de catálogo de 15 segundos guarda metadatos de modelos; no contiene KV del motor. Los ajustes del streaming actúan sobre la entrega de la respuesta y sus contadores. No se han añadido operaciones para vaciar, recargar, restaurar o reconfigurar la caché del proveedor.

## Evidencia del backend en ejecución

El proveedor local configurado en SQLite es `http://127.0.0.1:8081`. En esta revisión corresponde a `ninfer-serve.exe`, bajo `benzIAServer/models/ninfer/releases/v1.2.0`, con Qwen 3.8 27B. El proceso anuncia una concurrencia de 1, contexto/KV de 210.000 tokens y `rk4v4-e8`. Está arrancado con `--preserve-thinking` y sin `--no-prefix-reuse`.

Se leyeron las métricas existentes de benzIA y `benzIAServer/logs/ninfer-serve.log`, además de los endpoints de consulta `/health`, `/props` y `/v1/models`. Las pruebas de inferencia se hicieron contra servidores simulados, sin introducir prompts de prueba en la caché de producción ni reiniciar el motor.

Ejemplos del log de NInfer, en hora local de Madrid:

| Momento | Entrada | Tokens reutilizados | Ruta elegida por el motor | Primer token en el motor |
| --- | ---: | ---: | --- | ---: |
| 20:24:26 | 81.883 | 0 | `full_reset` | 49.344 ms |
| 20:24:55 | 82.657 | 82.625 | `append_frontier` | 792 ms |
| 21:26:30 | 86.040 | 85.973 | `append_frontier` | 1.144 ms |
| 21:30:55 | 86.524 | 0 | `full_reset` | 52.999 ms |

La primera métrica de benzIA con la instrumentación nueva es de las **21:18:40** locales. Por tanto, hay pérdidas completas de reutilización y prefills de unos 49 segundos anteriores a esa instrumentación, y aciertos casi completos posteriores. Esto descarta que la optimización haya desactivado globalmente la caché; no prueba por sí solo la causa de cada fallo.

Para la petición de las 21:30:55, benzIA registra 53.032 ms hasta observar texto, 30 ms de preparación, 0 ms de cola propia y 556 ms hasta recibir cabeceras. NInfer registra 52.999 ms hasta el primer token y `cache=0`. Ambos sistemas coinciden: en ese caso el tiempo se consume procesando de nuevo el contexto dentro del motor. El contador no es un cero inventado por la nueva estimación.

## Factores que siguen pudiendo afectar a la reutilización

1. **Límite de salida de 32k.** Es un cambio previo solicitado para el chat. NInfer reserva recursos según entrada más presupuesto de salida, y la generación consume KV. Puede aumentar reserva/ocupación y duración, aunque no es una orden de vaciado. No se ha reducido ese límite durante esta verificación.
2. **Razonamiento histórico del chat.** `messagesForChatCompletions()` construye mensajes con `role` y `content`, omitiendo `message.thinking` de los turnos anteriores. Esa función ya era así antes de la última optimización. Con un motor que conserva razonamiento, reconstruir el historial sin él puede cambiar el prefijo. Las peticiones de otros clientes que sí envían `reasoning_content` o `reasoning` atraviesan el proxy intactas; lo cubren las pruebas. Corregir el historial que construye el chat requiere tratarlo como un cambio de entrada al modelo, no como una optimización invisible del transporte.
3. **Cambio de esfuerzo, instrucciones, herramientas, documentos o turno anterior.** Puede cambiar la representación tokenizada del prefijo. Los logs consultados muestran también llamadas a herramientas, por lo que no es correcto atribuir todas las peticiones largas al chat web.
4. **Estado/checkpoints disponibles.** La documentación de la versión de NInfer distingue `full_reset`, `append_frontier` y restauración de checkpoint. Reutilizar tokens requiere que también exista el estado de continuación compatible; un prefijo textual parecido no basta. [Contrato de NInfer v1.2.0](https://github.com/UDPSendToFailed/ninfer-4090/blob/v1.2.0-rtx4090/docs/serving.md).

No se han modificado el historial que construye el chat, sus 32k de salida, los parámetros del motor ni su caché durante esta auditoría. Los cambios de esta revisión son las pruebas y esta documentación.
