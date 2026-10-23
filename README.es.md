# inemaccbot

**🇧🇷 [Português](README.md) · 🇺🇸 [English](README.en.md) · 🇪🇸 [Español](README.es.md)**

Gateway de Telegram + cola duradera. Sucesor de `inemaccvbot`.

## 📖 Guía de uso

Guía completa (landing + paso a paso): **https://inematds.github.io/inemaccbot/guia/es/**

Mapa de la arquitectura (diagramas del bot, de `promoavatar` y de `promoavatar3`, los archivos de
configuración y dónde cambiar cada cosa): **https://inematds.github.io/inemaccbot/guia/es/arquitetura.html**

**Estado: etapas 0 a 5 concluidas, además de los flujos de dominio.** La cola es duradera (SQLite en
WAL, lease con heartbeat, drain, claim atómico), el gateway se comunica con Telegram, las skills
se ejecutan como agente (`transcrever`, `dublar`, `explicativo`, `curso`, `demo`, `reel`,
`reelinematds`), y el motor de flujos ejecuta pipelines con estado por fase y objetivo,
definición congelada, puerta humana y reanudación. La v1 (`inemaccvbot`, `mkivideos`,
`mkitexto`) está desactivada.

Lo que **no** existe a propósito: barrera entre fases, preemption de jobs, límite global de
agentes, multiusuario. Ver §11 de la spec: cada elemento incluye el criterio para reconsiderarlo.

**¿Vas a conectar un nuevo dominio/skill al bot?** Empieza por el **porqué** —
[`docs/integrar-um-repo.md`](docs/integrar-um-repo.md): por qué el bot conoce la
FICHA del repo y no su código, por qué los scripts forman un par (uno costoso con
modelo y otro barato y determinista), cómo funcionan la entrada, la salida y las puertas, y la
tabla de modos de falla que ya nos afectaron. Después, cada ruta tiene su par de
scripts, y ambas cuentan con el paso a paso manual como lectura de contexto:

- **Skill** (un comando, un artefacto) → [`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md)
  — `gerar-manifesto` una vez, `plugar-repo` en cada máquina.
- **Flujo** (fases con estado y puerta) → [`docs/plugar-fluxo.md`](docs/plugar-fluxo.md)
  — `gerar-manifesto-fluxo` una vez, `plugar-fluxo` en cada máquina. El manifiesto
  incluye la definición y la materializa en el repo de dominio, **sin sobrescribir**
  lo que ya esté allí. Incluye el guion de prueba en la VPS, los límites conocidos y el
  estado de la verificación. **Nuevo en 0.6.x, todavía sin uso en producción.**
- **Manualmente, con un ejemplo real** → [`docs/instalar-analisevideo.md`](docs/instalar-analisevideo.md)
  — ambas rutas, paso a paso. Explica qué automatizan los scripts.

## Instalación (paso a paso)

Desde cero hasta que `/ping` responda en Telegram. Probado en Ubuntu con Node v24.

**Acceso directo:** `./scripts/instalar.sh` ejecuta los pasos del 1 al 7 y se detiene ante lo que requiere tu intervención
(token, inicio de sesión de Claude, CTA, inicio de sesión de HeyGen), enumerando cada pendiente y lo que
falla si no se resuelve. `--checar` no cambia nada, solo indica qué falta; `--sem-chromium` omite la
descarga de ~400 MB. Puedes ejecutarlo de nuevo sin riesgo. Los pasos de abajo son lo que hace; léelos
si quieres entenderlo o hacerlo manualmente.

### 0. Requisitos previos

| qué | para qué | sin esto |
|---|---|---|
| **Node 22+** (`node -v`) | el proceso | no inicia. Ubuntu 24.04 trae la versión 18: usa el repositorio NodeSource 22.x |
| **`claude` en PATH y CON SESIÓN INICIADA** | motor predeterminado de los jobs de agente (`src/fila/runner-claude.ts`) | el bot inicia, pero todos los jobs de agente fallan. Instalar ≠ autenticar: verifica con `claude auth status` (espera `"loggedIn":true`) |
| **`ffmpeg`** | tarea `ffmpeg.thumb` y audio/video de las skills | fallan las miniaturas y el renderizado |
| **`python3` + `bash`** | la fase de reel ejecuta `montar-reel.py` en segundo plano | falla la fase `reel.montar` |
| **Chromium de Playwright** | `scripts/heygen-estudio.mjs` (`chromium.launchPersistentContext`) | falla la ruta `\| estudio`. `npx playwright install chromium`: la versión de Playwright está fijada en `package.json` |
| **`sqlite3` (CLI)** | opcional: inspeccionar la cola manualmente (`select ... from jobs`) | solo pierdes el diagnóstico manual |

La base de datos en sí usa `better-sqlite3` (se compila en `npm install`), no la CLI.

`claude` es el motor **predeterminado**, no el único: `codex` y `opencode` ya están
registrados como alternativas y se activan por job (`| motor=codex`), por skill o
mediante `.env`. Ver [`docs/motor-codex.md`](docs/motor-codex.md) y
[`docs/motor-opencode.md`](docs/motor-opencode.md). La ausencia del binario de un motor alternativo
**no** impide el inicio; solo falla quien lo solicite.

**Playwright en un sistema operativo recién lanzado (p. ej., Ubuntu 26.04):** no uses `--with-deps`. La lista
de paquetes depende de la versión del sistema operativo y, si es demasiado nueva, la instalación falla de inmediato;
eso fue lo que bloqueó la instalación en una VPS 26.04. Descarga solo el navegador (`npx playwright install
chromium`); si Chromium no inicia por falta de una biblioteca, prueba `npx playwright
install-deps`, sabiendo que quizá tampoco tenga una receta para tu sistema operativo. En ese caso,
el pin `playwright@1.57.0` es demasiado viejo para la máquina y tendrás que actualizar la versión,
probando la ruta `| estudio`, porque automatiza una interfaz y depende de los tiempos.
Nada de esto afecta al resto del bot: sin Chromium, solo queda fuera la ruta `| estudio`.

### 1. Clonar e instalar

```bash
git clone git@github.com:inematds/inemaccbot.git ~/projetos/inemaccbot
cd ~/projetos/inemaccbot
npm ci            # `ci`, no `install`: instalación reproducible a partir del lockfile
```

**Todavía no ejecutes `npm test`.** La suite solo pasa después del paso 2; sin los repos
de dominio, docenas de pruebas fallan porque falta `flow.json`.

Si `npm run build` muestra `tsc: not found`, `npm ci` omitió las devDependencies (es lo que
hace `NODE_ENV=production` automáticamente, algo común en servidores). Vuelve a ejecutarlo con
`NODE_ENV=development npm ci --include=dev`. La advertencia de `npm audit` es ruido de
dependencias transitivas: **no** ejecutes `audit fix --force`, porque deshace el pin de Playwright.

### 2. Repos de dominio (hermanos, no submódulos)

`config/fluxos.json` declara los repos que los flujos cargan desde `PROJETOS_DIR`
(predeterminado: **la carpeta que contiene este clon**; los repos de dominio son hermanos de
inemaccbot, así que quien clonó todo junto no necesita declarar la variable, ya sea que esté
en `~/projetos`, `/root/projetos` o `/opt`). No vienen en el clon
ni son submódulos: clona ambos como hermanos de este directorio:

```bash
cd ..   # la carpeta que contiene inemaccbot
git clone https://github.com/inematds/promoavatar.git
git clone https://github.com/inematds/promoavatar3.git
# los otros flujos del catálogo (solo si vas a usar su comando)
git clone https://github.com/inematds/musicavideo.git
git clone https://github.com/inematds/r7ex.git
git clone https://github.com/inematds/explicavideos.git
```

Sin ellos, el bot inicia, pero docenas de pruebas fallan y `/promoavatar` y `/promoavatar3`
fallan en la primera fase.

### 3. El CTA (incluido en el clon desde 2026-08-08)

`promoavatar` y `promoavatar3` requieren `cta/cta-9x16.mp4`. Antes era un activo externo: ambos
repos ignoran `*.mp4` y el archivo no venía en el clon, lo que hacía que **2 pruebas
fallaran** en una máquina nueva. Ahora está versionado en ambos, gracias a una excepción explícita
en su `.gitignore` (`!cta/*.mp4`): pesa 60 KB y el archivo no se puede regenerar.

```text
~/projetos/promoavatar/cta/cta-9x16.mp4
~/projetos/promoavatar3/cta/cta-9x16.mp4
```

**No hay nada que hacer en este paso**: solo verifica que existan ambas rutas después del paso 2.
Si faltan, tu clon es anterior al cambio: ejecuta `git pull` en cada repo.

Formato esperado: 1080x1920, H.264/`yuv420p`/30 fps, AAC 48 kHz estéreo; el pipeline
concatena sin volver a codificar cuando coinciden los parámetros.

### 4. Probar y compilar

```bash
cd ~/projetos/inemaccbot
npm test           # ahora sí: 788/788
npm run build      # genera dist/index.js: la unidad systemd se ejecuta desde allí, no desde src/
```

### 5. Crear el bot en Telegram

Habla con [@BotFather](https://t.me/BotFather) → `/newbot` → te devuelve el token.
Ese valor es el `BOT_TOKEN` del paso 6: **nunca hagas commit del archivo que lo contiene** (ver §`.env`).

### 6. Escribir el `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Completa las cinco variables obligatorias (tabla completa en [`.env`](#env)) y reemplaza `/CAMINHO/PARA`
por las rutas reales. Las opcionales tienen un valor predeterminado derivado de `$HOME`; puedes omitir esa línea.

#### Cómo descubrir el chat id de Telegram (no necesitas saberlo de antemano)

Deja `ALLOWED_CHAT_IDS=0` en `.env`. Este es el **modo de emparejamiento**: el bot todavía no
tiene dueño. Inícialo (paso 7), abre tu bot en Telegram y envía `/ping`.

El primer `/ping` que llegue registra ese chat como dueño: el bot responde
confirmando el id, guarda ese id en `ALLOWED_CHAT_IDS` en `.env` (solo cambia esa línea;
los comentarios y el resto del archivo quedan intactos) y **cierra el acceso**. El
segundo chat que lo intente será rechazado en silencio.

El registro se aplica de inmediato, sin reiniciar: el siguiente mensaje de ese chat ya ejecuta
comandos normalmente.

**Qué significa esto, en términos claros:** mientras la lista de permitidos sea `0`, quien envíe
`/ping` primero se queda con el bot. Si se filtró el token o alguien conoce el @nombre del bot,
emparéjalo antes de dejarlo funcionando. Solo el mensaje de texto `/ping` permite emparejar; los
adjuntos, las fotos y cualquier otro mensaje no.

**Cambiar de dueño:** vuelve a poner `ALLOWED_CHAT_IDS=0` en `.env`, reinicia
(`systemctl --user restart inemaccbot`) y envía `/ping` desde el nuevo chat. Para autorizar
más de un chat, edita la lista manualmente: `ALLOWED_CHAT_IDS=111,222`.

Dejar `ALLOWED_CHAT_IDS` **vacío** no activa el emparejamiento; provoca un error de inicio a propósito:
la lista de permitidos es la única barrera entre el bot y todo Telegram, y una configuración
inválida debe detener el servicio al inicio, no dejar una puerta abierta.

### 7. Iniciar: primero manualmente y luego como servicio

Manualmente, para que el inicio muestre claramente cualquier error:

```bash
./start.sh       # registro en pantalla; Ctrl-C termina por la vía normal (SIGINT → drenar)
```

`start.sh` vuelve a compilar si `dist/` es más antiguo que `src/`, y **se niega a iniciar
si el servicio systemd ya está en ejecución**: dos procesos con el mismo `BOT_TOKEN`
compiten por `getUpdates` y el bot empieza a perder mensajes de forma alternada, un síntoma
costoso de diagnosticar. Para ignorar la negativa: `./start.sh --forcar`.

Un inicio correcto imprime la línea de recuperación de leases
(`boot: recuperación de leases — requeued=N failed=M`). Los errores de configuración o migración
detienen el proceso allí mismo a propósito: lee el mensaje antes de cambiar otra cosa.

Como servicio de **usuario** (no del sistema; la unidad no tiene `User=` y el objetivo es
`default.target`):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/inemaccbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inemaccbot
loginctl enable-linger "$USER"   # el servicio sobrevive al cierre de sesión / inicia al arrancar
```

Las rutas de la unidad usan `%h/projetos/inemaccbot`; si clonaste en otro lugar, edita
`WorkingDirectory` y `EnvironmentFile`, pero **no** `WantedBy`.

### 8. Verificar

```bash
systemctl --user status inemaccbot   # active (running)
tail -f "$(grep ^LOG_FILE .env | cut -d= -f2)"
```

En el chat: `/ping` responde, `/ajuda` lista los comandos y `/fila` muestra las colas vacías.
Si `/ping` no responde pero el servicio está `active`, el problema es la lista de permitidos: vuelve al paso 6.

### 9. Actualizar después

```bash
./atualizar.sh                 # bot + dominios, compila y reinicia
./atualizar.sh --sem-restart   # actualiza y compila, sin tocar el servicio
./atualizar.sh --agora         # reinicia aunque haya un job en ejecución (tú asumes el riesgo)
./atualizar.sh --sem-dominios  # solo el bot
```

**También actualiza los repos de dominio**, y esto no es una comodidad: el dominio
carga `flow.json`, prompts, plantillas y el motor del reel. Un bot nuevo con un dominio
antiguo ejecuta un prompt viejo y produce un video incorrecto, **sin mostrar ningún error durante el inicio**. La lista
sale de `config/fluxos.json`, la misma fuente que lee el bot. Los dominios con cambios locales se
**omiten**, nunca se guardan en stash: allí viven los textos generados por los flujos.

Hace lo que la actualización manual exigía recordar, en este orden: guarda los cambios
locales **de este repo** con `stash` (incluidos los cambios en el propio `atualizar.sh`; si
desaparecen, están en `git stash list`), ejecuta `git pull --ff-only`, `npm ci` **forzando `NODE_ENV=development`**
(si no, desaparecen las devDeps y la compilación falla con `tsc: not found`), `npm run build`, y solo
entonces reinicia, **detectando** si la unidad es de usuario o de sistema, en vez de
suponerlo.

**La consulta de jobs en curso no es opcional, y por eso se convirtió en una negativa.**
Reiniciar mientras hay un render en ejecución mata el proceso con SIGTERM y consume un intento del
job: consulta la sección [`código 143`](#código-143-no-é-erro-do-agente--é-restart). Cuando
esto ocurre, el código nuevo **ya está compilado**; solo queda pendiente el reinicio.

**Clon anterior a 2026-08-08:** el script lo detecta y lo explica. En esa fecha el repo se dividió y el proyecto público renació de un commit huérfano: quienes clonaron antes no tienen un ancestro
común con `origin`, y ningún `git pull` trae el código nuevo (el síntoma es «hice pull y no
llegó nada», y `start.sh` simplemente no existe). El script imprime las instrucciones de
migración con las rutas ya completadas, y conserva `.env`, la base de datos y los archivos no
rastreados. El historial anterior sigue en `inematds/inemaccbotx` (privado).

### 10. En una VPS: dónde está cada archivo

El `.env` del bot va en la **raíz del clon**, y no es una preferencia: `main()` lee
`resolve(process.cwd(), '.env')` y la unidad systemd usa `WorkingDirectory` +
`EnvironmentFile` apuntando a la misma carpeta. ¿Clonaste en otro lugar? Edita **ambas**
líneas de la unidad para que apunten al mismo directorio. Si difieren, systemd inyecta un
`.env` y `main()` lee otro, lo que provoca un síntoma confuso.

En una VPS que se ejecuta como `root`:

| archivo | quién lo lee | ruta |
|---|---|---|
| `.env` del bot (**config**) | `main()` + systemd | `/root/projetos/inemaccbot/.env` (`chmod 600`) |
| **cofre** (secretos de terceros) | `HEYGEN_ENV_PATH`, `GROQ_ENV_PATH`, `IMG_ENV_PATH` | `/root/projetos/wifi/.env` (`chmod 600`): es el **valor predeterminado**, creado por `scripts/instalar.sh` |
| inicio de sesión de Claude | CLI `claude` | `/root/.claude/.credentials.json` (`chmod 600`) |
| perfil de HeyGen (ruta `\| estudio`) | `HEYGEN_PERFIL_CHROME` | `/root/.cache/inemaccbot/perfil-heygen` |

Los repos de dominio (`promoavatar`, `promoavatar3`) **no tienen ningún `.env`**:
leen todo del entorno que el bot les transmite a los scripts secundarios.

**Fuentes de material (`config/fontes.json`): registradas, todavía no conectadas.** El
espejo del registro de destinos: el destino responde «a dónde va el artefacto»,
la fuente responde «de dónde viene el material» (explicativo, banda sonora, b-roll). El dominio
solicita por NOMBRE (`trilhas`), y el bot conoce la ruta. Hoy el CTA del reel es
una ruta dentro del dominio, justo el tipo de cosa que queda obsoleta al cambiar de
máquina. Dos reglas: **la fuente es una CARPETA** y **la elección del archivo es EXPLÍCITA**
(`lofi` → `trilhas/lofi.mp3`); los nombres ambiguos se rechazan, nunca se elige al azar: elegir
al azar rompería «mismo pedido, mismo resultado». El archivo es **opcional**: si falta,
el registro queda vacío. `src/dominio/fontes.ts` está listo y probado, pero **nada lo consume todavía**.
Conectarlo al chat y a `flow.json` es el siguiente paso, y ese sí cambia el comportamiento.

**Dos archivos, dos funciones**: confundirlos cuesta tiempo. El `.env` del clon es la
CONFIGURACIÓN del bot (`BOT_TOKEN`, `ALLOWED_CHAT_IDS`, rutas) y no puede salir de allí;
`wifi/.env` es el COFRE de secretos de terceros (`HEYGEN_API_KEY`,
`GROQ_API_KEY`, `GOOGLE_API_KEY`, `AGNES_API_KEY`), un archivo por máquina,
nunca versionado ni copiado con git. `scripts/instalar.sh` crea la
estructura del cofre con `chmod 600` e indica qué claves están vacías; completarlas
es tu responsabilidad.

#### `root` no es obligatorio, y un usuario de sistema es más adecuado

Ejecutar como `root` es el camino corto en una VPS, y es lo que incluye hoy
`deploy/inemaccbot-sistema.service`. No es lo correcto: el bot ejecuta
agentes que ejecutan comandos y no necesita privilegios administrativos.
En un servidor que haga más cosas que ejecutar este bot, crea un usuario de sistema
dedicado:

```bash
sudo useradd --system --create-home --home-dir /srv/inemaccbot --shell /usr/sbin/nologin inemabot
```

**Qué cambia al cambiar de usuario**: todo lo que se deriva de `$HOME`; aquí
es donde la migración queda a medias:

| elemento | valor con `root` | con un usuario dedicado |
|---|---|---|
| cofre (valor predeterminado de `HEYGEN_ENV_PATH`) | `/root/projetos/wifi/.env` | `<home>/projetos/wifi/.env` |
| inicio de sesión de Claude | `/root/.claude/` | `<home>/.claude/`: **es por usuario; hay que repetirlo o copiarlo con `chown`** |
| binario de Claude (`CLAUDE_BIN`) | `/root/.local/bin/claude` | el del nuevo `$HOME` o una ruta del sistema (`/usr/bin/claude`) |
| perfil de Chrome (`\| estudio`) | `/root/.cache/inemaccbot/perfil-heygen` | `<home>/.cache/…`: la sesión de HeyGen también es por usuario |
| clon, base de datos, `state/`, registro | `/root/projetos/inemaccbot/` | donde lo clones; los archivos deben pertenecer al nuevo usuario (`chown -R`) |
| `PROJETOS_DIR` | — | **no cambia**: el valor predeterminado es la carpeta que contiene el clon, no `$HOME` |

Y en la unidad: ajusta `User=`, `Group=`, `WorkingDirectory` y `EnvironmentFile`
en conjunto. La trampa clásica es `%h`, que en el ámbito del sistema se resuelve como
`/root` **incluso cuando el servicio se ejecuta con otro usuario**; por eso la unidad
de sistema usa una ruta absoluta, no `%h`. Si el `$HOME` del servicio no es el que
esperas, el síntoma siempre es el mismo: el cofre «no existe» y la clave «desapareció».

Hacer esta migración durante un flujo en curso implica perder trabajo: cambian los propietarios de
`state/` y de la base de datos. Detén el servicio, verifica `/status`, migra y solo entonces vuelve a iniciarlo.

**Servicio en la VPS: usa la unidad de SISTEMA.** La unidad de usuario
(`deploy/inemaccbot.service`) presupone una sesión y linger. En un servidor, lo correcto es
`deploy/inemaccbot-sistema.service`, que tiene `User=`, rutas absolutas y el objetivo
`multi-user.target`:

```bash
sudo cp deploy/inemaccbot-sistema.service /etc/systemd/system/inemaccbot.service
sudo systemctl daemon-reload && sudo systemctl enable --now inemaccbot
sudo systemctl stop|restart|status inemaccbot     # esto reemplaza un "stop.sh"
sudo journalctl -u inemaccbot -f
```

Ajusta `User=`, `WorkingDirectory` y `EnvironmentFile` antes de continuar. En el ámbito del sistema,
`%h` se resuelve como `/root` aunque el servicio se ejecute con otro usuario; esa es
la trampa clásica al migrar desde una unidad de usuario. Las dos unidades **no** pueden
ejecutarse al mismo tiempo con el mismo `BOT_TOKEN`.

Hay un atajo, aunque va en contra de la convención del cofre: como `.env` se
publica en el entorno del proceso (`exportarParaAmbiente`), puedes poner
`GROQ_API_KEY` directamente allí y omitir el cofre. Funciona, pero mezcla
secretos con configuración en un archivo que el modo de emparejamiento vuelve a escribir.
Es preferible usar el cofre y dejar `.env` para la configuración.

**Qué cambia de una máquina a otra** (el resto de `.env` es igual): `BOT_TOKEN`: usa un bot
propio; si no, las dos instancias compiten por `getUpdates` y cada una recibe la mitad de los
mensajes; `ALLOWED_CHAT_IDS=0` para emparejar con el primer `/ping`; `PUBLICO_URLS`, que
aquí son nombres de la red local y allí deben ser la IP o el dominio de la VPS; y
`HYPERFRAMES_BROWSER_PATH`, que apunta a un snap que probablemente no existe en la VPS
(elimina la línea para que vuelva a aplicarse el valor predeterminado).

El inicio de sesión de Claude y el de HeyGen **no requieren un navegador en la VPS**: ambos son
archivos y se transfieren por `scp`. El caso difícil es la ruta `| estudio`, cuya sesión
se topa con Cloudflare por la dirección IP; está documentado en `doc/` (fuera de git).

## Configuración: lo que solo TÚ puedes proporcionar

El bot no puede resolver nada de esto por sí solo: son secretos, cuentas y activos que están fuera del
repo. La columna de la derecha indica qué falla si falta cada elemento, para que no lo descubras durante
un renderizado.

| qué | dónde | si falta |
|---|---|---|
| **Token de Telegram** | `BOT_TOKEN` en `.env` (BotFather) | el inicio falla de inmediato: `config: falta BOT_TOKEN` |
| **Lista de chats permitidos** | `ALLOWED_CHAT_IDS` en `.env`, o `0` para emparejar con el primer `/ping` (paso 6) | dejarlo vacío detiene el inicio. Con un id incorrecto, el bot queda mudo: cada mensaje aparece como `rechazada — fuera de la lista de permitidos` en el registro |
| **Inicio de sesión de Claude** | `claude auth status` → `loggedIn: true` | el bot inicia y acepta comandos, pero **todos los jobs de agente fallan**. Es la falla más confusa de diagnosticar porque todo *parece* correcto |
| **Binario de Claude** | `CLAUDE_BIN` (predeterminado `~/.local/bin/claude`): **ruta, nunca PATH**; systemd se ejecuta con un PATH mínimo y `claude` usaría `/usr/bin/claude` del sistema, que puede ser mucho más antiguo | el inicio se niega a continuar si la ruta no existe. Con una CLI antigua, el síntoma es peor y silencioso: el agente pide permiso en cada `Write`, nadie responde y la fase termina sin escribir ningún archivo (C#77 y C#78) |
| **CTA `cta-9x16.mp4`** | versionado en ambos repos de dominio, en `cta/` (paso 3) | fallan 2 pruebas y ningún reel termina: la última fase concatena el CTA al final |
| **Perfil de Chromium con sesión iniciada en HeyGen** | `HEYGEN_PERFIL_CHROME` (predeterminado `~/.cache/inemaccbot/perfil-heygen`): inicia sesión **una vez, manualmente**, en ese perfil | falla la ruta `\| estudio`. Es una ruta, no un secreto: las cookies están dentro de la carpeta, fuera del repo |
| **Pantalla para la ruta `\| estudio`** | `DISPLAY` en el servicio (aquí `:99`, el Xvfb de `stack99.service`) | HeyGen **bloquea el navegador headless**: carga la app con sesión iniciada y superpone el modal de inicio de sesión, y la fase indica «la sesión no ha iniciado en este perfil» aunque las credenciales sean correctas. Sin `DISPLAY`, el script pasa a modo headless, que es lo correcto en una VPS sin Xvfb y lo incorrecto aquí |
| **Clave de API de HeyGen** | en el archivo indicado por `HEYGEN_ENV_PATH` (predeterminado `~/projetos/wifi/.env`, el cofre único del ecosistema); sirve cualquier archivo con una línea `HEYGEN_API_KEY=`; ver `.env.example` | fallan las rutas `\| api` y `\| creditos` |
| **CLI de HeyGen** | binario `heygen` en PATH o la ruta de `HEYGEN_CLI` | lo mismo |
| **Servidor del enlace final** | `PUBLICO_DIR` (la carpeta servida) + `PUBLICO_URLS` (las bases de URL) | se produce el video, pero el mensaje llega sin enlace de descarga. Son **dos** URL porque la máquina está en dos redes a la vez |
| **Repos de dominio** | `promoavatar` y `promoavatar3` como hermanos (paso 2), más `musicavideo`, `r7ex` y `explicavideos` para sus comandos | los flujos fallan en la primera fase |

Regla general: **`.env` guarda rutas e ids; los secretos de terceros van en el archivo de quien los administra.** Por eso la clave de HeyGen no se copió aquí.

En una máquina donde no existe ese «archivo de quien lo administra» —por ejemplo, una VPS—,
se recomienda mantener un archivo propio
(`~/.config/inemaccbot/heygen.env`, `chmod 600`) e indicarlo en `HEYGEN_ENV_PATH`.
Si prefieres juntar todo, `HEYGEN_ENV_PATH` puede apuntar al **propio `.env`**
del bot, y la clave va allí. Funciona sin cambiar código, pero mezcla secretos
con configuración. `.env.example` incluye ambas opciones.

## Uso en el chat

### Comandos de servicio

| comando | qué hace |
|---|---|
| `/ping` | verifica si el bot está activo |
| `/ajuda` (`/help`) | **el resumen**: lo básico y cómo llegar al resto |
| `/ajuda tudo` | la lista COMPLETA de comandos (sinónimos: `comandos`, `completa`, `all`) |
| `/ajuda <nome>` | la ayuda de UNA skill o flujo (`/ajuda promoavatar`) |
| `/skills` · `/fluxos` | los dos catálogos |
| `/fila` | por cola: en ejecución, pendientes, antigüedad, errores en 24 h, reintentados |
| `/espaco` | cuánto disco ocupa cada área (bot × skills), por separado |
| `/status` | los flujos ABIERTOS: lista de una línea (número · estado · tema) y luego el detalle de fase × objetivo de cada uno |
| `/completos` | los flujos que terminaron, del más nuevo al más antiguo |
| `/jobs` | la cola de jobs: qué se está ejecutando y qué terminó |
| `/status j13` · `/status A#9` | detalle de un JOB o un FLUJO |
| `/cancelar j13` · `/cancelar A#9 [público]` | lo mismo |
| `/refazer j13` · `/refazer A#9 [público]` | lo mismo; en un flujo, reanuda desde la fase que falló |
| `/furar j13` | pone un job pendiente al frente |
| `/pronto [ref]` | «terminé mi parte»: libera la puerta. Sinónimos: `/aprovar`, `/aprovado`, `/ok` |
| `/limpar <escopo>` | ver abajo |

**La ayuda tiene dos niveles y el corto es el predeterminado.** La lista completa supera las 30
líneas, incluido el catálogo de skills; ocupa toda la pantalla del celular para quien solo
quería liberar una puerta. `/ajuda` responde lo básico y explica las dos formas de
ver el detalle; `/ajuda tudo` sigue mostrando todo.

**Referencia de flujo:** `A#9`, `a#9`, `A9` y `a9` significan lo mismo. Un número
solo (`13`) siempre es un JOB. En la lista, un job aparece como `j13 · A#9/jovens`: la `j`
lo distingue de un id de flujo y el sufijo indica a quién pertenece el job.

**`/pronto` sin referencia** libera el flujo si solo uno está esperando. Si hay
varios, los enumera. Si no hay ninguno, lo indica.

**Se quita la puntuación al final de los campos.** `| sombra.` y `| alvos=a,b;` son válidos:
el punto final es una costumbre al escribir, no un error de uso. El TEMA no se modifica:
su puntuación es parte del contenido y los temas que son preguntas («¿esto es bueno o
malo?») la necesitan.

### Sacar un flujo de `/status`

El panel muestra `rodando` y `falhou`: los dos estados que todavía requieren algo de
ti. Un flujo fallido que no vas a reanudar se quita así:

| quiero | comando | qué ocurre |
|---|---|---|
| solo quitarlo de la lista | `/cancelar A#9` | pasa a `cancelado` y deja de aparecer tanto en `/status` como en `/completos`. El flujo sigue existiendo: `/status A#9` muestra todo |
| borrarlo definitivamente | `/limpar A#9` | elimina el flujo y los artefactos del disco. Muestra qué se va a borrar y solo lo ejecuta con `confirmar` |

`/cancelar` interrumpe los jobs pendientes y en ejecución. En un flujo que ya falló no hay
ninguno, así que «0 job(s) interrumpido(s)» es correcto, no un error. Lo que ya se creó
FUERA (un render en el estudio, un archivo entregado en el canal) sigue allí: cancelar
afecta al pipeline, no al mundo exterior.

### `código 143` no es un error del agente: es un reinicio

`claude saiu com código 143` significa `128 + 15` = **SIGTERM**: el proceso fue
terminado cuando se apagó el servicio, en medio del trabajo. Casi siempre se debe a un
`systemctl --user restart inemaccbot` mientras hay un job en ejecución.

Lo que ocurre con el job depende de cuántos intentos queden: si tiene un intento
disponible, se **requeued** y el siguiente inicio lo reanuda automáticamente; si no le quedan,
pasa a `failed`. Un render de reel tarda entre 10 y 15 minutos, así que dos reinicios seguidos
agotan los dos intentos del mismo job. Así murió `C#13/jovens-aut/reel`, después de los dos reinicios del día 2026-08-01.

**Antes de reiniciar, revisa la cola:**

```bash
sqlite3 inemaccbot.db \
  "select id,fila,tarefa,status,flow_ref from jobs where status in ('queued','running');"
```

Si no aparece nada, reinicia cuando quieras. Si hay un render en curso, espera o acepta
consumir uno de sus intentos. Después basta con `/refazer A#9 <alvo>`: SIGTERM no corrompe nada;
el trabajo simplemente no terminó.

### Skills (una etapa, sin estado)

```
<skill>: <entrada> [| campo]*
```

| ejemplo | |
|---|---|
| `transcrever: https://…` | audio → texto |
| `dublar: https://… \| lives3` | y entrega en el canal |
| `explicativo: <assunto> \| vertical` | video explicativo 9:16 |
| `reel: /caminho/avatar.mp4 \| lives3` | reel apilado |
| `historia: Era uma vez… \| nome=baloes` | cuento → película narrada (Agnes, US$ 0) |
| `imagem: uma raposa ruiva na neve \| ratio=16:9` | imagen individual (Agnes, US$ 0) |

Campos genéricos: `livesN` (destino) · `modelo=haiku` · `esforco=high`. Los
campos propios de cada skill aparecen en `/ajuda <skill>`.

### Flujos (varias fases, con estado)

**`/r7ex <tema>`** (o `/rtex`, 0.24.11): reel viral r7ex sin puerta de control humana. Ficha +
puertas de control automáticas → producción del r7ex (avatar, montaje, revisor) → cola del canal.
El canal y el "ahora" salen del texto; el comando vale como OK del avatar. `/r7ex help` lo explica.

**`/explicavideo <asunto>`** (0.25.11): explicavideo con el avatar de Nei, 16:9, 9:16
o ambos, sin puerta de control humana. Ficha → avatar en HeyGen → visual v2 → render y
publicación en el canal (enlace en inemaytbot, archivo en el v3). El formato y el canal salen
del texto. `| portao` (vale también en `/r7ex`) se detiene para aprobar. `/explicavideo help` lo explica.

Todos los flujos del catálogo, con prefijo, fases y puerta de control: [`docs/fluxos.md`](docs/fluxos.md).

```
/promoavatar <assunto> [--alvo=jovens] [| legenda=nao] [| versao=N] [| de=<fase>] [| sombra]
```

| opción | predeterminado | |
|---|---|---|
| `--alvo=x` (repetible) o `\| alvos=a,b` | todos | solo esos públicos |
| `\| legenda=nao` | **activada** | desactiva los subtítulos del reel (una palabra a la vez, mayúsculas, tilde en la palabra clave). Ver `promoavatar/docs/legenda.md` |
| `\| api` · `\| creditos` · `\| estudio` · `\| navega` | ninguna | quién genera el avatar y de qué bolsillo sale el costo. **Solo una por flujo.** Si no eliges ninguna, tú grabas en el estudio. Ver [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md) |
| `\| versao=N` | 1 | cambia el `-vN` del título del estudio |
| `\| de=<fase>` | — | empieza a mitad del proceso (ya hiciste el texto o el avatar) |
| `\| sombra` | — | muestra el plan sin poner nada en la cola |
| `\| sem-portao` | — | llega hasta el final sin detenerse para `/aprovar`, **pero sigue enviando al chat** lo que cada fase haya declarado en `portao.mostrar` |

`|` y `--` pueden combinarse. **Se RECHAZA cualquier campo escrito sin uno de los dos**: no se convierte silenciosamente en tema, que es como un flujo llegó a tener 12 públicos por error.

La ayuda completa de cada flujo está en el repo de dominio: `/promoavatar help`.

### Limpieza

```
/limpar A#8            artefato + avatares + publicados daquele fluxo
/limpar promoavatar    todos os fluxos daquele tipo
/limpar artefatos 14   área do bot, por idade
/limpar tudo           artefatos + publicados dos fluxos conhecidos
```

**Simulación en seco de forma predeterminada**: si no incluyes la palabra `confirmar` al final, solo muestra
qué eliminaría y cuánto espacio liberaría. El filtro por flujo se basa en `flow_ref` en la base de datos, así que limpiar un
flujo mientras otro está en ejecución es seguro. El bot solo toca lo que ÉL publicó en
`~/projetos/output`; lo demás pertenece a otros proyectos.

## Cómo se incorpora un dominio nuevo

Esta es la prueba del diseño: **un dominio nuevo no debería requerir cambios de código en el bot.**

**Con un script (ruta A), en dos etapas.** `./scripts/gerar-manifesto.sh <url>` se ejecuta
donde hay un modelo: lee el repo (incluido el código del script, donde están las
trampas), propone parámetros y marca cuáles son **suposiciones**, te permite editarlos
y guarda `config/integracoes/<nome>.json` + `prompts/<nome>.md`, versionados para que
la instalación sea igual en todas las máquinas. Se ejecuta **una vez por repo**.

`./scripts/plugar-repo.sh <nome>` aplica un manifiesto ya
revisado de `config/integracoes/`: clona el repo hermano, verifica los binarios y las claves del
cofre, valida la entrada con el validador de BOOT antes de escribir, muestra el diff y se detiene.
Solo guarda cambios con `--sim`, y `--desfazer` los revierte. **No interviene ningún modelo**:
quien lee el repo y decide la cola, el timeout y el prompt es `gerar-manifesto`, una vez por
repo. Si no hay manifiesto, se niega a continuar en vez de adivinar.

Y `./scripts/preparar-repo.sh ~/projetos/<repo>` hace lo mismo para un repo **tuyo**,
guardando el manifiesto **dentro de él** (`integracao.json`). Así, cualquier instalación del
bot lo conecta solo con el nombre, sin un adaptador local.

→ **Cómo funcionan los tres, campo por campo:**
[`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md).

> 📘 **Ejemplo completo, desde el clon hasta el primer job:**
> [**`docs/instalar-analisevideo.md`**](docs/instalar-analisevideo.md): conectar un repo
> externo ([`analisevideo`](https://github.com/inematds/analisevideo)) por AMBAS rutas,
> con los campos que exige cada validador, la clave del cofre y la tabla de síntoma → causa
> cuando el inicio se niega a continuar. Las dos secciones de abajo son el resumen; el documento
> contiene las instrucciones paso a paso para seguir manualmente en una VPS.

### Una SKILL (una etapa, sin estado)

**Sin agente, cuando la skill solo ejecuta un comando.** Declara `comando` (y
`kind: "function"`) en vez de `prompt`, y el bot se encarga de ejecutarlo. Se aplica el mismo
criterio que en la ruta de flujo: agente donde piensa, función donde solo escribe comandos. Eso ocurría con
`analisevideo`: se pagaba un modelo para construir una línea de bash y, el 2026-08-21,
el modelo envió el script a segundo plano (aunque el prompt lo prohibía en negrita),
terminó el turno y el job murió sin contrato; el análisis también se perdió.

```json
{ "command": "analisevideo", "kind": "function", "repo": "analisevideo",
  "comando": "bash {{repo}}/analisevideo.sh analisa {{input}}",
  "artefato_exts": ["md", "json"], "aguarda_artefato": true }
```

Marcadores: `{{repo}}` y `{{input}}` (ambos obligatorios), `{{saida}}` y los
`campos` declarados; todos entre comillas. Con `aguarda_artefato`, el bot ejecuta el proceso
en segundo plano y lo supervisa, así que el trabajo sobrevive a los reinicios. Lo que vuelve al chat
es el ARTEFACTO que el dominio imprimió en la última línea (verificado contra
`artefato_exts` y el disco). Si no hay una línea reconocible, vuelve el recibo con toda la salida:
un trabajo realizado no se convierte en una falla.

En el manifiesto, esto es una línea: `"sem_agente": true`, y la `invocacao` existente se convierte en el comando.


Conviene cuando «volver a empezar desde cero» es aceptable. No guarda el progreso ni tiene un `/status`
propio.

1. Escribe el prompt en `prompts/<nome>.md`. Usa `{{input}}` (lo que pidió la persona) y
   `{{saida}}` (dónde guardarlo). La última línea del agente debe ser `RESULT: <caminho>`.
2. Agrega la entrada a `config/skills.json`:

   ```jsonc
   { "command": "minhaskill", "fila": "texto", "kind": "agent",
     "prompt": "prompts/minhaskill.md", "artefato_exts": ["txt"],
     "max_tentativas": 2, "timeout_segundos": 3600,
     "aceita_destino": false,
     "campos": { "vertical": { "tipo": "bandeira", "padrao": "não" } },
     "descricao": "o que ela faz", "exemplo": "minhaskill: assunto" }
   ```

3. **Ayuda (opcional):** `prompts/minhaskill.help.md`. Sin ese archivo, el bot deriva la ayuda del
   registro. Ver «Regla de documentación» abajo.
4. `npm test`. El registro se valida al iniciar: una entrada inválida **detiene el servicio**,
   y así debe ser; es peor iniciar con un catálogo que no entendemos.

Todo campo declarado debe usarse en el prompt, y toda variable del prompt debe estar declarada:
hay pruebas para ambas condiciones.

### Un FLUJO (varias fases, con estado)

Conviene cuando hay trabajo parcial que sería absurdo descartar. Incluye `/status`, reanudación selectiva con
`/refazer`, continuación y definición congelada.

1. Crea el repo de dominio (`~/projetos/<nome>`) con `flow.json` (y `prompts/`, si alguna fase es de agente).
2. `flow.json`: `nome`, `prefixo` (la `P` de `P#16`, única por flujo), `versao_def`,
   `alvos` (cada uno con lo que necesite el dominio: `canal`, `gatilho`…) y `fases`.
   Cada fase: `id`, `escopo` (`fluxo` = un job para todos, `alvo` = uno por objetivo), `fila`,
   `kind`, `tarefa`, `max_tentativas` y, de forma opcional, `prompt`, `comando`, `espera`
   (poll: `{intervalo, timeout}`), `entrega`, `portao` y `pausa_apos` (puerta humana
   → `/aprovar`).
3. `tarefa` solo puede ser: `cli.rodar`, `fluxo-agente`, `fluxo-navegador`,
   `heygen.baixar`, `heygen.gerar`, `heygen.gerar-creditos`, `heygen.estudio`,
   `reel.montar`, o el `command` de una skill del catálogo. Los nombres fuera de esta lista se
   rechazan al cargar.

   **El criterio: agente donde PIENSA, función donde solo escribe comandos.** Una fase que existe
   para crear una línea de comandos es `cli.rodar` (`kind: function`), con el comando declarado en
   `comando`, y el conector verifica durante la instalación que el script exista. Una fase que escribe
   texto, toma decisiones o navega sigue siendo de agente. musicavideo nació con cuatro fases de agente
   para ejecutar su propia CLI, y las cuatro fallaron en la primera ejecución real: se inventó un
   binario en el prompt, se redefinió el contrato de salida y un render en segundo plano murió con el job.

   ```json
   { "id": "plano", "kind": "function", "tarefa": "cli.rodar",
     "comando": "bash {{repo}}/musicavideo.sh plano {{input}} --bruto",
     "pausa_apos": true, "portao": { "mostrar": ["{{artefato:plano}}"] } }
   ```

   Marcadores de `comando`: `{{repo}}` (obligatorio), `{{input}}`, `{{alvo}}`,
   `{{ref}}`, `{{saida}}` y `{{anterior:<campo>}}`. Este último lee `campo: valor`
   del recibo de la fase anterior; así viaja entre fases un dato que solo el dominio sabe crear
   (por ejemplo, un slug). Cualquier marcador fuera de esta lista se rechaza al cargar; el
   texto del usuario siempre se entrecomilla.

4. **La puerta pertenece al DOMINIO** (opcional). `portao: { mostrar: [...] }` en una fase con
   `pausa_apos` indica qué se envía al chat al terminar: el texto va en línea, el audio y las imágenes como
   archivo, y el video como enlace publicado (los mp4 de varios minutos superan los 50 MB que admite Telegram).
   Si no se declara, se aplica el comportamiento anterior: los guiones en `textos/<REF>/<alvo>.md`
   y el artefacto de la fase como enlace cuando no hay ningún guion.

   Los patrones que terminan en `?` son OPCIONALES: si no se resuelven, el proceso continúa en silencio.
   Sirve para material que a veces existe. Suno entrega DOS pistas, pero `--faixa-pronta` entrega
   una; la segunda no debe generar una advertencia de error en un flujo donde legítimamente no existe.

4b. **RESPONDER a la puerta** (opcional). `portao.respostas` declara qué se puede responder aparte de «sí»:
   palabra → comando del dominio.

   ```json
   "portao": {
     "mostrar": ["{{artefato:clipe}}"],
     "respostas": {
       "reprova": "bash {{repo}}/x.sh reprova {{anterior:slug}} clipe {{resposta}}",
       "ritmo": { "comando": "bash {{repo}}/x.sh recorta {{anterior:slug}} --ritmo {{resposta}}",
                  "reabre": false }
     }
   }
   ```

   `clipe: MVD#97 reprova 4,17,23` ejecuta el comando y REABRE la fase con material nuevo: «lo rehace y me lo presenta hasta que lo apruebe». `{{resposta}}` es el resto de la línea, en un solo argumento y ENTRE COMILLAS: el dominio lo interpreta, como en `--bruto`. El bot no sabe qué significa «reprobar un clip» y no debería saberlo.

   `reabre: false` se usa cuando NO se vuelve a generar nada: elegir entre dos pistas ya generadas es señalar otro archivo, y reabrir la fase volvería a generar material pagado. En ese caso, la puerta solo vuelve a entregar lo que cambió.

   Existe porque antes la puerta era de una sola vía: `/aprovar` liberaba el paso, pero no había forma de hacer lo contrario. Corregir una portada requería `/cancelar`, es decir, cancelar todo el flujo. Y `/refazer` no sirve porque solo toma fases en `falhou`.
5. Agrega a `config/fluxos.json`: `{ "command", "repo", "descricao", "exemplo" }`.
6. **Ayuda (opcional):** `HELP.md` en la raíz del repo de dominio.
7. Haz una prueba en SOMBRA antes de gastar nada:
   `/<fluxo> <assunto> | sombra` muestra fase × objetivo × cola × tarea y **no agrega nada a la cola**.

El dominio indica PARA QUIÉN (canal por nombre, `lives21`); el bot sabe DÓNDE (la ruta en disco).
Nunca pongas rutas en `flow.json`.

#### Las seis rutas de avatar → [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md)

Elegir quién genera el video del avatar y de qué bolsillo sale el costo depende del flujo: `| api`,
`| creditos`, `| estudio`, `| navega`, o ninguna; en ese caso, tú grabas en el estudio. **Solo una por flujo**; pedir dos se rechaza al crear el flujo.

La decisión no es trivial: el costo depende de la **autenticación**, no del parámetro:
la clave de API cobra de la billetera en dólares; OAuth descuenta créditos de la suscripción.
El documento detalla cada ruta, su costo medido y su estado real.

Resumen del estado (verificado en 2026-08-09): la ruta **normal** está en producción;
`| api`, `| creditos` y `| estudio` están implementadas, pero **nunca se ejecutaron dentro
de un flujo**; `| navega` solo existe en `promoavatar`, que está congelado.

### Regla de documentación (verificada por pruebas)

**Todos los dominios del catálogo responden a la ayuda.** No por disciplina, sino por diseño:

1. alguien que conoce el tema escribe la ayuda (`HELP.md` en el flujo, `<prompt>.help.md` en la skill);
2. si no la escribió, la ayuda se **deriva del registro**: fases, objetivos, campos, plazos,
   prefijo. El contenido derivado no puede diferir porque viene de la misma fuente que usa el bot para
   ejecutar;
3. `src/gateway/ajuda-dominio.test.ts` recorre ambos catálogos y **falla** si algún dominio
   no ofrece ayuda útil.

En el chat: `/ajuda <nome>` para cualquiera, o `/<fluxo> help`.

## Documentos

Este README responde una sola pregunta: **qué es el bot y cómo instalarlo, configurarlo y usarlo.**
Todo lo demás está en su propio documento, enlazado aquí. Si llegaste a un detalle extenso dentro de este archivo,
es un problema de organización: abre un issue o trasládalo.

**Los tres documentos que amplían el README:**

- [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md): las seis rutas, el costo medido y
  el estado real de cada una. Léelo antes de elegir `| api`, `| creditos` o `| estudio`.
- [`docs/pipeline-e-custo.md`](docs/pipeline-e-custo.md): por qué la fase de reel dejó
  de ser un agente, dónde está realmente el costo de un flujo y por qué los subtítulos se deciden
  en el estudio.
- [`docs/arquitetura.md`](docs/arquitetura.md): inicio, apagado, colas, tareas
  `function` y convenciones. Lectura para quien modifica el código.
- [`docs/instalar-analisevideo.md`](docs/instalar-analisevideo.md): conectar un repo
  externo (`analisevideo`) al bot manualmente por ambas rutas: skill del catálogo y repo de
  dominio. Es una plantilla para cualquier otra integración.
- [`docs/integrar-um-repo.md`](docs/integrar-um-repo.md): **por qué existen el manifiesto y la conexión**:
  el bot conoce la ficha del repo, no el código; la mitad costosa (modelo, una vez) y la barata
  (determinista, en cada máquina); entrada, contrato de salida,
  skill vs. flujo, puertas y modos de falla ya ocurridos.
- [`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md): la versión automática
  de lo anterior (ruta A): el par `gerar-manifesto` (una vez, con modelo) + `plugar-repo`
  (determinista, en cualquier máquina), el esquema del manifiesto y qué evita cada validación.
- [`docs/plugar-fluxo.md`](docs/plugar-fluxo.md): lo mismo para la ruta B (flujo): el par
  `gerar-manifesto-fluxo` + `plugar-fluxo`. Explica por qué el manifiesto de flujo INCLUYE la
  definición (un flujo no cabe junto al bot), la regla de conflicto que impide
  sobrescribir el repo de dominio y por qué no es negociable el orden materializar → registrar.
  También incluye **el guion de prueba en la VPS**, la tabla síntoma → solución, lo que ya se verificó,
  lo que no y los límites del diseño automático (el modelo elimina puertas; `alvos` siempre es una suposición).

**Cambiar el motor de agente** (`claude` es el predeterminado, no el único):

- [`docs/motor-codex.md`](docs/motor-codex.md): ejecutar los jobs con la CLI de OpenAI
  (`codex exec`). Activarlo no modifica lo que ya se ejecuta: `| motor=codex` en un job,
  después en la skill y, solo entonces, en `.env`. Explica qué funciona y qué **no**
  funciona (las skills que dicen «Usa la skill X» pertenecen a Claude Code y fallan
  en silencio con cualquier otro motor).
- [`docs/motor-opencode.md`](docs/motor-opencode.md): lo mismo con la CLI abierta
  `opencode`, que se comunica con Anthropic, OpenAI, Groq, DeepSeek o un modelo local.
  **El runner todavía no se ha verificado con la CLI real**: el documento incluye el guion
  de verificación y la tabla de síntoma → solución.

**Dominios** (público, activador, canal, prompt, plantilla: nada de esto pertenece al bot):

- [`promoavatar3`](https://github.com/inematds/promoavatar3): el dominio **activo**.
- [`promoavatar`](https://github.com/inematds/promoavatar): **congelado** desde
  2026-08-06; sigue disponible, sin cambios de comportamiento.
- [`musicavideo`](https://github.com/inematds/musicavideo) — `/musicavideo`: frase → música, portada y clip, con puerta de control en cada fase.
- [`r7ex`](https://github.com/inematds/r7ex) — `/r7ex` y `/rtex`: reel viral 9:16 de 7 etapas, sin puerta de control humana.
- [`explicavideos`](https://github.com/inematds/explicavideos) — `/explicavideo`: explicavideo con avatar en 16:9, 9:16 o ambos, publicado en el canal, sin puerta de control humana.
- Todos los flujos, con prefijo, fases y puerta de control: [`docs/fluxos.md`](docs/fluxos.md).

**Historial y análisis:**

- **Empieza aquí si retomas el proyecto:** `docs/HANDOFF.md`
- Avatar por API (`| api`) y puerta opcional (`| sem-portao`): `docs/fase-avatar-via-api.md`
- **Costo, tiempo y tokens por FASE (A#19–A#29):** [`docs/custo-por-fase-a19-a29.md`](docs/custo-por-fase-a19-a29.md): estas mediciones motivaron convertir la fase de reel en una función y crear la ruta `| estudio`.
- Ruta `| navega` (el agente en el estudio), que `| estudio` reemplaza sin eliminar: [`docs/rota-navega-avatar.md`](docs/rota-navega-avatar.md)
- **Conversaciones abiertas (retomar):** `docs/conversas-abertas.md`: diseño y plantillas del reel, imágenes y costo en tokens de la fase de navegación.
- Arquitectura: `docs/superpowers/specs/2026-07-30-inemaccbot-design.md`
- Perfil de ejecución (motor/modelo/esfuerzo): `docs/perfil-de-execucao.md`
- Planes: `docs/superpowers/plans/` (una etapa por archivo, de 0 a 5 + promoclub, retirado)
- Pruebas heredadas de la v1 y dónde quedó cada una: `docs/herdado-do-v1.md`
- Crítica externa al diseño (respondida en §13 de la spec): `docs/analise_critica_inemaccbot_design.md`

Análisis abiertos (lo que todavía no se ha decidido):

- **Salir de Telegram: WhatsApp, correo electrónico o chatbot:**
  [`docs/analise-canais-alem-do-telegram.md`](docs/analise-canais-alem-do-telegram.md).
  La integración con el gateway ya existe; el bloqueo es que `chat_id` sea `INTEGER`.
  Recomendación: no reemplazar, agregar.
- **Imágenes y enlaces como material de un flujo:**
  [`docs/analise-imagem-e-link-como-material.md`](docs/analise-imagem-e-link-como-material.md)

## Estructura del código

```
src/
  db/           abrir.ts (SQLite + WAL), migrations.ts, backup.ts
  fila/         types.ts (Job/Perfil/Fila/ContextoTarefa), store.ts (FilaSqlite),
                runner.ts (contrato Runner/Execucao), runner-claude.ts (motor claude),
                worker.ts (stepper: paso/golpear/drenar/abortar)
    tarefas/    catálogo CERRADO de tareas `function`: http.ts (http.get), ffmpeg.ts
                (ffmpeg.thumb), index.ts (crearTarefas)
  dominio/      perfil.ts (resolverPerfil — motor/modelo/esfuerzo; sin quien lo invoque en
                producción en esta etapa; se incorpora en la etapa 2 con kind=agent)
  gateway/      telegram.ts (adaptador grammy + lista de permitidos + límite de mensaje),
                comandos.ts (analiza/ejecuta comandos, puro, sin grammy),
                notificar.ts (job terminado -> mensaje en el chat)
  config.ts     cargarConfig — lee y valida el entorno
  integracao/   pruebas que legítimamente cruzan capas
  arquitetura.test.ts   verifica los límites entre capas (ahora con gateway/)
  index.ts      inicio, ciclo, programación y apagado: el núcleo del proceso
```

## Desarrollo

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/index.js (dist/ es el outDir de tsconfig, rootDir=src)
```

En producción: `node dist/index.js` con `.env` en `WorkingDirectory` (ver `deploy/inemaccbot.service`).

### `.env`

Variables que lee `carregarConfig` (`src/config.ts`): las primeras cuatro son **obligatorias**;
si falta alguna, el inicio falla pronto y con un error visible, antes de iniciar cualquier worker:

| variable | obligatoria | predeterminado | para qué |
|---|---|---|---|
| `BOT_TOKEN` | sí | — | token del bot en Telegram (nunca hagas commit del valor real) |
| `QUEUE_DB` | sí | — | ruta del archivo SQLite de la cola |
| `STATE_DIR` | sí | — | raíz del estado del proceso; `STATE_DIR/midia` pasa a ser la raíz de medios (ver `ffmpeg.thumb` abajo) |
| `LOG_FILE` | sí | — | archivo donde `main()` también escribe cada línea del registro (además de stderr) |
| `ALLOWED_CHAT_IDS` | sí | — | lista de chat ids separados por comas; la lista de permitidos del gateway |
| `MOTOR_PADRAO` | no | `claude` | motor de respaldo para el perfil de ejecución (etapa 2) |
| `MODELO_PADRAO` | no | `sonnet` | lo mismo, para el modelo |
| `ESFORCO_PADRAO` | no | `low` | lo mismo, para el esfuerzo |
| `HEYGEN_PERFIL_CHROME` | no | `~/.cache/inemaccbot/perfil-heygen` | perfil de Chromium **con sesión iniciada en HeyGen**, usado por la ruta `\| estudio`. Es una ruta, no un secreto: las cookies están allí, fuera del repo |

`.env` está fuera de git, con permisos 600. El parser (`lerEnv` en `src/index.ts`) es minimalista a propósito
(`CLAVE=valor`, `#` para comentarios, comillas opcionales): no es `dotenv`, es suficiente para iniciar.
El entorno real del proceso (systemd `EnvironmentFile` o una modificación manual) siempre prevalece sobre lo escrito
en el archivo cuando ambos definen la misma clave.

**El `.env` también se publica en el entorno del proceso** (`exportarParaAmbiente`, llamado
por `main()`), no solo se lee para `Config`. Esto es necesario porque los scripts de las fases
heredan el entorno del bot (el `spawn` de `reel.ts` no pasa `env:`), y sin esa publicación
el bot era asimétrico: bajo systemd, `EnvironmentFile` ya lo resolvía, pero con `./start.sh`
los procesos secundarios no veían nada. Estas variables **no** las lee `carregarConfig`; solo se retransmiten:

| variable | predeterminado | quién la usa |
|---|---|---|
| `INEMAIMG_HOST` | `http://localhost:8000` | `gen-imagem.py` (imágenes del reel). En una VPS, túnel a la GPU de casa: `ssh -R 8000:localhost:8000 <vps>` |
| `INEMAIMG_MODEL` | `flux2-klein` | lo mismo |
| `IMG_PROVEDOR` | `inemaimg` | quién genera la imagen: `inemaimg` (GPU local, **se respeta la seed**) o `agnes` (API, US$ 0, **sin seed**; disminuye el determinismo del reel). `kie`/`fal` se rechazan: no están implementados |
| `IMG_ENV_PATH` | — | archivo con la clave del proveedor (p. ej., `AGNES_API_KEY=`). Alternativa: poner la variable directamente en el entorno |
| `GROQ_ENV_PATH` | `~/projetos/wifi/.env` | `transcribe-groq.sh`. Alternativa: `GROQ_API_KEY` directamente en el entorno, que tiene prioridad |
| `HEYGEN_API_KEY` | — | solo si `HEYGEN_ENV_PATH` apunta al propio `.env` (ver `.env.example`) |

## Arquitectura en operación → [`docs/arquitetura.md`](docs/arquitetura.md)

Inicio (el orden importa y no es arbitrario), qué garantiza `drenar()` durante el apagado
y qué no, colas y concurrencia, tareas `function`, convenciones del
código y por qué `Worker` es un stepper y no un servicio.

Es una lectura para quien vaya a modificar el código. Para instalar, configurar y usar el bot, lo anterior es suficiente.
