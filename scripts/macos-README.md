benzIA para macOS (Apple Silicon, M1 a M5)
==========================================

Que incluye
-----------
- benzia.command .... doble clic para arrancar benzIA.
- app/ .............. el programa (codigo y dependencias).
- runtime/ .......... Node.js 24 para Apple Silicon incluido (no hay que
                      instalar nada en el Mac).
- data/ ............. se crea solo al arrancar: ahi queda la base de datos
                      (claves, metricas, ajustes).

Primera vez en tu Mac
---------------------
1. Descomprime el ZIP en una carpeta (por ejemplo, Escritorio/benzia).
2. Como el paquete no esta firmado por un desarrollador de Apple, macOS puede
   bloquearlo la primera vez: clic derecho sobre benzia.command -> Abrir ->
   Abrir. Las siguientes veces ya vale con doble clic normal.
3. Se abre una terminal con el arranque. Abre en el navegador:
   Panel de administracion:  http://localhost:3400/dashboard
   Chat publico:             http://localhost:3401/chat
4. Para salir: Ctrl+C en esa terminal (o cierra la ventana).

Configuracion
-------------
- Copia app/.env.example a app/.env y edita lo que necesites (puertos, URL de
  LM Studio, etc.). Sin .env se usan los valores por defecto.
- Si LM Studio corre en otra maquina, cambia LM_STUDIO_BASE_URL en .env.
- El panel de administracion escucha solo en el propio Mac (127.0.0.1); el
  chat y la API si estan accesibles desde la red local.

Notas
-----
- La base de datos queda en data/ dentro de esta carpeta: copiar la carpeta
  completa mueve el servidor con sus claves.
- La funcion OpenAI Codex del panel requiere el ejecutable de Codex instalado
  aparte (no viene en el paquete); el resto de benzIA funciona sin el.
