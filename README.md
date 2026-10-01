# Grand Prix — Software Speedway

Juego de carreras multijugador en tiempo real para navegador. No hay cuentas ni instalación del lado del jugador: cada persona abre el link, escribe su nombre, elige un color y entra a una sala.

## Qué incluye

- Salas privadas por código y links compartibles, sin autenticación.
- Garage con ocho autos de personalidad propia y exactamente la misma performance.
- Una mini animación muestra a la directora entregando la Copa y 1.000 requerimientos extra; después entra un señor del cliente con otros 10.000, una mujer de Riesgos declara que todo es muy riesgoso y pide borrar la mitad de lo hecho, un hombre de Integraciones trae 10 APIs nuevas y una mujer de Producto pide 20 pasos más de onboarding (el final queda fijo para que lo vean todos).
- Hasta 8 pilotos; una persona actúa como anfitrión.
- Física resuelta por el servidor, choques entre autos y contra el circuito.
- Estrellas sincronizadas: TURBO aumenta la velocidad 8 segundos y RAYO ralentiza a los rivales durante 10.
- Carrera completa de 3 vueltas, checkpoints, posiciones en vivo, cronómetro, velocidad, vuelta y aviso de sentido contrario.
- Cuenta regresiva sincronizada, clasificación final, podio y revancha.
- Teclado y controles táctiles para celular.
- Música, motor y efectos generados con Web Audio: no hacen falta archivos multimedia.
- Health check para hosting.

## Correrlo localmente

Requiere Node.js 20 o más nuevo.

```bash
npm install
npm start
```

Abrí <http://localhost:3000>. Para probar el multijugador podés abrir dos ventanas (o una ventana normal y otra privada), usar el mismo código de sala y nombres distintos.

Durante el desarrollo:

```bash
npm run dev
npm test
```

## Controles

| Acción | Teclado | Celular/tablet |
|---|---|---|
| Acelerar/frenar | `W` / `S` o `↑` / `↓` | Pedales derechos |
| Doblar | `A` / `D` o `←` / `→` | Botones izquierdos |
| Derrapar | `Espacio` | Botón `DRIFT` |

El audio comienza después del primer click por una restricción normal de los navegadores. Se puede silenciar desde `♫`.

## Power-ups

- **⭐ TURBO:** aumenta un 25% la aceleración y la velocidad máxima durante 8 segundos.
- **⚡ RAYO:** reduce un 30% la aceleración y la velocidad máxima de todos los rivales durante 10 segundos.

Las estrellas se activan al tocarlas, reaparecen a los 9 segundos y anuncian en pantalla quién las recogió.

## Publicarlo para el equipo

### Opción simple: Render

1. Subí esta carpeta a un repositorio de GitHub o GitLab.
2. En Render elegí **New → Blueprint** y conectá el repositorio. El archivo `render.yaml` ya define el servicio Docker y el health check.
3. Confirmá el deploy. Cuando termine, Render entrega una URL HTTPS pública.
4. Abrí esa URL, elegí un código de sala y usá **Copiar invitación**.

No hace falta configurar `PORT`: el servidor usa automáticamente la variable que provee la plataforma.

### Cualquier host que acepte Docker

```bash
docker build -t grand-prix .
docker run --name grand-prix -p 3000:3000 grand-prix
```

Después publicá el puerto 3000 detrás de un dominio HTTPS. Railway, Fly.io, Northflank y un VPS con Caddy/Nginx pueden ejecutar este mismo contenedor. El proxy debe permitir WebSockets; la mayoría de esas plataformas lo hace por defecto.

### VPS con Node.js

```bash
npm ci --omit=dev
NODE_ENV=production PORT=3000 npm start
```

Conviene mantener el proceso con systemd o un process manager y poner Caddy/Nginx delante para HTTPS.

## Nota de arquitectura

Las salas viven en memoria y el juego está pensado para una única instancia, ideal para un grupo de trabajo. No actives escalado horizontal: dos personas enviadas a instancias distintas no compartirían partida. Para escalarlo a muchas instancias habría que sumar un adaptador compartido (por ejemplo Redis) y persistencia de sala.

Los códigos de sala separan partidas pero no son una medida de seguridad. Como no hay autenticación —por diseño— cualquiera que conozca el link puede entrar.
