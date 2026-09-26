# PaySync — base para puesta en producción

Esta rama prepara el backend, la migración y el firmware. **No habilitar ventas todavía.** La migración no se aplicó al proyecto real y el firmware no se probó en una máquina. Los cobros nuevos quedan desactivados por defecto.

## Qué cambia

- `/health` comprueba conexión y versión de la base. `/admin/status` muestra configuración, equipos, último heartbeat e incidencias; requiere administrador.
- Checkout QR solo cuando el dispositivo tiene abono activo, está asignado, fue habilitado tras pruebas y recibió heartbeat `ack-v1` en los últimos 30 segundos. Bloquea mientras haya un pago anterior sin resolver.
- Cada orden congela precio, cantidad de pulsos y cliente. Webhooks firmados consultan el pago real en Mercado Pago y validan cuenta receptora, ambiente, moneda y referencia.
- Registro de pago y creación de comandos son una transacción de PostgreSQL. Repetir un aviso no suma créditos ni renueva dos veces un abono.
- La placa conserva un recibo en EEPROM y confirma cada comando. Ante un corte ambiguo se bloquea para revisión. `relay_confirmed` significa que el firmware informó el pulso; **no demuestra que la máquina otorgó crédito**.
- Sesiones de Supabase verificadas en el backend; empresa y rol salen de `app_metadata` administrado por el servidor. No hay clave compartida dentro del frontend.
- Simuladores solo en entorno no productivo, con autenticación y habilitación explícita. Usan la misma transacción que pagos; no llaman a Mercado Pago.
- Firmware NodeMCU completo con TLS, portal local PaySync, contraseña técnica individual, captura de efectivo por interrupción y cola persistente. `/device/consume-pulse` admite POST `ack-v1` con confirmación; el consumo antiguo sin ese protocolo devuelve HTTP 426.
- `.env` y `node_modules` dejan de versionarse. **La eliminación no revoca claves del historial anterior.**

## Ejecutar y verificar

Node.js 24. Copiar `.env.example` a `.env` y completar en privado con un proyecto de pruebas separado.

```sh
npm ci
npm run check
npm test
npm start
```

`npm run preflight` comprueba configuración, esquema y cuenta de Mercado Pago sin crear pagos. `SMOKE_BASE_URL` permite probar un despliegue con `npm run smoke`; este comando solo consulta y verifica denegaciones, nunca entrega coins.

La suite usa HTTP simulado y PostgreSQL embebido PGlite con el esquema histórico. No reemplaza pruebas en Supabase/PostgreSQL con conexiones concurrentes, pagos de prueba del proveedor ni ensayos eléctricos. `test/fixtures/legacy-schema.sql` es exclusivamente para pruebas: **no ejecutarlo en producción**.

## Documentación

- [Plan de puesta en marcha y pendientes](docs/PRODUCCION.md)
- [Contrato para el panel Lovable](docs/API-PANEL.md)
- [Montaje en placa perforada](docs/HARDWARE-ESP8266.md)
- [Generación, instalación y prueba del dispositivo](docs/INSTALACION-DISPOSITIVO.md)
- [Firmware fuente](firmware/paysync-esp8266/PaySyncESP8266.ino)
- [Primera migración](db/20260926_production_foundation.sql) y [segunda migración: dispositivo](db/20260926_esp8266_device.sql), en ese orden
- [Resultados de pruebas](docs/VERIFICACION.md)

El backend publicado seguía en la versión anterior al revisar este trabajo. Restaurar Supabase recuperó `/health` y `/debug/supabase` (HTTP 200, 13 dispositivos en el diagnóstico). Esto confirma recuperación del servicio antiguo, no la publicación ni certificación de esta rama.
