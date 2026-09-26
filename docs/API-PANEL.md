# Contrato para Lovable

Todas las respuestas de negocio usan `{ok:true,data:...}` o `{ok:false,error,request_id}`. `/health` tiene estado en el nivel superior. Primero exigir HTTP 200 y `schema:"ready"`; la versión publicada antigua no cumple este contrato. No simular éxito si falla un servicio.

Enviar `Authorization: Bearer <access_token Supabase>` en cada consulta. `/auth/me` comprueba la sesión y devuelve `{id,role,company_id}`. `app_metadata` es la autoridad, no el email, el nombre ni `user_metadata`. Ante 401 volver al acceso. Manejar 403, 409 y 503 sin mostrar credenciales. CORS debe contener el origen exacto del panel.

| Acción | Ruta | Acceso |
| --- | --- | --- |
| Estado | GET `/health` | Público, sin detalles privados |
| Diagnóstico | GET `/admin/status?format=json` | Admin; HTML sin format |
| Base | GET `/debug/supabase` | Admin |
| Empresas/dispositivos | GET `/admin/companies`, `/admin/company-devices?company=NOMBRE` | Admin |
| Resumen/estado de máquinas | GET `/device/summary`, `/device/live-status` | Admin |
| Crear/editar/asignar | POST `/admin/create-devices-batch`, `/admin/update-device-config`, `/admin/upsert-company`, `/admin/assign-device`, `/admin/unassign-device` | Admin, JSON; mismos nombres de parámetros del servidor anterior |
| Mi empresa/máquinas | GET `/client/company`, `/client/devices` | Cliente, empresa determinada por sesión |
| Mis abonos/recaudaciones | GET `/client/plan-payments`, `/client/collections` | Cliente; páginas de 100, `offset` |
| Historial admin | GET `/admin/plan-payments` | Admin |
| Pago abono individual | POST `/pay-plan/device/start` | Cliente propietario o admin |
| Pago abono empresa | POST `/pay-plan/company/start` | Cliente de esa empresa o admin |
| Firmware/impresión | GET `/admin/firmware?device=PS-000044`, `/admin/print-qr?device=PS-000044` | Admin; descargar con fetch autenticado/blob |
| Incidencias | GET `/admin/delivery-incidents`, `/admin/payment-anomalies` | Admin |
| Reconciliar pago | POST `/admin/reconcile-payment`, `{payment_id:"1234"}` | Admin; consulta MP, nunca inventa aprobación |
| Página QR | GET `/pay/PS-000044` | Público; comprueba disponibilidad |
| Comenzar checkout | GET `/pay/start/PS-000044?json=1` | Público; puede quedar bloqueado |
| Simuladores | POST `/test/qr-approved`, `/test/plan-approved` | Admin, solo ambiente de pruebas habilitado |

Abono individual: `{device:"PS-000044",plan:"monthly",json:"1"}`. Empresa: `{company:"Nombre",plan:"six_months",json:"1"}`. La respuesta trae `checkout_url`, `amount` y `order_id`; abrir solo la URL devuelta. El retorno de MP no activa planes ni acredita coins: refrescar desde backend.

Los códigos aceptan `44`, `000044`, `ps-44`, `ps 44` y se convierten a `PS-000044`. El precio efectivo lo calcula y congela el servidor. Nunca confiar en importes del navegador.

El cliente no dispone todavía de endpoint para reclamar propiedad por código, modificar equipo o registrar recaudación manual. Deshabilitar esas acciones y remitir al administrador; no dar la API_KEY al cliente como atajo. Alta segura por código necesita además un secreto de vinculación de un uso, no un código secuencial predecible.

La vía administrativa alternativa es cabecera `x-api-key`. Se conserva `/admin/status?key=...` por compatibilidad solicitada, solo para esa pantalla, con cookie segura de 10 minutos. Preferir cabecera: una URL puede quedar en historial/logs. Nunca guardar la API_KEY en un frontend público, enlaces de QR ni capturas.

Cada archivo de firmware contiene el token de **ese equipo** y su contraseña de configuración. Tratarlo como secreto, entregar solo al instalador y no commitearlo. Portal normal: WiFi y diagnóstico sin mostrar token. Modo técnico: usuario `tecnico`, contraseña individual mostrada al administrador; exige acceso desde el AP local. Ensayo de relé protegido con autenticación y botón CONFIG físico; no habilitarlo en el panel público. Ver INSTALACION-DISPOSITIVO.md.

El estado administrativo agrega `metrics.online_devices`, `recent_boards` (máximo 100), `latest_qr_payments`, `latest_plan_payments`, `recent_device_errors` y `production_warnings`. Online usa una ventana de 30 segundos; no equivale a `ready` ni `commissioned`. Mostrar esas condiciones por separado. Las advertencias de planes, backup y hardware indican comprobaciones externas pendientes, no resultados consultados automáticamente.
