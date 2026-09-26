# Registro de verificación — 26/09/2026

| Comprobación | Resultado | Alcance |
| --- | --- | --- |
| `npm test` | 34 casos aprobados | HTTP simulado + PostgreSQL embebido PGlite, no proveedor de pagos real |
| `npm run check` y sintaxis de scripts | Aprobado | JavaScript |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilidades reportadas | Dependencias de ejecución instaladas, a esta fecha |
| Firmware ESP8266 | Compilación aprobada | core 3.1.2, ArduinoJson 7.4.3, NodeMCU v2; no instalado en placa |
| `/health` publicado | HTTP 200 | Versión anterior, después de restaurar Supabase |
| `/debug/supabase` publicado | HTTP 200, `supabase_connected`, 13 equipos | Consulta de lectura, versión anterior; la rama nueva protege esta ruta |
| Esquema real Supabase | 13 tablas/vistas; 18 funciones públicas | Solo lectura; no migración ni cambios en registros de clientes |
| Vercel | 4 variables antiguas presentes | No se comprobaron los valores del token MP ni su vigencia |
| Lovable | Preparación iniciada; pausa por falta de créditos | Integración incompleta; sin publicación |

Las pruebas cubren firma y datos autorizados de webhook, importes, cuenta receptora, duplicados, transacciones y rollback, pago desconectado, comandos pendientes, ACK repetido, reinicio y entrega incierta, cambio de dueño, renovación de abonos, autorización de clientes, permisos SQL, CORS, simuladores bloqueados en producción, estado administrativo, firmware y QR.

No se ejecutaron compras/cargos/devoluciones reales ni se activaron relés. La migración se ensayó con un esquema histórico, no con una copia completa y restaurada de la base real. La concurrencia lógica se verifica con transacciones en PGlite; falta prueba de carga con varias conexiones en PostgreSQL/Supabase. No se instaló monitoreo ni se contrataron planes.
