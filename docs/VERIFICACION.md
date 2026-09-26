# Registro de verificación — 26/09/2026

| Comprobación | Resultado | Alcance |
| --- | --- | --- |
| `npm test` | 45 casos aprobados | HTTP simulado + PostgreSQL embebido PGlite, no proveedor de pagos real |
| `npm run check` y sintaxis de scripts | Aprobado | JavaScript |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilidades reportadas | Dependencias de ejecución instaladas, a esta fecha |
| `npm run firmware:check` | Compilación aprobada del template nuevo | core 3.1.2, ArduinoJson 7.4.3, NodeMCU v2, 4 MB / FS 1 MB; identidad ficticia, no instalado en placa |
| Inicio real de `server.js` | Aprobado en puerto local temporal | Sin credenciales: admin 401, consumo antiguo 426, health 503; proceso cerrado al terminar |
| Build del backend | No existe script `build` | Se comprobó sintaxis e inicio |
| Portal local | Inspección visual aprobada | HTML extraído del firmware, datos ficticios, escritorio y 390 px; no simula radio, TLS ni hardware |
| `/health` publicado | HTTP 200 | Versión anterior, después de restaurar Supabase |
| `/debug/supabase` publicado | HTTP 200, `supabase_connected`, 13 equipos | Consulta de lectura, versión anterior; la rama nueva protege esta ruta |
| Esquema real Supabase | 13 tablas/vistas; 18 funciones públicas | Solo lectura; no migración ni cambios en registros de clientes |
| Vercel | 4 variables antiguas presentes | No se comprobaron los valores del token MP ni su vigencia |
| Lovable | Preparación iniciada; pausa por falta de créditos | Integración incompleta; sin publicación |

Las pruebas cubren firma y datos autorizados de webhook, importes, cuenta receptora, duplicados, transacciones y rollback, pago desconectado, comandos pendientes, ACK repetido, reinicio y entrega incierta, cambio de dueño, renovación de abonos, autorización de clientes, permisos SQL, CORS, simuladores bloqueados en producción, estado administrativo, firmware y QR.

No se ejecutaron compras/cargos/devoluciones reales ni se activaron relés. La migración se ensayó con un esquema histórico, no con una copia completa y restaurada de la base real. La concurrencia lógica se verifica con transacciones en PGlite; falta prueba de carga con varias conexiones en PostgreSQL/Supabase. No se instaló monitoreo ni se contrataron planes.

## Continuación: dispositivo ESP8266

Las 11 pruebas agregadas verifican telemetría y mantenimiento, renovación de señal de vida, bloqueo por reinicio, reintentos de efectivo y recaudación, conflictos de identidad, cambio de empresa, aislamiento de ingresos del propietario anterior, permisos SQL, contrato HTTP, estado y generación segura del archivo. Se ejecutaron ambas migraciones locales en orden. No se aplicaron al proyecto real.

Compilación de `paysync-esp8266-v1.0.0`: RAM estática 34.100 / 80.192 bytes (42%); IRAM 61.479 / 65.536 (93%, incluye caché); flash de código 460.996 / 1.048.576 (43%). El uso de RAM al compilar no mide el heap libre durante TLS. Hay que ensayar consumo de memoria, captura de pulsos, temporización, flash y cortes de energía en NodeMCU real. El binario de la comprobación usa `example.invalid` y no sirve para instalar.

Esta continuación no cambió credenciales reales ni publicó en `main`. El registro de `/health` público de arriba pertenece a la revisión anterior; no certifica despliegue del firmware/backend nuevos.
