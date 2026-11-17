# Guía de instalación · Escola Europea Expense Claims

Dos fases. La **fase 1** (10 minutos) publica la app en modo demo para que la gente la pruebe. La **fase 2** (unos 30 minutos) la conecta a Google para que guarde de verdad, envíe correos y archive los recibos.

---

## Fase 1 · Publicar en GitHub Pages (modo demo)

1. En github.com: **+ → New repository** · nombre `escola-expenses` · **Public** · **Create repository**.
2. En el repositorio vacío, pulsa **uploading an existing file**.
3. Descomprime el ZIP en tu ordenador. Abre la carpeta `escola-expenses` y **arrastra todo su contenido** (las carpetas `css`, `js`, `icons`, `vendor`, `apps-script`, `tests`, `tools` y los archivos sueltos) a la página de GitHub. No subas el ZIP ni la carpeta exterior: `index.html` tiene que quedar en la raíz del repositorio.
4. Pulsa **Commit changes** (la subida tarda un poco: `vendor` pesa unos 12 MB).
5. **Settings → Pages → Source: Deploy from a branch → Branch: `main` · `/ (root)` → Save**.
6. En 1–2 minutos tendrás la dirección: `https://TUUSUARIO.github.io/escola-expenses/`.

Ya funciona en **modo demo**: barra amarilla arriba, selector “View as” para cambiar de rol y un **buzón de demo** donde aparecen los correos que se enviarían. Se puede instalar como app (Chrome: icono de instalar en la barra de direcciones; móvil: “Añadir a pantalla de inicio”).

> En modo demo cada persona solo ve sus propios datos de prueba, guardados en su navegador.

---

## Fase 2 · Conectar con Google (datos reales)

Hazlo con la cuenta de Google que **enviará los correos y será propietaria** de la hoja y la carpeta de recibos. Lo ideal es una cuenta de la Escola tipo `administracion@escolaeuropea.eu`, no una personal.

### Paso 1 · Crear el proyecto de Apps Script

1. Abre **https://script.new** (con esa cuenta). Ponle de nombre `Escola Expense Claims API`.
2. Sustituye el contenido de `Code.gs` por el de **`apps-script/Code.gs`**.
3. Pulsa **+ → Script**, nómbralo `Rules` y pega **`apps-script/Rules.gs`**.
4. **⚙ Configuración del proyecto** → marca **“Mostrar el archivo de manifiesto appsscript.json en el editor”**. Vuelve al editor, abre `appsscript.json` y sustitúyelo por **`apps-script/appsscript.json`**.
5. Guarda (💾).

### Paso 2 · Crear el acceso con Google (Client ID)

1. Abre **https://console.cloud.google.com**, crea un proyecto nuevo (`Escola Expenses`).
2. Menú → **Google Auth Platform**. Si te lo pide, pulsa **Get started**: nombre de la app `Escola Expense Claims`, tu email de soporte y en **Audience** elige **Internal** (solo cuentas de escolaeuropea.eu).
3. **Clients → Create client** → tipo **Web application** → nombre `Expense Claims web`.
4. En **Authorized JavaScript origins** añade **`https://TUUSUARIO.github.io`**: solo el dominio, sin `/escola-expenses` ni barra final.
5. **Create** y copia el **Client ID** (termina en `.apps.googleusercontent.com`). No necesitas el “client secret”.

Los cambios en esta pantalla pueden tardar desde unos minutos hasta unas horas en aplicarse.

### Paso 3 · Configurar el script

En Apps Script → **⚙ Configuración del proyecto → Propiedades del script → Añadir propiedad**:

| Propiedad | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | el Client ID del paso 2 |
| `ALLOWED_DOMAINS` | `escolaeuropea.eu` |
| `APP_URL` | `https://TUUSUARIO.github.io/escola-expenses/` |
| `MAIL_SENDER_NAME` *(opcional)* | `Escola Europea · Expense Claims` |

### Paso 4 · Preparar la hoja y la carpeta

1. En el editor, elige la función **`setup`** en el desplegable y pulsa **▶ Ejecutar**.
2. Acepta los permisos (Hojas de cálculo, Drive, enviar correo, conectar con servicios externos). Si sale “Google no ha verificado esta aplicación”: **Configuración avanzada → Ir a…** (es tu propio script).
3. En el **registro de ejecución** verás dos enlaces: la hoja **“Escola Europea · Expense Claims (data)”** y la carpeta **“… (receipts)”**.
4. Opcional: ejecuta **`sendTestEmail`** para recibir un correo de ejemplo y ver cómo queda.

### Paso 5 · Publicar el servicio

1. **Implementar → Nueva implementación** → tipo **Aplicación web**.
2. **Ejecutar como:** *Yo*. **Quién tiene acceso:** *Cualquier usuario*.
3. **Implementar** y copia la **URL de la aplicación web** (termina en `/exec`).

> **¿Por qué “Cualquier usuario”?** La app de GitHub tiene que poder llamar al servicio. Eso no expone datos: cada petición lleva el inicio de sesión de Google de la persona, y el script lo verifica (que sea de esta app y de @escolaeuropea.eu). Cada nota solo la ven quien la crea, su responsable y su administradora.
> Si esa opción no aparece, el administrador de Google Workspace de la Escola la tiene bloqueada: pídele que permita compartir aplicaciones web de Apps Script fuera del dominio.

### Paso 6 · Conectar la app

En GitHub, abre **`js/config.js` → ✏️ (Edit)** y rellena:

```js
apiUrl: 'https://script.google.com/macros/s/XXXXXXXX/exec',
googleClientId: 'XXXXXXXX.apps.googleusercontent.com',
administrators: [
  { name: 'Carola', email: 'carola@escolaeuropea.eu' },
  { name: 'Tereza', email: 'tereza@escolaeuropea.eu' }
]
```

**Commit changes**. En un minuto la app pedirá iniciar sesión con Google y ya trabaja con datos reales. La barra de demo desaparece sola. Para seguir viendo la demo, añade `?demo` a la dirección.

### Paso 7 · Compartir

- Comparte el enlace de la app con el equipo.
- Comparte la **hoja de datos** con Tereza y Carola (lector o comentarista): ahí ven todas las notas, cada línea de gasto con enlace a su recibo y el historial. **No editéis la columna oculta “Data (JSON)”.**
- La carpeta de recibos tiene una subcarpeta por nota.

---

## Mantenimiento

| Quiero… | Cómo |
|---|---|
| Actualizar el código del servidor | Pega el nuevo `Code.gs`/`Rules.gs` → **Implementar → Gestionar implementaciones → ✏️ → Versión: Nueva versión → Implementar**. La URL `/exec` no cambia. |
| Actualizar la app | Sube los archivos nuevos a GitHub. Las apps instaladas se actualizan al abrirlas (puede hacer falta abrirla dos veces). |
| Desactivar los correos un tiempo | Propiedad `MAIL_ENABLED` = `false` (la app ofrece un borrador de email en su lugar). |
| Ver errores del servidor | Apps Script → **Ejecuciones**. |

**Límites a tener en cuenta:** recibos de hasta 10 MB; el envío de correos está sujeto a la cuota diaria de Gmail de la cuenta; el tipo de cambio automático viene del BCE (no publica todas las divisas, por ejemplo el dírham marroquí: en ese caso se introduce a mano).

## Problemas frecuentes

| Síntoma | Solución |
|---|---|
| El botón de Google dice *origin not allowed* | En el Client ID, el origen debe ser exactamente `https://TUUSUARIO.github.io` (sin ruta). Espera unos minutos tras cambiarlo. |
| “Use your escolaeuropea.eu account” | Se ha entrado con una cuenta personal. Cierra sesión y usa la de la Escola. |
| “The service is not configured yet” | Falta `GOOGLE_CLIENT_ID` en las propiedades o no se ha ejecutado `setup`. |
| La app sigue en modo demo | `apiUrl` o `googleClientId` vacíos en `js/config.js`, o la caché: recarga dos veces. |
| No llegan correos | Ejecuta `sendTestEmail`; revisa spam y la cuota en **Ejecuciones**. |
