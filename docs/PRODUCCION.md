# Puesta en marcha y pruebas pendientes

Estado del trabajo: 26/09/2026. No hay una promesa técnica de cero fallas. La meta es detectar fallos, detener ventas nuevas y conservar pagos y evidencias para resolver cada caso.

## Comprobado

- Repositorio real revisado desde `7b98996b6a3bad951975977bc6eceb57e17dc845`.
- Supabase PaySync-2 estaba pausado; se solicitó y confirmó restauración. `/health` y `/debug/supabase` del backend publicado volvieron a HTTP 200. Su esquema público contiene las 13 tablas/vistas esperadas.
- Vercel tiene `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MP_ACCESS_TOKEN` y `API_KEY`, en Production y Preview. No se mostraron sus valores. Compartir proyecto/base entre esos entornos debe corregirse antes de probar cambios que escriban.
- Pruebas automáticas del backend y migración en PostgreSQL embebido: ver `npm test` y registro de verificación. Incluyen duplicados, aislamiento de clientes, pagos durante desconexión, reinicio, entrega incierta, rollback y abonos.
- Firmware generado compiló para NodeMCU ESP8266 con core 3.1.2 y ArduinoJson 7.4.3. La compilación usó credenciales ficticias y un certificado de prueba; no es un firmware para flashear. RAM estática aproximada 42%, IRAM 93%, flash 43% para la versión nueva; falta medir heap y estabilidad en placa.
- Lovable recibió la preparación de login real e integración; quedó pausado por falta de créditos. No se verificó una versión terminada ni se publicó el panel.

## Orden obligatorio antes de vender

1. **Rotar secretos expuestos.** El repositorio público incluía `.env` con credenciales. Se quitó del árbol nuevo, pero sigue en commits anteriores. Reemplazar API_KEY y revisar/revocar el token de Mercado Pago publicado; comprobar cualquier otra clave que se haya compartido en código o conversaciones. La API_KEY nueva debe tener al menos 32 caracteres aleatorios. No reutilizar la clave anterior. Mantener secretos solo en Vercel o un almacén privado. No reescribir historia como sustituto de revocación.
2. **Base paga y backup restaurable.** Supabase continúa en Free; no se contrató un plan pago. Activar el plan apropiado, comprobar facturación, backups y retención. Guardar una copia completa de esquema y datos cifrada antes de migrar y probar su restauración en otro proyecto. SQL guardado en el editor no es backup. No se hizo aún un backup del proyecto real.
3. **Entorno de prueba separado.** Usar otra base y credenciales de prueba de Mercado Pago. Nunca activar simuladores apuntando a la base real. Evitar que Preview herede secretos de producción. No probar endpoints de escritura sobre equipos de clientes.
4. **Auditar y aplicar migración.** Comparar tablas, tipos, índices, triggers, RPC y permisos actuales. Las migraciones `db/20260926_production_foundation.sql` y luego `db/20260926_esp8266_device.sql` son aditivas y transaccionales, pero cambian permisos y retiran el acceso directo desde navegador. Aplicarlas una vez, primero en prueba y después de backup. No se aplicaron a producción. Todas las placas empiezan sin habilitación para cobrar (`commissioned=false`). No borrar la cola vieja: conciliar `device_pending_pulses` antes de migrar cada equipo.
5. **Configurar Vercel y Mercado Pago.** Completar la tabla de variables, validar con `npm run preflight`, registrar webhook de pagos `https://qr-arcade-backend.vercel.app/mp/webhook` y copiar su secreto de firma al servidor. No aceptar retornos del navegador como prueba de pago. El token/collector deben pertenecer a la cuenta que cobra. El sistema actual usa **una cuenta MP global**, no distribuye fondos a cada empresa: decidir y desarrollar OAuth/liquidación por comercio si ese es el modelo comercial.
6. **Cuentas reales.** Completar Lovable, configurar solo URL y clave pública Supabase, crear cuentas mediante el administrador y establecer `app_metadata.paysync_role` (`admin` o `client`); para cliente agregar el UUID `company_id`. El usuario no debe editar esos metadatos. Probar acceso cruzado con dos empresas. No habilitar registro público con privilegios automáticos. Revisar correo de recuperación, MFA de administradores y vencimiento de sesiones.
7. **Ensayo físico y firmware.** Ver siguiente sección. Generar con CA real del dominio y token único. Hasta confirmar la interfaz eléctrica y la entrega no habilitar `commissioned` ni `PAYMENTS_ENABLED`.
8. **Publicación coordinada.** Mantener `PAYMENTS_ENABLED=false`; publicar backend, migración y panel compatibles en una ventana controlada, instalar firmware y reconciliar créditos antiguos. Ejecutar smoke y una compra sandbox completa. Luego habilitar una sola máquina verificada y probar presencialmente antes de escalar. El backend nuevo rechaza firmware antiguo con HTTP 426.
9. **Monitoreo y operación.** Configurar y probar alertas externas (ver abajo). No se dejó un monitor contratado/activo ni se enviaron mensajes a terceros. Definir responsable y tiempos de atención de pagos sin entrega.

## Variables

| Variable | Dónde / condición |
| --- | --- |
| `SUPABASE_URL` | URL raíz del proyecto, sin `/rest/v1`; real: `https://lrsladmyfriundetnnjw.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secreto exclusivo del servidor; nunca `VITE_` |
| `API_KEY` | Nueva clave aleatoria de administrador, mínimo 32 caracteres |
| `MP_ACCESS_TOKEN` | Token nuevo de la cuenta correcta para cada ambiente |
| `MP_WEBHOOK_SECRET` | Secreto de firma de la aplicación MP, no el access token |
| `MP_COLLECTOR_ID` | ID exacto del receptor; preflight compara `/users/me` |
| `MP_ENVIRONMENT` | `sandbox` o `production`; valida `live_mode` del pago |
| `PUBLIC_BASE_URL` | Origen HTTPS del despliegue; producción `https://qr-arcade-backend.vercel.app` |
| `ALLOWED_ORIGINS` | Orígenes exactos del panel, separados por coma, sin wildcard |
| `PAYMENTS_ENABLED` | `false` hasta completar todas las pruebas |
| `ENABLE_SIMULATORS` | `false` en producción; nunca se habilitan con NODE_ENV/VERCEL_ENV production |
| `FIRMWARE_CA_PEM` | CA real que valida el certificado del dominio del backend; probar renovación TLS |
| `PLAN_MONTHLY_ARS`, `PLAN_SIX_MONTHS_ARS` | Enteros positivos, predeterminados 5000 y 25000 por dispositivo |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_PAYSYNC_API_URL` | Solo en el frontend, datos públicos; no contienen claves administrativas |

## Pruebas físicas pendientes

- Identificar placa, tensión, optoaislación, polaridad del relé, entrada de coin y existencia de sensor/confirmación de crédito. El usuario aún no conoce ese hardware.
- Comprobar un pulso y varios pulsos con la máquina real. Que el relé actúe no prueba que el juego sumó créditos. Para ofrecer confirmación física hace falta un sensor o protocolo de respuesta y extender `ack-v1` para registrar esa evidencia.
- Cortar energía antes, durante y después del pulso y durante cada escritura EEPROM; cortar Internet antes y después del pago y durante el ACK. Ningún estado ambiguo debe provocar reenvío automático.
- Probar WiFi débil, DNS/NTP/TLS caídos, reencendido, desgaste/corrupción de EEPROM y reconexión. La persistencia actual escribe flash por comando; evaluar FRAM u otro almacenamiento para alto volumen.
- Probar señales simultáneas del billetero y botón de recaudación. El firmware nuevo usa interrupciones y cola persistente con reintentos idempotentes. Falta medir trenes reales, cortes antes de persistir en flash, saturación y desgaste. Sin entrada de inhibición del aceptador no se puede impedir el ingreso de efectivo durante una falla.
- Provisionar el certificado real (el usado para compilar no sirve), proteger token por equipo y ensayar actualización de CA/firmware. El endpoint genera `.ino`; no es OTA ni flashea automáticamente.
- Tras aprobar cada equipo, un operador habilita su registro `paysync_runtime.commissioned`. No se añadió un botón público para saltarse la prueba.

## Qué ocurre si algo falla

Heartbeat de 30 segundos y sondeo `ack-v1` cada 2.5 segundos más latencia, que renueva la señal de vida; se bloquea checkout tras 30 segundos sin señal. Una página de Mercado Pago abierta antes del corte todavía puede aceptar un pago. Ningún heartbeat puede eliminar esa carrera. En ese caso el pago aprobado permanece en la base, detiene nuevas ventas y se entrega al reconectar si existe certeza suficiente; si hay ambigüedad requiere revisión o devolución.

`/admin/delivery-incidents` y `/admin/payment-anomalies` muestran incidencias. `POST /admin/reconcile-payment` con `{ "payment_id": "ID_NUMERICO" }` consulta de nuevo a MP y reaplica la transacción idempotente. No acepta un estado aprobado proporcionado por el operador. No hay conciliador periódico ni devolución automática instalados. Una devolución es una acción financiera: verificar la evidencia y ejecutarla en la cuenta MP correspondiente. Registrar resolución auditada antes de liberar una máquina; no borrar comandos o recibos para forzar otro coin.

Las devoluciones parciales, contracargos y cancelaciones pasan a revisión; no se repiten créditos. Para reabrir órdenes en revisión falta una herramienta de resolución con auditoría y permisos. Las suscripciones ya activadas no se revocan automáticamente por contracargo: requieren operación revisada.

## Monitoreo 24/7 y recuperación

- Monitor externo cada minuto sobre `/health`, con alerta tras fallos consecutivos, y segundo monitor autenticado sobre estado/incidencias. Comprobar entrega real de alertas. Los monitores deben detectar también placa offline, orden pagada sin ACK, colas antiguas, errores de webhook, saldo/estado del plan de infraestructura y fallos de backup.
- Proteger checkout de abuso con límites persistentes/WAF. Un proceso serverless no puede usar memoria local como limitador global. Un checkout abandonado puede bloquear ese equipo hasta vencer (10 minutos).
- Programar conciliación con MP y control de pagos pendientes; definir tiempos de devolución/soporte. Actualmente la reconciliación disponible es manual autenticada.
- Revisar costos y límites de Vercel para uso comercial: se observó plan Hobby. Asegurar un plan que permita el uso comercial previsto; no asumir que Free/Hobby cubre un SaaS vendido.
- Definir RPO/RTO, copias independientes y simulacro de recuperación. Durante una caída prolongada suspender nuevas ventas, conservar evidencia de MP y conciliar antes de reabrir.
- Rollback: mantener cobros pausados y las tablas nuevas/recibos. No volver al consumo antiguo con pagos nuevos pendientes ni borrar la migración. Preferir corrección hacia adelante y restauración ensayada.

Referencias oficiales: [Supabase producción](https://supabase.com/docs/guides/deployment/going-into-prod), [backups](https://supabase.com/docs/guides/platform/backups), [Webhooks Mercado Pago](https://www.mercadopago.com.ar/developers/en/docs/checkout-pro-orders/resources/notifications/webhooks?scope=prod), [Node en Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

## Entrega ESP8266 v1.0.0

La plantilla está en `firmware/paysync-esp8266/PaySyncESP8266.ino`; `/admin/firmware` la utiliza. Ver [hardware](HARDWARE-ESP8266.md) e [instalación](INSTALACION-DISPOSITIVO.md). La versión de esquema requerida ahora es `20260926-device-v1`. Esta continuación no cambió claves reales, no aplicó migraciones a producción y no hizo cargos ni pruebas físicas.
